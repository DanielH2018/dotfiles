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

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox', 'executable_audit.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-audit-')); dirs.push(d); return d; }

// Rotation thresholds for this test's own runs. The hook ships 5000/3000; driving them down
// here is what lets the rotation case seed a handful of lines instead of 5001, and keeps the
// expected counts small enough to read rather than arithmetic to take on trust.
const MAX_LINES = 10;
const KEEP_LINES = 6;
// Passed only by the rotation case — the append cases must see the shipped defaults.
const rotationEnv = { AUDIT_MAX_LINES: String(MAX_LINES), AUDIT_KEEP_LINES: String(KEEP_LINES) };

function runHook(logDir, input, extraEnv = {}) {
  return execFileSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, LOG_DIR: logDir, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
// LOG_FILE is $LOG_DIR/<UTC date>.jsonl. Discover the name the hook actually used
// rather than recomputing the date here: a locally captured date and the hook's
// own stamp disagree when the run straddles UTC midnight, which made every
// assertion below fail once, unreproducibly, at 23:59:59.
function logPath(logDir) {
  const files = fs.readdirSync(logDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  assert.strictEqual(files.length, 1, `expected exactly one dated log in ${logDir}, got: ${files.join(', ')}`);
  return path.join(logDir, files[0]);
}
function readLines(logDir) {
  return fs.readFileSync(logPath(logDir), 'utf8').split('\n').filter(Boolean);
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
  const dir = scratch();
  // One throwaway call so the hook names the log file; then seed that exact file,
  // so the seed and the append below can't land on two different dates.
  runHook(dir, JSON.stringify({ session_id: 's0', tool_name: 'Bash', tool_input: { command: 'discard' } }), rotationEnv);
  const seed = Array.from({ length: MAX_LINES + 1 }, (_, i) => `seed-${i}`).join('\n') + '\n';
  fs.writeFileSync(logPath(dir), seed);
  runHook(dir, JSON.stringify({ session_id: 'sN', tool_name: 'Bash', tool_input: { command: 'newest' } }), rotationEnv);
  const lines = readLines(dir);
  assert.strictEqual(lines.length, KEEP_LINES);
  // 11 seeded plus 1 appended, trimmed to the last 6: seed-6 is the oldest survivor. Written
  // out rather than computed from MAX_LINES/KEEP_LINES — an off-by-one in the script's own
  // trim is exactly what this catches, and a shared formula would drift right along with it.
  assert.strictEqual(lines[0], 'seed-6', 'oldest retained entry after trim');
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
