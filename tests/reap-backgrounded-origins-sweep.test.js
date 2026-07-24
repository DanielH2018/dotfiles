// Behavioral tests for the periodic sweep (executable_reap-backgrounded-origins-sweep).
// The sweep is the daemon-independent supplement to the SessionStart hook: it scans every
// live session's own worker cmdline (by pid, from /proc) and delegates to the shared lib,
// so it reaps backgrounded origins that the hook missed (e.g. sessions the stale-config
// daemon spawned). Seams: CLAUDE_SESSIONS_DIR, AGENT_VIEW_DIR, REAP_KILLCMD, REAP_LOG,
// REAP_LIB, REAP_PROC_DIR (a fake /proc so no real process is read or killed).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS_DIR = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks');
const LIB = path.join(HOOKS_DIR, 'reap-origin-lib.sh');
const SWEEP = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_reap-backgrounded-origins-sweep');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const BG = (originSid, ownSid) =>
  `/x/claude --session-id ${ownSid} --fork-session --resume /p/${originSid}.jsonl --reply-on-resume`;

// procs: { pid: cmdline }, sessions: { pid: sid }, rows: [sid]
function fakeEnv({ procs = {}, sessions = {}, rows = [] }) {
  const home = scratch('sweep-');
  const sdir = path.join(home, 'sessions'); fs.mkdirSync(sdir, { recursive: true });
  const pdir = path.join(home, 'proc'); fs.mkdirSync(pdir, { recursive: true });
  const avdir = path.join(home, 'agent-view'); fs.mkdirSync(avdir, { recursive: true });
  for (const [pid, sid] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(sdir, `${pid}.json`), JSON.stringify({ pid: Number(pid), sessionId: sid }));
  }
  for (const [pid, cmd] of Object.entries(procs)) {
    fs.mkdirSync(path.join(pdir, pid), { recursive: true });
    // /proc cmdline is NUL-separated; join args that way so `tr '\0' ' '` recovers them
    fs.writeFileSync(path.join(pdir, pid, 'cmdline'), cmd.split(' ').join('\0'));
  }
  for (const sid of rows) fs.writeFileSync(path.join(avdir, `${sid}.json`), '{}');
  const killed = path.join(home, 'killed.txt');
  const killcmd = path.join(home, 'kill.sh');
  fs.writeFileSync(killcmd, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(killed)}\n`);
  fs.chmodSync(killcmd, 0o755);
  return { home, sdir, pdir, avdir, killcmd, killed, log: path.join(home, 'reap.log') };
}
function runSweep(env) {
  execFileSync('bash', [SWEEP], {
    env: {
      ...process.env, REAP_LIB: LIB, CLAUDE_SESSIONS_DIR: env.sdir, REAP_PROC_DIR: env.pdir,
      AGENT_VIEW_DIR: env.avdir, REAP_KILLCMD: env.killcmd, REAP_LOG: env.log,
    }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}
const killed = (env) => fs.existsSync(env.killed)
  ? fs.readFileSync(env.killed, 'utf8').split('\n').filter(Boolean) : [];

test('reaps the origin of a backgrounded fork found in the scan', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': BG('ORIGIN', 'FORK'), '222': '/x/claude' },   // 111 = bg fork, 222 = origin worker
    sessions: { '111': 'FORK', '222': 'ORIGIN' },
    rows: ['ORIGIN'],
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), ['222'], 'origin pid reaped');
  assert.ok(!fs.existsSync(path.join(env.avdir, 'ORIGIN.json')), 'row removed');
  assert.match(fs.readFileSync(env.log, 'utf8'), /ORIGIN.*222/);
});

test('no backgrounded fork present -> nothing killed', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': '/x/claude --session-id A', '222': '/x/claude' },  // plain interactive sessions
    sessions: { '111': 'A', '222': 'B' },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), []);
});

test('fork whose origin is not among live sessions -> no-op', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': BG('GHOST', 'FORK') },
    sessions: { '111': 'FORK' },   // no session maps to GHOST
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), []);
});

test('multiple forks reaped in one sweep', { skip }, () => {
  const env = fakeEnv({
    procs: {
      '111': BG('O1', 'F1'), '10': '/x/claude',
      '112': BG('O2', 'F2'), '20': '/x/claude',
    },
    sessions: { '111': 'F1', '10': 'O1', '112': 'F2', '20': 'O2' },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env).sort(), ['10', '20']);
});

test('worker whose /proc cmdline is gone is skipped without error', { skip }, () => {
  const env = fakeEnv({
    procs: { '222': '/x/claude' },       // fork 111 has a session file but no /proc entry
    sessions: { '111': 'FORK', '222': 'ORIGIN' },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), []);
});
