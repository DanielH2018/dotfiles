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
  fs.writeFileSync(path.join(bin, 'wezterm'), '#!/bin/bash\necho "[]"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\necho "$*" >> "$TMUX_LOG"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'fzf'), '#!/bin/bash\ncat > "$FZF_CAPTURE"\n[ -n "${FZF_PICK:-}" ] && printf \'%s\\n\' "$FZF_PICK"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash\necho "${HOST}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/bash\necho "$*" >> "$CLAUDE_LOG"\nexit 0\n', { mode: 0o755 });
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    TMUX_LOG: tmuxLog, CLAUDE_LOG: claudeLog, FZF_CAPTURE: capture,
  };
  delete env.TMUX;
  delete env.WEZTERM_PANE;
  return { bin, home, env, tmuxLog, claudeLog, capture };
}

function hookRow(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
function sessFile(home, pid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, ...obj }));
}
function run(env, args, extraEnv = {}) {
  try {
    return { out: execFileSync(BASH, [VIEW, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv }, input: '',
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
    sessionId: 'aaaa1111-0000-0000-0000-000000000001', kind: 'bg', status: 'busy',
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
  assert.strictEqual(k[7], 'bg:aaaa1111-0000-0000-0000-000000000001',
    'locator carries the sid so <enter> can claude-attach it');
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
    sessionId: sid, kind: 'bg', status: 'busy',
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
  assert.strictEqual(k[7], `bg:${sid}`, 'merged daemon row swaps the locator for the sid');
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

const BG_SID = 'dddd4444-0000-0000-0000-000000000001';
const bgKey = cardKey([HOST, '/home/daniel', 'working', '0', 'Some Job', 'none', 'bg', `bg:${BG_SID}`]);

test('--jump on a bg row inside tmux runs `claude attach <sid>` in a new window', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const r = run(env, ['--jump', bgKey], { TMUX: '/tmp/tmux-1000/default,1,0' });
  assert.strictEqual(r.code, 0);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'),
    new RegExp(`new-window -n agents claude attach ${BG_SID}`));
});

test('--jump on a bg row from a bare shell execs `claude attach <sid>` in place', { skip }, () => {
  const { env, claudeLog, tmuxLog } = makeEnv();
  const r = run(env, ['--jump', bgKey]);
  assert.strictEqual(r.code, 0);
  assert.match(fs.readFileSync(claudeLog, 'utf8'), new RegExp(`^attach ${BG_SID}$`, 'm'));
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

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
