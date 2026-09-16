// The 2026-09-16 always-on design drops the per-launch secret entirely (see
// docs/specs/2026-09-16-pr-dash-always-on-design.md, "Dropping the per-launch secret"):
// checkHost is the whole request boundary now, and nothing backstops it. If either half of
// the removed plumbing crept back in — a route reading PR_DASH_SECRET again, or the client
// sending the header again — no other test would fail: there is no route left that rejects
// an unexpected credential, so the app would simply start accepting one nobody asked it to.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './strip-comments.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

test('no file under src/ reads PR_DASH_SECRET', () => {
  for (const file of listFiles(path.join(ROOT, 'src'), '.ts')) {
    const stripped = stripComments(readFileSync(file, 'utf8'));
    assert.doesNotMatch(
      stripped,
      /PR_DASH_SECRET/,
      `expected no reference to PR_DASH_SECRET in ${path.relative(ROOT, file)}`,
    );
  }
});

test('no file under public/ sends the x-pr-dash-secret header', () => {
  for (const file of listFiles(path.join(ROOT, 'public'), '.js')) {
    const stripped = stripComments(readFileSync(file, 'utf8'));
    assert.doesNotMatch(
      stripped,
      /x-pr-dash-secret/i,
      `expected no x-pr-dash-secret header in ${path.relative(ROOT, file)}`,
    );
  }
});
