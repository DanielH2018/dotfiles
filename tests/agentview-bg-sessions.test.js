// Regression guard for agentview's merge with Claude's own per-process session
// registry (~/.claude/sessions/<pid>.json). Daemon-hosted background jobs fire no
// UserPromptSubmit for daemon-mediated replies, so hook rows go stale or never exist;
// the picker folds the registry in per render. Hermetic like agentview.test.js: the
// real script runs with stub wezterm/tmux/ssh/fzf/hostname/curl/claude and a temp HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIEW = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_agentview');
const US = '\x1f';

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function findBash() {
  const exts = process.platform === 'win32' ? ['bash.exe', 'bash'] : ['bash'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) { const p = path.join(dir, e); if (fs.existsSync(p)) return p; }
  }
  return 'bash';
}
const BASH = findBash();

const HOST = 'daniel-desktop';
const ALIVE_PID = process.pid;          // the test runner itself — always kill -0-able
// A second genuinely-live, owned pid — for scenarios needing two distinct live sessions (each
// registry file is keyed by pid, so two live sessions can't share one). Reaped on exit.
const sleeper = require('node:child_process').spawn('sleep', ['300'], { stdio: 'ignore' });
sleeper.unref();                        // don't hold Node's event loop open past the tests
const ALIVE_PID2 = sleeper.pid;
const DEAD_PID = 33554432;              // beyond pid_max — kill -0 always fails
const nowMs = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:]*m/g, '');
const cardKey = (fields) => fields.join(US);

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

function makeEnv() {
  const bin = scratch('avbg-bin-');
  const home = scratch('avbg-home-');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const claudeLog = path.join(bin, 'claude.log'); fs.writeFileSync(claudeLog, '');
  const capture = path.join(bin, 'fzf-capture.txt'); fs.writeFileSync(capture, '');
  // The chooser's window flags are the point of the popup rework and arrive in argv, not on
  // stdin — so log argv separately from the piped list.
  const fzfArgs = path.join(bin, 'fzf-args.txt'); fs.writeFileSync(fzfArgs, '');
  fs.writeFileSync(path.join(bin, 'wezterm'), '#!/bin/bash\necho "[]"\nexit 0\n', { mode: 0o755 });
  // Stateful enough to model window de-dup: new-window records the window name, select-window
  // exits 0 only if that name already exists (real tmux behaviour), kill-window drops it.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "$TMUX_LOG"
wins="$TMUX_LOG.wins"; touch "$wins"
# Real tmux RUNS a display-popup's command string; av_pick gets its pick back that way.
if [ "$1" = "display-popup" ]; then
  for a in "$@"; do cmd="$a"; done
  bash -c "$cmd"
  exit $?
fi
case "$1" in
  select-window) name="\${3#=}"; grep -qxF "$name" "$wins" && exit 0; exit 1 ;;
  new-window)    echo "$3" >> "$wins"; exit 0 ;;
  kill-window)   name="\${3#=}"; grep -vxF "$name" "$wins" > "$wins.t" 2>/dev/null; mv "$wins.t" "$wins"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'fzf'), '#!/bin/bash\necho "$*" >> "$FZF_ARGS"\ncat > "$FZF_CAPTURE"\n[ -n "${FZF_PICK:-}" ] && printf \'%s\\n\' "$FZF_PICK"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash\necho "${HOST}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/bash\necho "$*" >> "$CLAUDE_LOG"\nexit 0\n', { mode: 0o755 });
  // Stands in for `kill` (AV_KILLCMD) so a --remove test can assert WHICH pid was signalled
  // without the suite actually killing the live process it borrowed for the registry fixture.
  const killLog = path.join(bin, 'kill.log'); fs.writeFileSync(killLog, '');
  fs.writeFileSync(path.join(bin, 'kill-stub'), '#!/bin/bash\necho "$*" >> "$KILL_LOG"\nexit 0\n', { mode: 0o755 });
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    TMUX_LOG: tmuxLog, CLAUDE_LOG: claudeLog, FZF_CAPTURE: capture, FZF_ARGS: fzfArgs,
    AV_KILLCMD: path.join(bin, 'kill-stub'), KILL_LOG: killLog,
  };
  delete env.TMUX;
  delete env.WEZTERM_PANE;
  return { bin, home, env, tmuxLog, claudeLog, capture, killLog, fzfArgs };
}

function hookRow(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
function sessFile(home, pid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, ...obj }));
}
function run(env, args, extraEnv = {}, input = '') {
  try {
    return { out: execFileSync(BASH, [VIEW, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv }, input,
    }), code: 0, err: '' };
  } catch (e) { return { out: e.stdout || '', code: e.status, err: e.stderr || '' }; }
}
function body(env, capture) {
  run(env, []);
  return fs.readFileSync(capture, 'utf8');
}

// ---- synthesis: registry sessions the hooks never saw ------------------------

test('hookless busy bg session renders as a WORKING row with its name, kind=bg', { skip }, () => {
  const { env, home, capture } = makeEnv();
  sessFile(home, ALIVE_PID, {
    sessionId: 'aaaa1111-0000-0000-0000-000000000001', kind: 'bg', status: 'busy', jobId: 'aaaa1111',
    name: 'Dev Environment Functionality Review', cwd: '/home/daniel', statusUpdatedAt: nowMs() - 60_000,
  });
  const raw = body(env, capture);
  const txt = stripAnsi(raw);
  assert.match(txt, /WORKING/);
  assert.match(txt, /Dev Environment Functionality Review/);
  const row = raw.split('\n').find((l) => l.includes(US));
  assert.ok(row, 'a KEY-carrying row is rendered');
  const k = row.split('\t')[0].split(US);
  assert.strictEqual(k[6], 'bg', 'KEY kind field marks the daemon session');
  assert.strictEqual(k[7], 'bg:aaaa1111',
    'locator carries the JOB id (attach matches jobId, not the session uuid)');
});

test('a bg registry entry without a jobId gets a bare bg: locator (roster fallback)', { skip }, () => {
  const { env, home, capture } = makeEnv();
  sessFile(home, ALIVE_PID, {
    sessionId: 'aaaa1111-0000-0000-0000-000000000006', kind: 'bg', status: 'busy',
    name: 'Jobless', cwd: '/home/daniel', statusUpdatedAt: nowMs(),
  });
  const raw = body(env, capture);
  const row = raw.split('\n').find((l) => l.includes(US));
  const k = row.split('\t')[0].split(US);
  assert.strictEqual(k[7], 'bg:');
});

test('hookless waiting bg session lands in NEEDS INPUT', { skip }, () => {
  const { env, home, capture } = makeEnv();
  sessFile(home, ALIVE_PID, {
    sessionId: 'aaaa1111-0000-0000-0000-000000000002', kind: 'bg', status: 'waiting',
    name: 'Deep Review', cwd: '/home/daniel', statusUpdatedAt: nowMs(),
  });
  const txt = stripAnsi(body(env, capture));
  assert.match(txt, /NEEDS INPUT/);
  assert.match(txt, /Deep Review/);
});

test('a hookless busy interactive session is NOT synthesized (no phantom placeholder)', { skip }, () => {
  const { env, home, capture } = makeEnv();
  // A freshly-started interactive session is busy in the registry before its own hook row
  // lands. Synthesizing it would flash a nameless, un-jumpable none: row (its auto name, no
  // locator) until the hook fires — only daemon bg jobs (which fire no hook) get synthesized.
  sessFile(home, ALIVE_PID, {
    sessionId: 'aaaa1111-0000-0000-0000-000000000007', kind: 'interactive', status: 'busy',
    name: 'dev-23', cwd: '/home/daniel/dev', statusUpdatedAt: nowMs(),
  });
  const txt = stripAnsi(body(env, capture));
  assert.match(txt, /no active Claude sessions/, 'interactive session waits for its own hook row');
});

test('idle registry entries (daemon spare pool) are not synthesized', { skip }, () => {
  const { env, home, capture } = makeEnv();
  sessFile(home, ALIVE_PID, {
    sessionId: 'aaaa1111-0000-0000-0000-000000000003', kind: 'bg', status: 'idle',
    name: 'aaaa1111', cwd: '/home/daniel', statusUpdatedAt: nowMs(),
  });
  const txt = stripAnsi(body(env, capture));
  assert.match(txt, /no active Claude sessions/);
});

test('dead-pid registry entries are ignored', { skip }, () => {
  const { env, home, capture } = makeEnv();
  sessFile(home, DEAD_PID, {
    sessionId: 'aaaa1111-0000-0000-0000-000000000004', kind: 'bg', status: 'busy',
    name: 'Ghost Job', cwd: '/home/daniel', statusUpdatedAt: nowMs(),
  });
  const txt = stripAnsi(body(env, capture));
  assert.match(txt, /no active Claude sessions/);
  assert.doesNotMatch(txt, /Ghost Job/);
});

test('statusless registry entries (transient sdk/spare processes) are ignored', { skip }, () => {
  const { env, home, capture } = makeEnv();
  sessFile(home, ALIVE_PID, {
    sessionId: 'aaaa1111-0000-0000-0000-000000000005', kind: 'interactive', cwd: '/tmp',
  });
  const txt = stripAnsi(body(env, capture));
  assert.match(txt, /no active Claude sessions/);
});

// ---- merge: live status overrides a stale hook row ---------------------------

test('stale needs-input hook row is overridden to WORKING by a live busy status', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const sid = 'bbbb2222-0000-0000-0000-000000000001';
  hookRow(home, sid, {
    key: sid, session: sid, kind: 'host', cwd: '/home/daniel', title: '',
    state: 'needs-input', host: HOST, ts: nowSec() - 1800, backend: 'none', locator: 'none:',
    pane: '', pid: String(ALIVE_PID),
  });
  sessFile(home, ALIVE_PID, {
    sessionId: sid, kind: 'bg', status: 'busy', jobId: 'bbbb2222',
    name: 'SSH Readonly Allow Guardrail', cwd: '/home/daniel', statusUpdatedAt: nowMs() - 5_000,
  });
  const raw = body(env, capture);
  const txt = stripAnsi(raw);
  assert.match(txt, /WORKING/);
  assert.doesNotMatch(txt, /NEEDS INPUT/, 'the stale hook state must not render');
  assert.match(txt, /SSH Readonly Allow Guardrail/, 'registry name fills the empty hook title');
  const row = raw.split('\n').find((l) => l.includes(US));
  const k = row.split('\t')[0].split(US);
  assert.strictEqual(k[6], 'bg', 'merged daemon row flips kind to bg');
  assert.strictEqual(k[7], 'bg:bbbb2222', 'merged daemon row swaps the locator for the job id');
});

test('merge keeps hook locator and a /rename custom title', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const sid = 'bbbb2222-0000-0000-0000-000000000002';
  hookRow(home, sid, {
    key: sid, session: sid, kind: 'host', cwd: '/home/daniel/proj', title: 'my renamed task',
    state: 'completed', host: HOST, ts: nowSec() - 600, backend: 'tmux',
    locator: 'tmux:/tmp/tmux-1000/default:main:%4', pane: '', pid: String(ALIVE_PID),
  });
  sessFile(home, ALIVE_PID, {
    sessionId: sid, kind: 'interactive', status: 'busy',
    name: 'auto name', cwd: '/home/daniel/proj', statusUpdatedAt: nowMs(),
  });
  const raw = body(env, capture);
  const txt = stripAnsi(raw);
  assert.match(txt, /WORKING/, 'live busy status wins over the stale completed state');
  assert.match(txt, /my renamed task/, 'hook title wins over the registry name');
  const row = raw.split('\n').find((l) => l.includes(US));
  const k = row.split('\t')[0].split(US);
  assert.strictEqual(k[7], 'tmux:/tmp/tmux-1000/default:main:%4', 'locator survives the merge');
  assert.strictEqual(k[6], 'host', 'an interactive session keeps kind=host');
});

test('sandbox rows are not touched by the registry merge', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const sid = 'cccc3333-0000-0000-0000-000000000001';
  hookRow(home, sid, {
    key: sid, session: sid, kind: 'sandbox', cwd: '/home/daniel/repo', title: 'repo · claude/foo',
    state: 'needs-input', host: HOST, ts: nowSec() - 60, backend: 'wezterm', locator: 'wezterm:9', pane: '9',
  });
  sessFile(home, ALIVE_PID, {
    sessionId: sid, kind: 'bg', status: 'busy', name: 'x', cwd: '/home/daniel/repo', statusUpdatedAt: nowMs(),
  });
  const txt = stripAnsi(body(env, capture));
  assert.match(txt, /NEEDS INPUT/, 'sandbox rows keep their own hook-driven state');
});

// ---- jump: bg rows open the agents UI ---------------------------------------

const BG_JOB = 'dddd4444';
const bgKey = cardKey([HOST, '/home/daniel', 'working', '0', 'Some Job', 'none', 'bg', `bg:${BG_JOB}`]);

test('--jump on a bg row inside tmux runs `claude attach <jobId>` in a per-session window', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const r = run(env, ['--jump', bgKey], { TMUX: '/tmp/tmux-1000/default,1,0' });
  assert.strictEqual(r.code, 0);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'),
    new RegExp(`new-window -n cc-${BG_JOB} claude attach ${BG_JOB}`));
});

test('a second --jump to the same bg session reuses its window (no per-jump leak)', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const tmux = { TMUX: '/tmp/tmux-1000/default,1,0' };
  run(env, ['--jump', bgKey], tmux);
  run(env, ['--jump', bgKey], tmux);          // jump to the SAME live session again
  const log = fs.readFileSync(tmuxLog, 'utf8');
  const spawns = (log.match(new RegExp(`new-window -n cc-${BG_JOB}`, 'g')) || []).length;
  assert.strictEqual(spawns, 1, 'the window is spawned once, then reused — this is the leak fix');
  assert.match(log, new RegExp(`select-window -t =cc-${BG_JOB}`), 'the reuse path checks for an existing window');
});

test('--jump to two different bg sessions opens two distinct windows', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const tmux = { TMUX: '/tmp/tmux-1000/default,1,0' };
  const other = cardKey([HOST, '/home/daniel', 'working', '0', 'Other Job', 'none', 'bg', 'bg:eeee5555']);
  run(env, ['--jump', bgKey], tmux);
  run(env, ['--jump', other], tmux);
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, new RegExp(`new-window -n cc-${BG_JOB}`), 'first session gets its window');
  assert.match(log, /new-window -n cc-eeee5555/, 'a distinct session gets a separate window');
});

test('--jump on a bg row from a bare shell execs `claude attach <jobId>` in place', { skip }, () => {
  const { env, claudeLog, tmuxLog } = makeEnv();
  const r = run(env, ['--jump', bgKey]);
  assert.strictEqual(r.code, 0);
  assert.match(fs.readFileSync(claudeLog, 'utf8'), new RegExp(`^attach ${BG_JOB}$`, 'm'));
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'no tmux involvement outside tmux');
});

test('--jump on a sid-less bg row (legacy KEY) falls back to the agents roster', { skip }, () => {
  const { env, claudeLog } = makeEnv();
  const legacy = cardKey([HOST, '/home/daniel', 'working', '0', 'Some Job', 'none', 'bg', 'none:']);
  const r = run(env, ['--jump', legacy]);
  assert.strictEqual(r.code, 0);
  assert.match(fs.readFileSync(claudeLog, 'utf8'), /^agents$/m);
});

test('--card labels a bg row as background', { skip }, () => {
  const { env } = makeEnv();
  const txt = stripAnsi(run(env, ['--card', bgKey]).out);
  assert.match(txt, /background · daniel/);
  assert.match(txt, /Kind\s+background/);
});

// ---- collapse: a bg fork folds into its interactive origin -------------------
// Backgrounding a session spawns a bg job that inherits the task title under a fresh
// session id with no lineage link, so the origin + fork render as two same-named rows.
// collapse_bg_forks folds a bg/non-bg pair sharing host+cwd+title into one, keeping the
// best jump target (live pane > bg-attach > none:).

test('a bg fork and its interactive origin collapse to one row, keeping the live pane', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const cwd = '/home/daniel/proj';
  // interactive origin: a hook row with a real tmux pane (the better jump target), kept
  // fresher so it's the surviving base. Its pid maps to a LIVE registry session (a live
  // interactive session always has one) — the reuse-safe gate keeps its locator only then.
  hookRow(home, 'aaaaaaaa-0000-0000-0000-0000000000aa', {
    session: 'aaaaaaaa-0000-0000-0000-0000000000aa', host: HOST, cwd, state: 'working', kind: 'host',
    locator: 'tmux:/tmp/x:sess:%3', title: 'Shared Task', pid: ALIVE_PID2, ts: nowSec(),
  });
  sessFile(home, ALIVE_PID2, {
    sessionId: 'aaaaaaaa-0000-0000-0000-0000000000aa', kind: 'interactive', status: 'busy',
    name: 'Shared Task', cwd, statusUpdatedAt: nowMs() - 6000,
  });
  // backgrounded fork: a hookless bg registry session with the SAME task name (synthesized).
  sessFile(home, ALIVE_PID, {
    sessionId: 'bbbbbbbb-0000-0000-0000-0000000000bb', kind: 'bg', status: 'busy', jobId: 'bjob',
    name: 'Shared Task', cwd, statusUpdatedAt: nowMs() - 5000,
  });
  const raw = body(env, capture);
  const rows = raw.split('\n').filter((l) => l.includes(US) && l.split('\t')[0].split(US)[4] === 'Shared Task');
  assert.strictEqual(rows.length, 1, 'the fork folds into a single row');
  const k = rows[0].split('\t')[0].split(US);
  assert.strictEqual(k[6], 'host', 'kept the interactive kind (it has a live pane)');
  assert.strictEqual(k[7], 'tmux:/tmp/x:sess:%3', 'kept the live pane as the jump target, not bg-attach');
});

test('a bg fork whose origin has no pane keeps the bg-attach locator', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const cwd = '/home/daniel/proj';
  hookRow(home, 'cccccccc-0000-0000-0000-0000000000cc', {
    session: 'cccccccc-0000-0000-0000-0000000000cc', host: HOST, cwd, state: 'working', kind: 'host',
    locator: 'none:', title: 'Paneless Task', pid: ALIVE_PID, ts: nowSec() - 30,
  });
  sessFile(home, ALIVE_PID, {
    sessionId: 'dddddddd-0000-0000-0000-0000000000dd', kind: 'bg', status: 'busy', jobId: 'djob',
    name: 'Paneless Task', cwd, statusUpdatedAt: nowMs(),
  });
  const raw = body(env, capture);
  const rows = raw.split('\n').filter((l) => l.includes(US) && l.split('\t')[0].split(US)[4] === 'Paneless Task');
  assert.strictEqual(rows.length, 1, 'still one row');
  const k = rows[0].split('\t')[0].split(US);
  assert.strictEqual(k[7], 'bg:djob', 'bg-attach beats a none: origin');
  assert.strictEqual(k[6], 'bg', 'kind routes <enter> to the bg attach');
});

test('two interactive sessions sharing a title (no bg fork) are NOT merged', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const cwd = '/home/daniel/proj';
  hookRow(home, 'eeeeeeee-0000-0000-0000-0000000000e1', {
    session: 'eeeeeeee-0000-0000-0000-0000000000e1', host: HOST, cwd, state: 'working', kind: 'host',
    locator: 'tmux:/tmp/x:sess:%3', title: 'Twin Task', pid: ALIVE_PID, ts: nowSec(),
  });
  hookRow(home, 'eeeeeeee-0000-0000-0000-0000000000e2', {
    session: 'eeeeeeee-0000-0000-0000-0000000000e2', host: HOST, cwd, state: 'working', kind: 'host',
    locator: 'tmux:/tmp/x:sess:%4', title: 'Twin Task', pid: ALIVE_PID, ts: nowSec(),
  });
  const raw = body(env, capture);
  const rows = raw.split('\n').filter((l) => l.includes(US) && l.split('\t')[0].split(US)[4] === 'Twin Task');
  assert.strictEqual(rows.length, 2, 'no bg fork present -> both interactive sessions stay distinct');
});

// ---- reuse-safety: a stale host row whose pid the OS recycled must not lend its --------
// now-reassigned pane to a live session. This is the Clipboard->memory-usage misroute:
// a dead "Claude Clipboard Fix" host row kept pane %14, tmux handed %14 to a "WSL Memory
// leak" pane, and collapse folded the stale pane into the live bg daemon of the same name,
// so <enter> jumped to the memory pane. gather_local_rows must drop a host row whose sid is
// absent from the live registry, even though its (recycled) pid still passes kill -0.

test('a stale host row with a reused pid does not lend its pane to a live bg of the same name', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const cwd = '/home/daniel/dev';
  // Dead "Clipboard Fix" host row: its sid is NOT in the registry, but ALIVE_PID (the test
  // runner — a non-Claude process) has recycled the pid, so kill -0 passes. Its pane %14 has
  // since been reassigned by tmux to another session.
  hookRow(home, 'deadc0de-0000-0000-0000-00000000dead', {
    session: 'deadc0de-0000-0000-0000-00000000dead', host: HOST, cwd, state: 'completed', kind: 'host',
    locator: 'tmux:/tmp/tmux-1000/default:claude-37183:%14', title: 'Claude Clipboard Fix',
    pid: ALIVE_PID, ts: nowSec() - 300,
  });
  // The real, live "Claude Clipboard Fix" — a bg daemon (hookless, synthesized).
  sessFile(home, ALIVE_PID2, {
    sessionId: 'c11b0000-0000-0000-0000-00000000c11b', kind: 'bg', status: 'busy', jobId: 'clipjob',
    name: 'Claude Clipboard Fix', cwd, statusUpdatedAt: nowMs(),
  });
  const raw = body(env, capture);
  const rows = raw.split('\n').filter((l) => l.includes(US) && l.split('\t')[0].split(US)[4] === 'Claude Clipboard Fix');
  assert.strictEqual(rows.length, 1, 'the stale host row is dropped; only the live bg daemon renders');
  const k = rows[0].split('\t')[0].split(US);
  assert.strictEqual(k[7], 'bg:clipjob', 'jumps via claude attach, NOT the reused %14 pane');
  assert.strictEqual(k[6], 'bg', 'routes <enter> to the live bg session');
  assert.doesNotMatch(raw, /%14/, 'the reassigned pane id never reaches a KEY');
});

test('a host row with a reused pid keeps rendering but its stale pane locator is scrubbed', { skip }, () => {
  const { env, home, capture } = makeEnv();
  // No registry entry for this sid (session dead / not yet registered); ALIVE_PID recycled to a
  // non-Claude process. The row must still render (a live session momentarily off the registry
  // must not vanish), but its unverified pane %9 must be scrubbed so <enter> can't land on it.
  hookRow(home, 'deadbeef-0000-0000-0000-00000000beef', {
    session: 'deadbeef-0000-0000-0000-00000000beef', host: HOST, cwd: '/home/daniel/dev',
    state: 'working', kind: 'host', locator: 'tmux:/tmp/x:sess:%9', title: 'Ghosted Session',
    pid: ALIVE_PID, ts: nowSec() - 120,
  });
  const raw = body(env, capture);
  assert.match(stripAnsi(raw), /Ghosted Session/, 'the row still renders');
  const row = raw.split('\n').find((l) => l.includes(US) && l.split('\t')[0].split(US)[4] === 'Ghosted Session');
  const k = row.split('\t')[0].split(US);
  assert.strictEqual(k[7], 'none:', 'the unverified pane locator is scrubbed');
  assert.doesNotMatch(raw, /%9/, 'the stale pane id never reaches a KEY');
});

// ---- --remove of a bg-MERGED row (Ctrl+X) ------------------------------------
// The render rewrites a daemon session's KEY: kind host -> bg and locator none: -> bg:<jobId>
// (merge_session_row). --remove then gets a KEY that matches NOTHING on disk, because the hook
// file still says kind=host / locator=none: — so Ctrl+X silently did nothing on every bg row.
const avFile = (home, sid) => path.join(home, '.claude', 'agent-view', `${sid}.json`);
// The Ctrl+X confirm is an fzf chooser now, not a `read`, so the stub answers it via FZF_PICK
// instead of stdin. Leaving FZF_PICK unset models an empty pick — i.e. cancelling.
const CONFIRM = { FZF_PICK: 'Remove' };

test('--remove deletes a bg-merged hook row whose KEY carries the bg: locator', { skip }, () => {
  const { env, home, capture, killLog } = makeEnv();
  const sid = 'bbbb2222-0000-0000-0000-000000000001';
  hookRow(home, sid, {
    key: sid, session: sid, host: HOST, cwd: '/home/daniel/dev', state: 'idle', kind: 'host',
    locator: 'none:', pane: '', title: '', pid: String(ALIVE_PID2), ts: nowSec() - 30,
  });
  sessFile(home, ALIVE_PID2, {
    sessionId: sid, kind: 'bg', status: 'busy', jobId: 'bbbb2222', name: 'Nameless Job',
    cwd: '/home/daniel/dev', statusUpdatedAt: nowMs(),
  });
  // Take the KEY the picker would actually hand Ctrl+X, not a hand-built one.
  const raw = body(env, capture);
  const row = raw.split('\n').find((l) => l.includes(US) && l.split('\t')[0].split(US)[7] === 'bg:bbbb2222');
  assert.ok(row, 'the merged row renders with a bg: locator');
  const key = row.split('\t')[0];
  assert.strictEqual(run(env, ['--remove', key], CONFIRM).code, 0);
  assert.ok(!fs.existsSync(avFile(home, sid)), 'the bg row\'s hook file is deleted');
  assert.match(fs.readFileSync(killLog, 'utf8'), new RegExp(String(ALIVE_PID2)),
    'the live process behind the session is signalled');
});

test('--remove of one bg row leaves the other bg rows alone', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const gone = 'bbbb2222-0000-0000-0000-000000000002';
  const keep = 'bbbb2222-0000-0000-0000-000000000003';
  // Both hook rows sit at the same cwd with the same none: locator — the shape every local bg
  // row has on disk. Only the session id tells them apart, so a matcher that fell back to
  // host+cwd+kind here would take out the wrong row (or both).
  for (const [sid, pid, job] of [[gone, ALIVE_PID2, 'bbbb2222'], [keep, ALIVE_PID, 'cccc3333']]) {
    hookRow(home, sid, {
      key: sid, session: sid, host: HOST, cwd: '/home/daniel/dev', state: 'idle', kind: 'host',
      locator: 'none:', pane: '', title: '', pid: String(pid), ts: nowSec() - 30,
    });
    sessFile(home, pid, {
      sessionId: sid, kind: 'bg', status: 'busy', jobId: job, name: `job ${job}`,
      cwd: '/home/daniel/dev', statusUpdatedAt: nowMs(),
    });
  }
  const raw = body(env, capture);
  const row = raw.split('\n').find((l) => l.includes(US) && l.split('\t')[0].split(US)[7] === 'bg:bbbb2222');
  assert.strictEqual(run(env, ['--remove', row.split('\t')[0]], CONFIRM).code, 0);
  assert.ok(!fs.existsSync(avFile(home, gone)), 'the picked bg row is removed');
  assert.ok(fs.existsSync(avFile(home, keep)), 'the other bg row at the same cwd survives');
});

test('--remove still matches a bg row by locator when the hook file records bg: itself', { skip }, () => {
  // A row synthesized straight into the registry (or written by a newer hook) already carries
  // bg:<job>; the sid-resolving path must not regress that plain locator match.
  const { env, home } = makeEnv();
  const sid = 'bbbb2222-0000-0000-0000-000000000004';
  hookRow(home, sid, {
    key: sid, session: sid, host: HOST, cwd: '/home/daniel/dev', state: 'idle', kind: 'bg',
    locator: 'bg:dddd4444', pane: '', title: 'Direct', pid: '', ts: nowSec() - 30,
  });
  const key = cardKey([HOST, '/home/daniel/dev', 'idle', String(nowSec()), 'Direct', '', 'bg', 'bg:dddd4444']);
  assert.strictEqual(run(env, ['--remove', key], CONFIRM).code, 0);
  assert.ok(!fs.existsSync(avFile(home, sid)), 'a hook row that already stores bg:<job> still matches');
});

// ---- Ctrl+X / Ctrl+N as popups (see av_pick + AV_EXEC) --------------------------------
// The confirm moved from a raw `read` to an fzf chooser so it can render as a tmux popup
// floating over the session list. Two things have to hold: Cancel must be the default, and
// the chooser must ask for a popup window only where tmux can actually provide one.

test('--remove cancels when the confirm chooser is dismissed', { skip }, () => {
  const { env, home } = makeEnv();
  const sid = 'bbbb2222-0000-0000-0000-000000000005';
  hookRow(home, sid, {
    key: sid, session: sid, host: HOST, cwd: '/home/daniel/dev', state: 'idle', kind: 'bg',
    locator: 'bg:eeee5555', pane: '', title: 'Keep me', pid: '', ts: nowSec() - 30,
  });
  const key = cardKey([HOST, '/home/daniel/dev', 'idle', String(nowSec()), 'Keep me', '', 'bg', 'bg:eeee5555']);
  // No FZF_PICK: <esc> out of the chooser. A destructive action must never be the fallback.
  assert.strictEqual(run(env, ['--remove', key]).code, 0);
  assert.ok(fs.existsSync(avFile(home, sid)), 'an empty pick leaves the session alone');
});

test('--remove will not act on a pick that is not exactly "Remove"', { skip }, () => {
  const { env, home } = makeEnv();
  const sid = 'bbbb2222-0000-0000-0000-000000000006';
  hookRow(home, sid, {
    key: sid, session: sid, host: HOST, cwd: '/home/daniel/dev', state: 'idle', kind: 'bg',
    locator: 'bg:ffff6666', pane: '', title: 'Cancelled', pid: '', ts: nowSec() - 30,
  });
  const key = cardKey([HOST, '/home/daniel/dev', 'idle', String(nowSec()), 'Cancelled', '', 'bg', 'bg:ffff6666']);
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Cancel' }).code, 0);
  assert.ok(fs.existsSync(avFile(home, sid)), 'picking Cancel leaves the session alone');
});

test('the confirm chooser runs in a tmux popup only when $TMUX is set', { skip }, () => {
  const { env, home, fzfArgs, tmuxLog } = makeEnv();
  const sid = 'bbbb2222-0000-0000-0000-000000000007';
  const mk = () => hookRow(home, sid, {
    key: sid, session: sid, host: HOST, cwd: '/home/daniel/dev', state: 'idle', kind: 'bg',
    locator: 'bg:7777aaaa', pane: '', title: 'Geo', pid: '', ts: nowSec() - 30,
  });
  const key = cardKey([HOST, '/home/daniel/dev', 'idle', String(nowSec()), 'Geo', '', 'bg', 'bg:7777aaaa']);

  mk();
  run(env, ['--remove', key], { FZF_PICK: 'Cancel' });          // makeEnv deletes TMUX
  assert.match(fs.readFileSync(fzfArgs, 'utf8'), /--height/,
    'with no popup substrate the chooser is a small inline fzf box');
  assert.ok(!fs.readFileSync(tmuxLog, 'utf8').includes('display-popup'),
    'and nothing is asked of tmux');

  fs.writeFileSync(fzfArgs, ''); fs.writeFileSync(tmuxLog, '');
  mk();
  run(env, ['--remove', key], { FZF_PICK: 'Cancel', TMUX: '/tmp/tmux-1000/default,1,0' });
  // NOT fzf's own --popup: that flag takes the parent picker down with it (the outer fzf
  // exits 130 when the popup closes), which read as "Ctrl+X made the picker vanish".
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /display-popup -E -w 52% -h 20%/,
    'inside tmux the chooser floats over the session list');
  assert.ok(!fs.readFileSync(fzfArgs, 'utf8').includes('--popup'),
    'fzf is never handed --popup — tmux is driven directly');
});

test('ctrl-n and ctrl-x hand off via $AV_EXEC, which only goes silent under tmux', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  // execute() unconditionally clears fzf's window, so the chooser can only float above the
  // list when the bind is execute-silent. That is only safe where the chooser owns its own
  // pty (the tmux popup) — execute-silent hands the child /dev/null and an inline fzf hangs.
  assert.match(src, /if \[ -n "\$\{TMUX:-\}" \]; then AV_EXEC='execute-silent'; else AV_EXEC='execute'; fi/,
    'the bind action resolves once, from $TMUX');
  assert.match(src, /ctrl-x:'"\$AV_EXEC"'\([^)]*--remove \{1\}\)\+reload/, 'ctrl-x still reloads after removing');
  assert.match(src, /ctrl-n:'"\$AV_EXEC"'\([^)]*--spawn/, 'ctrl-n still runs --spawn');
});

process.on('exit', () => {
  try { sleeper.kill(); } catch { /* already gone */ }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
