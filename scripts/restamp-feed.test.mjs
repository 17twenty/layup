/**
 * Real, end-to-end proof of restamp-feed.mjs: run it as the CLI it is
 * (`make release` shells out to it), against real files in a real temp
 * directory, and assert what it wrote and how it exits.
 *
 * This script sits in the critical path of every future auto-update:
 * electron-builder writes latest-mac.yml *before* notarize-dmg.sh re-signs
 * the DMG, so without this the manifest carries a stale hash and the next
 * update fails electron-updater's integrity check - which a user experiences
 * as "nothing happens" (see the module doc in restamp-feed.mjs). Its first
 * version had a real bug (an entry's rewrite ran past its own indentation and
 * clobbered the top-level sha512 - the one value electron-updater actually
 * checks a download against). Silent failure is the risk that matters most
 * here, so "fails loudly" gets as much coverage as "rewrites correctly".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./restamp-feed.mjs', import.meta.url));

function sha512(buffer) {
  return createHash('sha512').update(buffer).digest('base64');
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'restamp-feed-test-'));
}

/** Runs the real CLI. Never throws: the exit code is the point. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A realistic post-electron-builder manifest: a zip entry, a dmg entry, and
 *  a top-level path/sha512 pointing at the zip (what Squirrel.Mac fetches). */
function writeManifest(dir, { staleZip = 'STALEZIPHASH==', staleDmg = 'STALEDMGHASH==', staleTop = 'STALETOPHASH==' } = {}) {
  const manifest = [
    'version: 0.2.1',
    'files:',
    '  - url: Layup-0.2.1-universal-mac.zip',
    `    sha512: ${staleZip}`,
    '    size: 1',
    '  - url: Layup-0.2.1-universal.dmg',
    `    sha512: ${staleDmg}`,
    '    size: 2',
    'path: Layup-0.2.1-universal-mac.zip',
    `sha512: ${staleTop}`,
    "releaseDate: '2026-08-17T00:00:00.000Z'",
    '',
  ].join('\n');
  const manifestPath = join(dir, 'latest-mac.yml');
  writeFileSync(manifestPath, manifest);
  return manifestPath;
}

test('rewrites both the per-file sha512/size and the top-level path sha512', () => {
  const dir = tempDir();
  const zip = Buffer.from('the zip bytes, unchanged by notarising');
  const dmg = Buffer.from('the dmg bytes, rewritten by notarize-dmg.sh');
  writeFileSync(join(dir, 'Layup-0.2.1-universal-mac.zip'), zip);
  writeFileSync(join(dir, 'Layup-0.2.1-universal.dmg'), dmg);
  const manifestPath = writeManifest(dir);

  const result = run([manifestPath]);
  assert.equal(result.status, 0, result.stderr);

  const after = readFileSync(manifestPath, 'utf8');
  const zipDigest = sha512(zip);
  const dmgDigest = sha512(dmg);

  // The zip entry.
  assert.match(after, new RegExp(`url: Layup-0\\.2\\.1-universal-mac\\.zip\\n\\s*sha512: ${escapeRe(zipDigest)}\\n\\s*size: ${zip.length}`));
  // The dmg entry - a second `files:` entry, proving the loop restamps every
  // entry, not just the first.
  assert.match(after, new RegExp(`url: Layup-0\\.2\\.1-universal\\.dmg\\n\\s*sha512: ${escapeRe(dmgDigest)}\\n\\s*size: ${dmg.length}`));
  // The top-level sha512, which is what electron-updater actually checks a
  // download against, and which `path:` says is the zip's.
  assert.match(after, new RegExp(`^sha512: ${escapeRe(zipDigest)}$`, 'm'));
  // The two are unrelated: rewriting the dmg entry must never leak into the
  // top-level value, which is exactly the bug the module doc describes.
  assert.notEqual(zipDigest, dmgDigest);
});

test('leaves fields outside the entries and the top sha512 untouched', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'Layup-0.2.1-universal-mac.zip'), Buffer.from('zip'));
  writeFileSync(join(dir, 'Layup-0.2.1-universal.dmg'), Buffer.from('dmg'));
  const manifestPath = writeManifest(dir);

  const result = run([manifestPath]);
  assert.equal(result.status, 0, result.stderr);

  const after = readFileSync(manifestPath, 'utf8');
  assert.match(after, /^version: 0\.2\.1$/m);
  assert.match(after, /^path: Layup-0\.2\.1-universal-mac\.zip$/m);
  assert.match(after, /^releaseDate: '2026-08-17T00:00:00\.000Z'$/m);
});

test('is idempotent: running it again on its own output changes nothing', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'Layup-0.2.1-universal-mac.zip'), Buffer.from('zip'));
  writeFileSync(join(dir, 'Layup-0.2.1-universal.dmg'), Buffer.from('dmg'));
  const manifestPath = writeManifest(dir);

  run([manifestPath]);
  const once = readFileSync(manifestPath, 'utf8');
  const second = run([manifestPath]);
  const twice = readFileSync(manifestPath, 'utf8');

  assert.equal(second.status, 0, second.stderr);
  assert.equal(once, twice);
  assert.match(second.stdout, /already matches the artifacts on disk/);
});

test('fails loudly, without touching the file, when no manifest exists at the given path', () => {
  const dir = tempDir();
  const manifestPath = join(dir, 'does-not-exist.yml');

  const result = run([manifestPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no such manifest/);
});

test('fails loudly rather than silently, when a file: entry names an artifact that is not on disk', () => {
  const dir = tempDir();
  // Only the zip is really there - as if the dmg build step failed midway.
  writeFileSync(join(dir, 'Layup-0.2.1-universal-mac.zip'), Buffer.from('zip'));
  const manifestPath = writeManifest(dir);
  const before = readFileSync(manifestPath, 'utf8');

  const result = run([manifestPath]);

  assert.notEqual(result.status, 0, 'a missing referenced artifact must fail the build, not just print a warning');
  assert.match(result.stderr, /Layup-0\.2\.1-universal\.dmg.*not found/);
  // Refuses to write a manifest that only partially reflects what it checked.
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('fails loudly rather than silently, when the file path: names is not on disk', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'Layup-0.2.1-universal.dmg'), Buffer.from('dmg'));
  // The zip - what path: names, and what Squirrel.Mac actually fetches - is
  // missing.
  const manifestPath = writeManifest(dir);
  const before = readFileSync(manifestPath, 'utf8');

  const result = run([manifestPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Layup-0\.2\.1-universal-mac\.zip.*not found/);
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('fails loudly on malformed YAML: no top-level path: line at all', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'Layup-0.2.1-universal-mac.zip'), Buffer.from('zip'));
  const manifestPath = join(dir, 'latest-mac.yml');
  writeFileSync(
    manifestPath,
    ['version: 0.2.1', 'files:', '  - url: Layup-0.2.1-universal-mac.zip', '    sha512: STALE==', '    size: 1', ''].join(
      '\n',
    ),
  );
  const before = readFileSync(manifestPath, 'utf8');

  const result = run([manifestPath]);

  assert.notEqual(result.status, 0, 'a manifest with no path: line must not be reported as fine');
  assert.match(result.stderr, /path:/);
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('fails loudly on malformed YAML: a path: line but no top-level sha512: line', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'Layup-0.2.1-universal-mac.zip'), Buffer.from('zip'));
  const manifestPath = join(dir, 'latest-mac.yml');
  writeFileSync(manifestPath, ['version: 0.2.1', 'path: Layup-0.2.1-universal-mac.zip', ''].join('\n'));
  const before = readFileSync(manifestPath, 'utf8');

  const result = run([manifestPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sha512:/);
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\/=]/g, '\\$&');
}
