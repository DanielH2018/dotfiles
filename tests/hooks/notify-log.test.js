// executable_notify-log.sh — the temporary Notification diagnostic.
//
// notify.sh is gated on permission_prompt and that gate is real, so an audible cue arriving
// when nothing is blocked has a source we have not identified. This hook logs every
// notification with its type so the next one can be traced. A diagnostic that silently
// writes nothing is worse than none, which is what these tests are for. Delete this file
// along with the hook once the log has caught a spurious cue.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS_SRC = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const HOOK = path.join(HOOKS_SRC, 'executable_notify-log.sh');
const INPUT_LIB = path.join(HOOKS_SRC, 'hook-input.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const homes = [];
function freshHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-log-'));
  homes.push(h);
  fs.mkdirSync(path.join(h, '.claude', 'hooks'), { recursive: true });
  fs.copyFileSync(INPUT_LIB, path.join(h, '.claude', 'hooks', 'hook-input.sh'));
  return h;
}
function run(payload, home) {
  execFileSync('bash', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, HOOK_INPUT_LIB: path.join(home, '.claude', 'hooks', 'hook-input.sh') },
  });
}
const logPath = (h) => path.join(h, '.claude', 'logs', 'notify-debug.jsonl');
const lines = (h) => fs.readFileSync(logPath(h), 'utf8').trim().split('\n');

test('a notification is logged with its type', { skip }, () => {
  const home = freshHome();
  run({ notification_type: 'permission_prompt', session_id: 'x1', title: 'T', message: 'M' }, home);
  const rec = JSON.parse(lines(home)[0]);
  assert.strictEqual(rec.type, 'permission_prompt');
  assert.strictEqual(rec.sid, 'x1');
  assert.strictEqual(rec.msg, 'M');
  assert.ok(rec.ts, 'a timestamp is recorded');
});

// jq -r would pretty-print a bare object across several lines and break the jsonl, so the
// filter ends in `tojson`. One record must be exactly one line.
test('each record is a single line, appended not overwritten', { skip }, () => {
  const home = freshHome();
  run({ notification_type: 'permission_prompt', session_id: 'a' }, home);
  run({ notification_type: 'idle_prompt', session_id: 'b' }, home);
  const l = lines(home);
  assert.strictEqual(l.length, 2, 'two notifications, two lines');
  assert.deepStrictEqual(l.map((x) => JSON.parse(x).type), ['permission_prompt', 'idle_prompt']);
});

test('a multiline message does not break the jsonl', { skip }, () => {
  const home = freshHome();
  run({ notification_type: 'permission_prompt', message: 'line one\nline two' }, home);
  const l = lines(home);
  assert.strictEqual(l.length, 1, 'an embedded newline stays escaped inside the record');
  assert.strictEqual(JSON.parse(l[0]).msg, 'line one\nline two');
});

test('an unknown type is recorded rather than dropped', { skip }, () => {
  const home = freshHome();
  run({ session_id: 'z' }, home);
  assert.strictEqual(JSON.parse(lines(home)[0]).type, '?',
    'a payload with no notification_type is exactly what this hook exists to catch');
});

test('the log is trimmed rather than growing without bound', { skip }, () => {
  const home = freshHome();
  fs.mkdirSync(path.dirname(logPath(home)), { recursive: true });
  fs.writeFileSync(logPath(home), `${'{"pad":"x"}\n'.repeat(100000)}`);  // > 1 MB
  run({ notification_type: 'permission_prompt', session_id: 'trim' }, home);
  const l = lines(home);
  assert.ok(l.length <= 501, `log trimmed to the tail, got ${l.length} lines`);
  assert.strictEqual(JSON.parse(l[l.length - 1]).sid, 'trim', 'the new record survives the trim');
});

process.on('exit', () => {
  for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* temp */ } }
});
