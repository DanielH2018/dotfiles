// Regression guard for executable_lint-after-edit.sh (PostToolUse Edit|Write).
// Feeds synthetic hook JSON through the ACTUAL hook and asserts lint failures
// surface as a block decision while clean/unsupported files are no-ops.
// Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_lint-after-edit.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

let shellcheckOk = true;
try { execFileSync('bash', ['-c', 'command -v shellcheck'], { stdio: 'ignore' }); } catch { shellcheckOk = false; }
const skipLintCase = toolsOk && shellcheckOk ? false : 'no supported linter installed';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-after-edit-')); dirs.push(d); return d; }

function runHook(input) {
  try {
    return execFileSync('bash', [HOOK], {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { return e.stdout || ''; }
}
function decision(stdout) {
  if (!stdout.trim()) return null;
  try { return JSON.parse(stdout).decision; } catch { return null; }
}

test('clean shell script: exit 0, no block decision', { skip: skipLintCase }, () => {
  const dir = scratch();
  const f = path.join(dir, 'clean.sh');
  fs.writeFileSync(f, '#!/bin/bash\nset -euo pipefail\nfoo="$1"\necho "$foo"\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), null);
});

test('shell script with a lint violation: block decision surfaces the output', { skip: skipLintCase }, () => {
  const dir = scratch();
  const f = path.join(dir, 'bad.sh');
  fs.writeFileSync(f, '#!/bin/bash\nfoo=$1\necho $foo\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), 'block');
  assert.match(out, /SC2086/);
});

test('unsupported file type is a no-op', { skip }, () => {
  const dir = scratch();
  const f = path.join(dir, 'notes.txt');
  fs.writeFileSync(f, 'just some text\n');
  const out = runHook(JSON.stringify({ tool_input: { file_path: f } }));
  assert.strictEqual(decision(out), null);
});

test('malformed stdin JSON does not crash', { skip }, () => {
  const out = runHook('not json');
  assert.strictEqual(decision(out), null);
});

test('empty stdin does not crash', { skip }, () => {
  const out = runHook('');
  assert.strictEqual(decision(out), null);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
