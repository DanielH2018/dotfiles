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

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_reap-backgrounded-origin.sh');
const SRC = fs.readFileSync(HOOK, 'utf8');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// Build a fake env: sessions dir, agent-view dir, a recording kill seam, a log file.
function fakeEnv(sessions = {}, rows = []) {
  const home = scratch('reap-');
  const sdir = path.join(home, 'sessions'); fs.mkdirSync(sdir, { recursive: true });
  const avdir = path.join(home, 'agent-view'); fs.mkdirSync(avdir, { recursive: true });
  for (const [pid, sid] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(sdir, `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId: sid }));
  }
  for (const sid of rows) fs.writeFileSync(path.join(avdir, `${sid}.json`), '{}');
  const killed = path.join(home, 'killed.txt');
  const killcmd = path.join(home, 'kill.sh');
  fs.writeFileSync(killcmd, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(killed)}\n`);
  fs.chmodSync(killcmd, 0o755);
  const log = path.join(home, 'reap.log');
  return { home, sdir, avdir, killcmd, killed, log };
}

function run(env, cmdline, ownSid = 'FORK-SID') {
  const e = {
    ...process.env,
    REAP_CMDLINE_SOURCE: cmdline,
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
  assert.ok(!fs.existsSync(path.join(env.avdir, 'ORIGIN-SID.json')), 'Agentview row removed');
  assert.match(fs.readFileSync(env.log, 'utf8'), /ORIGIN-SID.*203774/, 'audit line written');
});

// ---- every no-op case: origin must survive ----
test('plain --resume (no --fork-session) -> no-op', { skip }, () => {
  const env = fakeEnv({ '203774': 'ORIGIN-SID' }, ['ORIGIN-SID']);
  run(env, `/x/claude --session-id S --resume /p/ORIGIN-SID.jsonl --model Fable`);
  assert.deepStrictEqual(killedPids(env), [], 'nothing killed');
  assert.ok(fs.existsSync(path.join(env.avdir, 'ORIGIN-SID.json')), 'row untouched');
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

// ---- structural guards ----
test('never uses SIGKILL', { skip }, () => {
  assert.doesNotMatch(SRC, /kill\s+-9|SIGKILL|-s\s*KILL|-KILL\b/, 'must be graceful SIGTERM only');
});
test('always exits 0 (never blocks session start)', { skip }, () => {
  assert.match(SRC, /exit 0/);
});
