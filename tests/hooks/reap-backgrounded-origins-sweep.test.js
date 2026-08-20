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

const HOOKS_DIR = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const LIB = path.join(HOOKS_DIR, 'reap-origin-lib.sh');
const SWEEP = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_reap-backgrounded-origins-sweep');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const BG = (originSid, ownSid) =>
  `/x/claude --session-id ${ownSid} --fork-session --resume /p/${originSid}.jsonl --reply-on-resume`;

// A daemon-roster worker entry. Backgrounding a session dispatches it onto a spare, so the
// only origin link is dispatch.launch.sessionId — the shape reap_origin_from_roster gates on.
const bgWorker = (originSid, ownSid) => ({
  pid: 1, sessionId: ownSid,
  dispatch: {
    source: 'slash', sessionId: ownSid,
    launch: { mode: 'resume', sessionId: `/p/${originSid}.jsonl`, fork: true, flagArgs: ['--reply-on-resume'] },
    seed: { intent: '(backgrounded)', name: 'Some Session' },
  },
});
// A plain spare-spawned agent: never a backgrounding, must never be treated as one.
const spareWorker = (ownSid) => ({
  pid: 2, sessionId: ownSid,
  dispatch: {
    source: 'spare', sessionId: ownSid,
    launch: { mode: 'prompt', args: ['--session-id', ownSid, '--agent', 'claude'] },
    seed: { intent: '' },
  },
});
const rosterOf = (workers) => ({ proto: 1, supervisorPid: 999, workers });

// procs: { pid: cmdline }, sessions: { pid: sid }, rows: [sid], roster: {workers}|null
function fakeEnv({ procs = {}, sessions = {}, rows = [], roster = null }) {
  const home = scratch('sweep-');
  const sdir = path.join(home, 'sessions'); fs.mkdirSync(sdir, { recursive: true });
  const pdir = path.join(home, 'proc'); fs.mkdirSync(pdir, { recursive: true });
  const avdir = path.join(home, 'agent-view'); fs.mkdirSync(avdir, { recursive: true });
  // Each session pid also gets a /proc/<pid>/stat whose start time matches its recorded
  // procStart, so it verifies as the process the registry claims. Pass [sid, procStart]
  // to record a mismatching start time — that is a recycled pid.
  for (const [pid, spec] of Object.entries(sessions)) {
    const [sid, recorded] = Array.isArray(spec) ? spec : [spec, '900100'];
    fs.writeFileSync(path.join(sdir, `${pid}.json`),
      JSON.stringify({ pid: Number(pid), sessionId: sid, procStart: recorded }));
    fs.mkdirSync(path.join(pdir, pid), { recursive: true });
    const pad = Array.from({ length: 18 }, (_, i) => i).join(' ');
    fs.writeFileSync(path.join(pdir, pid, 'stat'), `${pid} (claude (bg) worker) S ${pad} 900100\n`);
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
  // Always a concrete path, even with no fixture: an unset REAP_ROSTER would fall back to
  // the real ~/.claude/daemon/roster.json and let a live session leak into the test.
  const rosterPath = path.join(home, 'roster.json');
  if (roster) fs.writeFileSync(rosterPath, JSON.stringify(rosterOf(roster)));
  return { home, sdir, pdir, avdir, killcmd, killed, roster: rosterPath, log: path.join(home, 'reap.log') };
}
function runSweep(env) {
  execFileSync('bash', [SWEEP], {
    env: {
      ...process.env, REAP_LIB: LIB, CLAUDE_SESSIONS_DIR: env.sdir, REAP_PROC_DIR: env.pdir,
      IDENTITY_LIB: path.join(HOOKS_DIR, 'identity.sh'), IDENTITY_PROC_DIR: env.pdir,
      AGENT_VIEW_DIR: env.avdir, REAP_KILLCMD: env.killcmd, REAP_LOG: env.log,
      REAP_ROSTER: env.roster,
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

test('a half-written session file does not stop the sweep', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': BG('ORIGIN', 'FORK'), '222': '/x/claude' },
    sessions: { '111': 'FORK', '222': 'ORIGIN' },
    rows: ['ORIGIN'],
  });
  // The index builds with one jq over every session file, and jq aborts the whole batch on a
  // truncated one — so the sweep must fall back to the per-file scan, not reap nothing.
  // Named to sort FIRST: jq then dies before emitting any valid row, so only the fallback
  // can make this pass.
  fs.writeFileSync(path.join(env.sdir, '000.json'), '{"pid": 333, "sessi');
  runSweep(env);
  assert.deepStrictEqual(killed(env), ['222'], 'origin still reaped despite the bad file');
});

// --- spare-dispatched backgrounding: origin link lives only in the daemon roster ---

test('reaps the origin of a spare-dispatched backgrounding (roster path)', { skip }, () => {
  const env = fakeEnv({
    // The fork's own argv carries NO --resume: this is exactly the case the cmdline scan misses.
    procs: { '111': '/x/claude bg-spare --bg-spare /tmp/x/abc.claim.sock', '222': '/x/claude' },
    sessions: { '111': 'FORK', '222': 'ORIGIN' },
    rows: ['ORIGIN'],
    roster: { FORK: bgWorker('ORIGIN', 'FORK') },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), ['222'], 'origin pid reaped via roster');
  assert.match(fs.readFileSync(env.log, 'utf8'), /ORIGIN.*222/);
});

// Backgrounding WITH a prompt puts the prompt text in seed.intent, not the literal
// "(backgrounded)" a no-prompt backgrounding carries. Requiring that exact string excluded
// the commonest case: found live with the origin still running 1h53m after the fork, holding
// its memory and a second Agentview row.
test('reaps the origin when the backgrounding carried a prompt', { skip }, () => {
  const promptWorker = bgWorker('ORIGIN', 'FORK');
  promptWorker.dispatch.seed.intent = "I've got some fixes for Claude and Agentview.\n\n- Fix the thing";
  const env = fakeEnv({
    procs: { '111': '/x/claude bg-spare --bg-spare /tmp/x/abc.claim.sock', '222': '/x/claude' },
    sessions: { '111': 'FORK', '222': 'ORIGIN' },
    rows: ['ORIGIN'],
    roster: { FORK: promptWorker },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), ['222'], 'a prompt in seed.intent is still a backgrounding');
});

test('plain spare agent in roster -> nothing killed', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': '/x/claude bg-spare --bg-spare /tmp/x/abc.claim.sock', '222': '/x/claude' },
    sessions: { '111': 'AGENT', '222': 'OTHER' },
    roster: { AGENT: spareWorker('AGENT') },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), [], 'a spare-spawned agent is not a backgrounding');
});

test('roster fork whose origin is not a live session -> no-op', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': '/x/claude bg-spare' },
    sessions: { '111': 'FORK' },                    // nothing maps to GHOST
    roster: { FORK: bgWorker('GHOST', 'FORK') },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), []);
});

test('roster entry pointing at its own session -> never self', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': '/x/claude bg-spare' },
    sessions: { '111': 'SELF' },
    roster: { SELF: bgWorker('SELF', 'SELF') },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env), []);
});

test('missing roster file -> no error, nothing killed', { skip }, () => {
  const env = fakeEnv({
    procs: { '222': '/x/claude' },
    sessions: { '222': 'ORIGIN' },
  });                                               // roster fixture omitted -> file absent
  runSweep(env);
  assert.deepStrictEqual(killed(env), []);
});

test('multiple spare-dispatched backgroundings reaped in one sweep', { skip }, () => {
  const env = fakeEnv({
    procs: { '111': '/x/claude bg-spare', '112': '/x/claude bg-spare' },
    sessions: { '111': 'F1', '10': 'O1', '112': 'F2', '20': 'O2' },
    roster: { F1: bgWorker('O1', 'F1'), F2: bgWorker('O2', 'F2') },
  });
  runSweep(env);
  assert.deepStrictEqual(killed(env).sort(), ['10', '20']);
});
