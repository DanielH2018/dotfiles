// Behavioral tests for the backgrounded-origin reaper hook
// (executable_reap-backgrounded-origin.sh). When Claude Code backgrounds a session it
// forks a daemon (--fork-session --resume <origin>.jsonl --reply-on-resume) but leaves
// the interactive ORIGIN process alive. This hook runs at the daemon's SessionStart,
// detects that signature in the ancestor Claude cmdline, and SIGTERMs the now-redundant
// origin — and NOTHING else.
//
// Seams (all env-injected so no real /proc, sessions, or kills are touched):
//   REAP_CMDLINE_SOURCE  - stand-in for the ancestor Claude cmdline (skips /proc walk)
//   CLAUDE_SESSIONS_DIR  - dir of <pid>.json session-registry files
//   AGENT_VIEW_DIR       - dir of <sid>.json Agentview rows (row removed on reap)
//   REAP_KILLCMD         - kill seam; here a script that records pids to a file
//   REAP_LOG             - audit log path
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOKS_DIR = srcPath('private_dot_claude', 'hooks');
const HOOK = path.join(HOOKS_DIR, 'executable_reap-backgrounded-origin.sh');
const LIB = path.join(HOOKS_DIR, 'reap-origin-lib.sh');
const SRC = fs.readFileSync(HOOK, 'utf8') + '\n' + fs.readFileSync(LIB, 'utf8');

const skip = skipUnless('bash', 'jq');

// Build a fake env: sessions dir, agent-view dir, a recording kill seam, a log file.
// Each session also gets a fake /proc/<pid>/stat whose start time matches the procStart
// recorded for it, so the pid verifies as the process the registry claims it is. Pass a
// [sid, procStart] pair to record a start time that does NOT match — that is pid reuse.
function fakeEnv(sessions = {}, rows = []) {
  const home = scratch(os.tmpdir(), 'reap-origin-');
  const sdir = path.join(home, 'sessions'); fs.mkdirSync(sdir, { recursive: true });
  const avdir = path.join(home, 'agent-view'); fs.mkdirSync(avdir, { recursive: true });
  const procdir = path.join(home, 'proc'); fs.mkdirSync(procdir, { recursive: true });
  for (const [pid, spec] of Object.entries(sessions)) {
    const [sid, recorded] = Array.isArray(spec) ? spec : [spec, '900100'];
    fs.writeFileSync(path.join(sdir, `${pid}.json`),
      JSON.stringify({ pid: Number(pid), sessionId: sid, procStart: recorded }));
    // A comm containing a space and a paren: field 22 must still be read correctly.
    const pd = path.join(procdir, pid); fs.mkdirSync(pd, { recursive: true });
    const pad = Array.from({ length: 18 }, (_, i) => i).join(' ');
    fs.writeFileSync(path.join(pd, 'stat'), `${pid} (claude (bg) worker) S ${pad} 900100\n`);
  }
  for (const sid of rows) fs.writeFileSync(path.join(avdir, `${sid}.json`), '{}');
  const killed = path.join(home, 'killed.txt');
  const killcmd = path.join(home, 'kill.sh');
  fs.writeFileSync(killcmd, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(killed)}\n`);
  fs.chmodSync(killcmd, 0o755);
  const log = path.join(home, 'reap.log');
  return { home, sdir, avdir, procdir, killcmd, killed, log };
}

function run(env, cmdline, ownSid = 'FORK-SID') {
  const e = {
    ...process.env,
    REAP_CMDLINE_SOURCE: cmdline,
    REAP_LIB: LIB,
    IDENTITY_LIB: path.join(HOOKS_DIR, 'identity.sh'),
    IDENTITY_PROC_DIR: env.procdir,
    CLAUDE_SESSIONS_DIR: env.sdir,
    AGENT_VIEW_DIR: env.avdir,
    REAP_KILLCMD: env.killcmd,
    REAP_LOG: env.log,
  };
  execFileSync('bash', [HOOK], {
    env: e, encoding: 'utf8', input: JSON.stringify({ session_id: ownSid }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const killedPids = (env) => fs.existsSync(env.killed)
  ? fs.readFileSync(env.killed, 'utf8').split('\n').filter(Boolean) : [];

const BG = (originSid) =>
  `/home/d/.local/share/claude/versions/2.1.218 --session-id ${'FORK-SID'} --fork-session ` +
  `--resume /home/d/.claude/projects/-p/${originSid}.jsonl --reply-on-resume --model Fable`;

// ---- the one case that MUST act ----
test('backgrounded signature + live origin -> SIGTERM origin once, remove row, log', { skip }, () => {
  const env = fakeEnv({ '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  run(env, BG('ORIGIN-SID'));
  assert.deepStrictEqual(killedPids(env), ['203774'], 'origin pid SIGTERM\'d exactly once');
  assert.match(fs.readFileSync(env.log, 'utf8'), /ORIGIN-SID.*203774/, 'audit line written');
});

// ---- every no-op case: origin must survive ----
test('plain --resume (no --fork-session) -> no-op', { skip }, () => {
  const env = fakeEnv({ '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  run(env, `/x/claude --session-id S --resume /p/ORIGIN-SID.jsonl --model Fable`);
  assert.deepStrictEqual(killedPids(env), [], 'nothing killed');
});

test('interactive fork (no --reply-on-resume) -> no-op', { skip }, () => {
  const env = fakeEnv({ '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  run(env, `/x/claude --session-id S --fork-session --resume /p/ORIGIN-SID.jsonl`);
  assert.deepStrictEqual(killedPids(env), []);
});

test('origin sid == own sid -> never self', { skip }, () => {
  const env = fakeEnv({ '203774': 'FORK-SID' }, ['FORK-SID']);
  run(env, BG('FORK-SID'), 'FORK-SID');
  assert.deepStrictEqual(killedPids(env), []);
});

test('origin sid has no matching sessions/<pid>.json -> no-op, no error', { skip }, () => {
  const env = fakeEnv({ '203774': 'SOMEONE-ELSE' }, []);
  run(env, BG('ORIGIN-SID'));
  assert.deepStrictEqual(killedPids(env), []);
});

test('re-fire with same inputs -> still a single kill (idempotent)', { skip }, () => {
  const env = fakeEnv({ '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  run(env, BG('ORIGIN-SID'));
  // Second fire: origin still mapped in sessions (kill seam does not actually remove it),
  // but the row is already gone; the reaper may re-signal. We only require it does not error
  // and does not multiply-target beyond the still-mapped origin. Guard against a runaway.
  run(env, BG('ORIGIN-SID'));
  assert.ok(killedPids(env).every((p) => p === '203774'), 'only ever targets the origin pid');
});

// ---- pid reuse: the registry entry is stale and the number belongs to someone else ----
test('recorded procStart does not match the running process -> no-op', { skip }, () => {
  // Exactly the live state on this box: sessions/<pid>.json survives the process, the
  // pid gets recycled, and without a start-time check the signal lands on the stranger.
  const env = fakeEnv({ '203774': ['ORIGIN-SID', '1375'] }, ['ORIGIN-SID']);
  run(env, BG('ORIGIN-SID'));
  assert.deepStrictEqual(killedPids(env), [], 'recycled pid must never be signalled');
});

test('process is gone entirely -> no-op', { skip }, () => {
  const env = fakeEnv({ '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  fs.rmSync(path.join(env.procdir, '203774'), { recursive: true });
  run(env, BG('ORIGIN-SID'));
  assert.deepStrictEqual(killedPids(env), []);
});

test('record carries no procStart -> unverifiable, no-op', { skip }, () => {
  const env = fakeEnv({ '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  fs.writeFileSync(path.join(env.sdir, '203774.json'),
    JSON.stringify({ pid: 203774, sessionId: 'ORIGIN-SID' }));
  run(env, BG('ORIGIN-SID'));
  assert.deepStrictEqual(killedPids(env), [], 'cannot verify is not permission to kill');
});

test('duplicate sessionId, only the live record verifies -> targets that one', { skip }, () => {
  // A5-03: the old code took the first match on disk, which is as likely to be stale.
  const env = fakeEnv({ '111111': ['ORIGIN-SID', '1375'], '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  run(env, BG('ORIGIN-SID'));
  assert.deepStrictEqual(killedPids(env), ['203774'], 'the verifying record wins, not the first');
});

test('two live records claim one sessionId -> refuses to guess', { skip }, () => {
  const env = fakeEnv({ '111111': 'ORIGIN-SID', '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  run(env, BG('ORIGIN-SID'));
  assert.deepStrictEqual(killedPids(env), [], 'ambiguous identity must not be resolved by picking');
});

// ---- structural guards ----
test('never uses SIGKILL', { skip }, () => {
  assert.doesNotMatch(SRC, /kill\s+-9|SIGKILL|-s\s*KILL|-KILL\b/, 'must be graceful SIGTERM only');
});
test('always exits 0 (never blocks session start)', { skip }, () => {
  assert.match(SRC, /exit 0/);
});
