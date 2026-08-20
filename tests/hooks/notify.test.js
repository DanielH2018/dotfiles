// Regression guard for executable_notify.sh, specifically the idle_prompt gate.
//
// Drives the ACTUAL hook against a fake $HOME whose play-sound.sh is a stub, so the assertion
// is "did the cue fire", not "did a sound come out". Offline and deterministic.
//
// The property under test is not a case list. idle_prompt means opposite things depending on
// who raised it: a background job saying "waiting for your input" is asking you a question and
// owns no pane to show it in, while a foreground session raises the same type 60s after every
// finished turn. Chiming on both is the noise that got idle_prompt excluded outright; chiming
// on neither is what left background jobs silent. The gate is the jobs directory.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const HOOK = path.join(HOOKS, 'executable_notify.sh');
const LIB = path.join(HOOKS, 'hook-input.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];

// A fake $HOME with a stubbed play-sound.sh. `job` creates the jobs directory that marks the
// notifying session as a background job, which is exactly what the gate looks for.
function run({ type, sid, job }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  dirs.push(home);
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const played = path.join(home, 'played.log');
  fs.writeFileSync(path.join(hooks, 'play-sound.sh'),
    `#!/bin/sh\necho "play $*" >> "${played}"\n`, { mode: 0o755 });
  if (job) fs.mkdirSync(path.join(home, '.claude', 'jobs', sid.split('-')[0]), { recursive: true });
  try {
    execFileSync('bash', [HOOK], {
      input: JSON.stringify({ notification_type: type, session_id: sid, message: 'm', title: 't' }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // PATH keeps jq reachable but the hook resolves play-sound.sh through $HOME, so the
      // stub above is the one it runs.
      env: { ...process.env, HOME: home, HOOK_INPUT_LIB: LIB },
    });
  } catch { /* a non-zero exit is itself a failure the assertions below will show */ }
  return fs.existsSync(played) ? fs.readFileSync(played, 'utf8') : '';
}

test('a background job going idle makes a sound', { skip }, () => {
  const played = run({ type: 'idle_prompt', sid: '664f7ae8-1fde-4339-b7d3-4441f18687a1', job: true });
  assert.match(played, /^play /m, 'the job asking for input is the case the cue exists for');
});

test('a foreground session going idle stays silent', { skip }, () => {
  const played = run({ type: 'idle_prompt', sid: '7e1ec437-5939-48b5-9dcd-e97c32f9242b', job: false });
  assert.strictEqual(played, '', 'a cue 60s after every finished turn is the noise, not the signal');
});

// The gate is scoped to idle_prompt alone: the other two types mean "blocked on you" whoever
// raised them, so a missing jobs directory must not silence them.
test('permission_prompt and agent_needs_input are not gated on the jobs directory', { skip }, () => {
  for (const type of ['permission_prompt', 'agent_needs_input']) {
    const played = run({ type, sid: '7e1ec437-5939-48b5-9dcd-e97c32f9242b', job: false });
    assert.match(played, /^play /m, `${type} must sound from a session that is not a job`);
  }
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
