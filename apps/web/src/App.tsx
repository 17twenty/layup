/**
 * The web guest client's root component.
 *
 * A placeholder today: Task 8 adds the join screen, Task 9 adds the call
 * itself. This task's job is the workspace and the alias to `core/` - the
 * unprivileged half of the desktop app already separated for exactly this
 * reuse (the web-guests design doc §7).
 */
import { createSession } from '@core/session';

// Referenced here, not just from a test: this is what makes `@core` part of
// the module graph `vite build` actually walks, so a Node or Electron import
// smuggled into `core/` fails *this* production build, not only a type check
// that a hoisted `@types/node` elsewhere in the workspace can quietly
// satisfy. Task 8 gives `createSession` a real caller; until then, this line
// is the proof.
console.info('layup web: core loaded', typeof createSession);

export function App() {
  return (
    <main>
      <h1>Layup</h1>
      <p>A link to a call, in a browser.</p>
    </main>
  );
}
