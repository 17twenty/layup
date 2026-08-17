#!/usr/bin/env node
/**
 * Re-stamps latest-mac.yml against the artifacts that actually shipped.
 *
 * electron-builder writes the manifest immediately after building the DMG and
 * the zip. scripts/notarize-dmg.sh then signs, notarises and staples the DMG,
 * which changes both its bytes and its length - so the manifest's DMG entry
 * describes a file nobody will ever download.
 *
 * Squirrel.Mac only ever fetches the file named by `path:` (the zip), so this
 * does not break updating. It publishes a falsehood, which is worse in its own
 * way: the next person to check a download against the manifest has to work out
 * which of the two is lying.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('usage: restamp-feed.mjs <path-to-latest-mac.yml>');
  process.exit(1);
}
if (!existsSync(manifestPath)) {
  console.error(`no such manifest: ${manifestPath}`);
  process.exit(1);
}

const releaseDir = dirname(manifestPath);
const lines = readFileSync(manifestPath, 'utf8').split('\n');
const changes = [];

async function sha512(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

const indentOf = (line) => /^(\s*)/.exec(line)[1].length;

/** Rewrites one `- url:` entry's own sha512 and size. Nothing outside it. */
async function restampEntry(start) {
  const match = /^(\s*)-\s+url:\s*(.+?)\s*$/.exec(lines[start]);
  if (!match) return;
  const url = match[2];
  const file = join(releaseDir, url);
  if (!existsSync(file)) return;

  const digest = await sha512(file);
  const size = statSync(file).size;
  const entryIndent = match[1].length;

  for (let j = start + 1; j < lines.length; j += 1) {
    // An entry owns only the lines indented deeper than its own dash. Reading
    // past that is how the DMG's hash ends up on the zip's line.
    if (lines[j].trim() === '') continue;
    if (indentOf(lines[j]) <= entryIndent) break;

    const sha = /^(\s*sha512:\s*)(.+?)\s*$/.exec(lines[j]);
    if (sha) {
      if (sha[2] !== digest) changes.push(`${url} sha512`);
      lines[j] = `${sha[1]}${digest}`;
      continue;
    }
    const bytes = /^(\s*size:\s*)(\d+)\s*$/.exec(lines[j]);
    if (bytes) {
      if (bytes[2] !== String(size)) changes.push(`${url} size ${bytes[2]} -> ${size}`);
      lines[j] = `${bytes[1]}${size}`;
    }
  }
}

for (let i = 0; i < lines.length; i += 1) {
  if (/^\s*-\s+url:/.test(lines[i])) await restampEntry(i);
}

/**
 * The top-level sha512 belongs to whatever `path:` names, and to nothing else.
 * It is what electron-updater checks the download against, so it is the one
 * value here that can actually stop an update.
 */
const pathLine = lines.find((line) => /^path:\s*/.test(line));
if (pathLine) {
  const url = pathLine.replace(/^path:\s*/, '').trim();
  const file = join(releaseDir, url);
  if (existsSync(file)) {
    const digest = await sha512(file);
    const top = lines.findIndex((line) => /^sha512:\s*/.test(line));
    if (top >= 0) {
      if (lines[top] !== `sha512: ${digest}`) changes.push(`path (${url}) sha512`);
      lines[top] = `sha512: ${digest}`;
    }
  } else {
    console.error(`warning: ${url} named by path: is not in ${releaseDir}`);
  }
}

writeFileSync(manifestPath, lines.join('\n'));
console.log(
  changes.length === 0
    ? `${manifestPath}: already matches the artifacts on disk`
    : `${manifestPath}: re-stamped ${changes.join(', ')}`,
);
