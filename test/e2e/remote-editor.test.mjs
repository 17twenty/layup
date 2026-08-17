/**
 * A remote participant using an ordinary editor, end to end (SPEC.md §13.3).
 *
 *   node --test test/e2e/remote-editor.test.mjs
 *
 * Two halves, and it is worth being precise about which is which.
 *
 * **Everything this project owns is real here.** The guest's sender, the wire
 * messages, the presenter's guard, the pointer and keyboard leases and the
 * injection router are the actual modules the application runs - imported, not
 * reimplemented. A test that reimplements what it is testing proves only that
 * the test agrees with itself.
 *
 * **The editor is a model.** It is a small text buffer that responds to the
 * exact command stream the router emits: a click puts the caret where it was
 * aimed, a drag selects, keys type, a wheel scrolls, and Cmd+A selects all. It
 * stands in for a real application because driving a real editor needs OS input
 * injection, which needs an Accessibility grant that no unattended runner has.
 *
 * The second test closes that last gap as far as this machine allows: the same
 * command stream is sent to the **real helper binary** over a real socket, with
 * real authentication, and the helper's answer is recorded - injected where the
 * platform permits it, and an actionable "permission missing" where it does not.
 * What remains owed to a human is one pass on a machine with the grant, driving
 * a real editor. That is written down in STATUS.md rather than glossed over.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { installTsHook } = await import(join(repoRoot, 'scripts', 'node-ts-hook.mjs'));
installTsHook();

const { createInputGuard } = await import(join(repoRoot, 'apps/desktop/src/core/input-guard.ts'));
const { createInputLeases } = await import(join(repoRoot, 'apps/desktop/src/core/input-lease.ts'));
const { createInputSender } = await import(join(repoRoot, 'apps/desktop/src/core/input-sender.ts'));
const { createRemoteControl } = await import(join(repoRoot, 'apps/desktop/src/core/remote-control.ts'));
const { CHANNEL_INPUT } = await import(join(repoRoot, 'apps/desktop/src/core/data-channels.ts'));
const { createRemoteInputRouter } = await import(join(repoRoot, 'apps/desktop/src/main/remote-input.ts'));
const { createEmergencyRevoke } = await import(join(repoRoot, 'apps/desktop/src/main/emergency-revoke.ts'));
const { createLogger } = await import(join(repoRoot, 'apps/desktop/src/main/logging.ts'));

const PRESENTER = 'mem_presenter';
const GUEST = 'mem_guest';
const DISPLAY = 'display-1';
const SCREEN = { displayId: DISPLAY, x: 0, y: 0, width: 1000, height: 500 };
const log = createLogger({ level: 'error', write: () => {} });

/**
 * A text editor, as far as injected input can tell.
 *
 * Coordinates are pixels because that is what reaches an application: 10px per
 * column, 20px per line. It only implements what the acceptance criteria name -
 * caret, selection, typing, scrolling and one shortcut.
 */
function createEditor(lines) {
  const state = {
    lines: [...lines],
    caret: { line: 0, column: 0 },
    selection: undefined,
    scrollTop: 0,
    pointer: { x: 0, y: 0 },
    down: false,
    modifiers: new Set(),
  };

  const at = (point) => ({
    line: Math.min(state.lines.length - 1, Math.max(0, Math.floor((point.y + state.scrollTop) / 20))),
    column: Math.max(0, Math.floor(point.x / 10)),
  });

  return {
    state,
    /** The HelperClient shape, so the real router can drive it. */
    connect: async () => {},
    capabilities: async () => ({ platform: 'model', pointerMove: true, keyboard: true }),
    close: () => {},
    connected: () => true,
    async send(command, payload) {
      switch (command) {
        case 'pointer.move': {
          state.pointer = payload;
          if (state.down) {
            // Dragging extends the selection from where the press started.
            state.selection = { from: state.selection?.from ?? state.caret, to: at(payload) };
            state.caret = at(payload);
          }
          return { ok: true };
        }
        case 'pointer.button': {
          if (payload.down) {
            state.down = true;
            state.caret = at(state.pointer);
            state.selection = undefined;
          } else {
            state.down = false;
          }
          return { ok: true };
        }
        case 'pointer.wheel': {
          // Positive deltaY scrolls towards the top of the document.
          state.scrollTop = Math.max(0, state.scrollTop - payload.deltaY * 20);
          return { ok: true };
        }
        case 'key': {
          typeKey(state, payload);
          return { ok: true };
        }
        default:
          return { ok: true };
      }
    },
    text: () => state.lines.join('\n'),
    selectedText() {
      if (!state.selection) return '';
      const { from, to } = state.selection;
      if (from.line !== to.line) return state.lines.slice(from.line, to.line + 1).join('\n');
      const [start, end] = [from.column, to.column].sort((a, b) => a - b);
      return state.lines[from.line].slice(start, end);
    },
  };
}

const PRINTABLE = { Space: ' ', Minus: '-', Period: '.', Comma: ',', Slash: '/' };

function typeKey(state, { code, down }) {
  if (!down) {
    state.modifiers.delete(code);
    return;
  }
  if (code.startsWith('Shift') || code.startsWith('Meta') || code.startsWith('Control') || code.startsWith('Alt')) {
    state.modifiers.add(code);
    return;
  }

  const commanding = [...state.modifiers].some((modifier) => modifier.startsWith('Meta'));
  if (commanding && code === 'KeyA') {
    state.selection = {
      from: { line: 0, column: 0 },
      to: { line: state.lines.length - 1, column: state.lines.at(-1).length },
    };
    return;
  }
  if (commanding) return; // Any other shortcut does nothing in this model.

  const line = state.lines[state.caret.line];
  const character = code.startsWith('Key')
    ? state.modifiers.has('ShiftLeft') || state.modifiers.has('ShiftRight')
      ? code.slice(3)
      : code.slice(3).toLowerCase()
    : code.startsWith('Digit')
      ? code.slice(5)
      : (PRINTABLE[code] ?? '');

  if (code === 'Backspace') {
    state.lines[state.caret.line] = line.slice(0, Math.max(0, state.caret.column - 1)) + line.slice(state.caret.column);
    state.caret = { ...state.caret, column: Math.max(0, state.caret.column - 1) };
    return;
  }
  if (character === '') return;

  state.lines[state.caret.line] = line.slice(0, state.caret.column) + character + line.slice(state.caret.column);
  state.caret = { ...state.caret, column: state.caret.column + character.length };
}

/** Wires up one presenter and one guest, exactly as the application does. */
function createSession(editor) {
  let clock = 1_000;
  let control;
  const guard = createInputGuard({
    localMembershipId: PRESENTER,
    isPresenting: () => true,
    sharedDisplayId: () => DISPLAY,
    presenterMembershipId: () => PRESENTER,
    allowsScope: (scope) => control.isAllowed(scope),
  });

  const outbox = [];
  control = createRemoteControl({
    membershipId: PRESENTER,
    guard,
    broadcast: (message) => outbox.push(message),
    isPresenting: () => true,
  });

  const router = createRemoteInputRouter({
    guard,
    helper: () => editor,
    displays: () => [SCREEN],
    log,
    leases: createInputLeases({ idleTimeoutMs: 30_000, now: () => clock }),
    now: () => clock,
  });

  const wire = [];
  const sender = createInputSender({
    membershipId: GUEST,
    send: (message) => {
      // Over the wire and back: JSON, exactly as the data channel carries it.
      wire.push(JSON.parse(JSON.stringify(message)));
      return true;
    },
  });

  async function flush() {
    const results = [];
    while (wire.length > 0) {
      const message = wire.shift();
      results.push(await router.handle(message, { membershipId: GUEST, channel: CHANNEL_INPUT }));
    }
    return results;
  }

  function deliverControl() {
    while (outbox.length > 0) sender.applyControl(outbox.shift());
  }

  return {
    guard,
    control,
    router,
    sender,
    flush,
    deliverControl,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('a remote participant can use an ordinary editor', async () => {
  const editor = createEditor(['const total = 0;', 'return total;', '', 'done']);
  const session = createSession(editor);

  // Two switches, and the room can use them: no per-person grants.
  session.control.setAllowed('pointer', true);
  session.control.setAllowed('keyboard', true);
  session.deliverControl();
  assert.deepEqual(session.sender.scopes(), ['pointer', 'keyboard']);

  // Click into the editor: line 1 (y 0.05 of 500px = 25px), column 6.
  session.sender.pointerDown({ displayId: DISPLAY, x: 0.065, y: 0.05, button: 'left' });
  session.sender.pointerUp({ displayId: DISPLAY, x: 0.065, y: 0.05, button: 'left' });
  let results = await session.flush();
  assert.ok(
    results.every((result) => result.injected),
    'the click should have been injected',
  );
  assert.deepEqual(editor.state.caret, { line: 1, column: 6 });

  // Type. Only key codes travel; the editor decides what character that is.
  for (const code of ['Space', 'KeyO', 'KeyK']) {
    session.sender.keyDown(code);
    session.sender.keyUp(code);
  }
  await session.flush();
  assert.equal(editor.state.lines[1], 'return ok total;');

  // Select by dragging across the first line.
  //
  // A drag is a press and a release with coordinates, not a stream of moves:
  // there is no `pointer.move` message, because cursor movement is an overlay
  // that must never move the OS pointer (SPEC.md §8.1). The presenter's side
  // positions the pointer before each action, and the platform layer posts that
  // as a drag event while a button is held.
  session.sender.pointerDown({ displayId: DISPLAY, x: 0.0, y: 0.01, button: 'left' });
  session.sender.pointerUp({ displayId: DISPLAY, x: 0.05, y: 0.01, button: 'left' });
  await session.flush();
  assert.equal(editor.selectedText(), 'const');

  // Scroll.
  session.sender.pointerWheel({ displayId: DISPLAY, x: 0.5, y: 0.5, deltaX: 0, deltaY: -3 });
  await session.flush();
  assert.equal(editor.state.scrollTop, 60);

  // A modifier shortcut: Cmd+A.
  session.sender.keyDown('MetaLeft');
  session.sender.keyDown('KeyA');
  session.sender.keyUp('KeyA');
  session.sender.keyUp('MetaLeft');
  await session.flush();
  assert.equal(editor.selectedText(), ['const total = 0;', 'return ok total;', '', 'done'].join('\n'));

  // The presenter stops everything.
  const emergency = createEmergencyRevoke({
    control: session.control,
    router: session.router,
    holders: () => [GUEST],
    log,
  });
  const stopped = await emergency.trigger('button');
  assert.equal(stopped.revoked, 2);

  const before = editor.text();
  session.deliverControl();
  // The guest tries to carry on typing. Its own sender has stopped, and the
  // presenter's guard refuses anything that was already in flight.
  session.sender.keyDown('KeyZ');
  session.sender.keyUp('KeyZ');
  results = await session.flush();
  assert.ok(
    results.every((result) => !result.injected),
    'nothing should be injected after the revoke',
  );
  assert.equal(editor.text(), before, 'the editor must not change after the revoke');
  assert.deepEqual(session.sender.scopes(), []);
});

// The same commands, against the real helper binary over a real socket.
let helper;
let helperDir;
let socketPath;
const secret = randomBytes(32).toString('hex');

before(() => {
  helperDir = mkdtempSync(join(tmpdir(), 'layup-editor-'));
  socketPath = join(helperDir, 'helper.sock');
  const binary = join(helperDir, 'layup-input-helper');
  execFileSync('go', ['build', '-o', binary, './cmd/layup-input-helper'], {
    cwd: join(repoRoot, 'native', 'input-helper'),
    stdio: 'inherit',
  });
  helper = spawn(binary, [], {
    env: { ...process.env, LAYUP_HELPER_SECRET: secret, LAYUP_HELPER_SOCKET: socketPath },
    stdio: 'ignore',
  });
});

after(() => helper?.kill('SIGTERM'));

function sign(id, command) {
  return createHmac('sha256', secret).update(`1\n${id}\n${command}`).digest('hex');
}

async function ask(command, payload) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect(socketPath, () => {
          const id = `e2e-${command}-${attempt}`;
          socket.write(`${JSON.stringify({ v: 1, id, command, auth: sign(id, command), payload })}\n`);
        });
        socket.setEncoding('utf8');
        socket.on('error', reject);
        socket.on('data', (chunk) => {
          resolve(JSON.parse(chunk.trim().split('\n')[0]));
          socket.destroy();
        });
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('the helper never started listening');
}

test('the same editor commands reach the real helper', async () => {
  const capabilities = await ask('helper.capabilities');
  assert.equal(capabilities.ok, true);
  const platform = JSON.parse(Buffer.from(JSON.stringify(capabilities.payload)).toString());

  const commands = [
    ['pointer.move', { x: 120, y: 40 }],
    ['pointer.button', { button: 'left', down: true }],
    ['pointer.button', { button: 'left', down: false }],
    ['pointer.wheel', { deltaX: 0, deltaY: -3 }],
    ['key', { code: 'MetaLeft', down: true }],
    ['key', { code: 'KeyA', down: true }],
    ['key', { code: 'KeyA', down: false }],
    ['key', { code: 'MetaLeft', down: false }],
    ['input.release_all', undefined],
  ];

  const answers = [];
  for (const [command, payload] of commands) {
    answers.push(await ask(command, payload));
  }

  if (platform.pointerMove) {
    // A runner with the OS permission: every command really was injected.
    assert.ok(
      answers.every((answer) => answer.ok),
      `every command should have been injected: ${JSON.stringify(answers)}`,
    );
  } else {
    // Without it, the helper must refuse *and say why* - never pretend.
    const refusals = answers.filter((answer) => !answer.ok);
    assert.ok(refusals.length > 0, 'a helper with no permission must refuse');
    for (const refusal of refusals) {
      assert.equal(refusal.code, 'not_permitted');
    }
    assert.ok(
      typeof platform.detail === 'string' && platform.detail.length > 0,
      'a missing permission needs an actionable explanation',
    );
    console.log(`      note: OS injection unavailable here - ${platform.detail}`);
  }

  // Whatever the permission state, a malformed command is still refused.
  const nonsense = await ask('pointer.button', { button: 'elbow', down: true });
  assert.equal(nonsense.ok, false);
  assert.equal(nonsense.code, 'malformed');
});
