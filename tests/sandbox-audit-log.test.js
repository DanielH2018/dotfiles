// Regression guard for executable_audit.sh (PostToolUse catch-all inside the sandbox).
// Feeds synthetic tool-call JSON through the ACTUAL hook and asserts each call is
// appended as JSONL, with rotation kicking in once the log exceeds MAX_LINES.
// Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'executable_audit.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-audit-')); dirs.push(d); return d; }

// LOG_FILE is $LOG_DIR/<UTC date>.jsonl — mirror that so tests can find/seed it.
const today = new Date().toISOString().slice(0, 10);

function runHook(logDir, input) {
  return execFileSync('bash', [HOOK], {
    input, encoding: 'utf8', env: { ...process.env, LOG_DIR: logDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function readLines(logDir) {
  const f = path.join(logDir, `${today}.jsonl`);
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
}

test('a single tool call is appended as one JSONL line with expected fields', { skip }, () => {
  const dir = scratch();
  runHook(dir, JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls -la' } }));
  const lines = readLines(dir);
  assert.strictEqual(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.strictEqual(row.session, 's1');
  assert.strictEqual(row.tool, 'Bash');
  assert.strictEqual(row.cmd, 'ls -la');
  assert.strictEqual(row.file, null);
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('two calls append two lines', { skip }, () => {
  const dir = scratch();
  runHook(dir, JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/a.py' } }));
  runHook(dir, JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/tmp/b.py' } }));
  const lines = readLines(dir);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[0]).file, '/tmp/a.py');
  assert.strictEqual(JSON.parse(lines[1]).file, '/tmp/b.py');
});

test('exceeding MAX_LINES rotates the log down to KEEP_LINES, keeping the newest entries', { skip }, () => {
  // MAX_LINES=5000/KEEP_LINES=3000 are hardcoded in the script, not env-overridable —
  // pre-seed past the threshold rather than shrinking the knobs.
  const dir = scratch();
  const logFile = path.join(dir, `${today}.jsonl`);
  const seed = Array.from({ length: 5001 }, (_, i) => `seed-${i}`).join('\n') + '\n';
  fs.writeFileSync(logFile, seed);
  runHook(dir, JSON.stringify({ session_id: 'sN', tool_name: 'Bash', tool_input: { command: 'newest' } }));
  const lines = readLines(dir);
  assert.strictEqual(lines.length, 3000);
  assert.strictEqual(lines[0], 'seed-2002', 'oldest retained entry after trim');
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).cmd, 'newest', 'newest entry survives rotation');
});

test('malformed stdin does not crash and writes no corrupt line', { skip }, () => {
  const dir = scratch();
  runHook(dir, 'not json');
  const lines = readLines(dir);
  assert.strictEqual(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]), 'the written line must still be valid JSON');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
