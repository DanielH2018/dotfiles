// Characterization + regression guard for executable_agentview (the Agent View fzf
// picker). Drives the ACTUAL script with stub `wezterm`/`tmux`/`ssh`/`fzf`/`hostname`/
// `curl` on PATH and a temp $HOME of registry files, so it's hermetic — no real mux,
// no network, no TTY. Real jq/coreutils are used. Skips without bash/jq.
//
// Modes exercised without a TTY:
//   --card KEY     deterministic preview render (KEY = US-delimited card fields)
//   --resolve KEY  cwd-correlation to a client pane id (legacy path)
//   (default)      builds the grouped body, pipes it to `fzf` (stubbed to capture)
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

// Resolve bash to an absolute path so a test can hand the child a bare PATH
// (to hide jq/wezterm/fzf) without breaking the launch of bash itself.
function findBash() {
  const exts = process.platform === 'win32' ? ['bash.exe', 'bash'] : ['bash'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) { const p = path.join(dir, e); if (fs.existsSync(p)) return p; }
  }
  return 'bash';
}
const BASH = findBash();

const HOST = 'daniel-desktop';                       // what the `hostname` stub reports
const nowSec = () => Math.floor(Date.now() / 1000);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:]*m/g, '');
// The row KEY (and the --card arg) is the card fields joined by US.
// Order: host|cwd|state|ts|title|pane|kind|locator.
const cardKey = (fields) => fields.join(US);

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// A hermetic environment: a stub-bin dir (wezterm/tmux/ssh/fzf/hostname/curl) + a temp HOME.
function makeEnv({ list = '[]', remote = '' } = {}) {
  const bin = scratch('av-bin-');
  const home = scratch('av-home-');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  const listFile = path.join(bin, 'list.json'); fs.writeFileSync(listFile, list);
  const remoteFile = path.join(bin, 'remote.json'); fs.writeFileSync(remoteFile, remote);
  // The picker reads homelab sessions from the cache file (the background ssh refreshes
  // it + live-reloads fzf); seed it directly so the initial render sees them.
  const cacheFile = path.join(home, '.agentview-remote-cache');
  if (remote) fs.writeFileSync(cacheFile, remote);
  const activateLog = path.join(bin, 'activate.log'); fs.writeFileSync(activateLog, '');
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const spawnLog = path.join(bin, 'spawn.log'); fs.writeFileSync(spawnLog, '');
  const capture = path.join(bin, 'fzf-capture.txt'); fs.writeFileSync(capture, '');

  fs.writeFileSync(path.join(bin, 'wezterm'), `#!/bin/bash
case "$*" in
  *list*) cat "$WEZ_LIST_FILE" 2>/dev/null ;;
  *activate-pane*) prev=""; for a in "$@"; do [ "$prev" = "--pane-id" ] && echo "$a" >> "$WEZ_ACTIVATE_LOG"; prev="$a"; done ;;
  *spawn*) echo "$*" >> "$WEZ_SPAWN_LOG" ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "$TMUX_LOG"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
echo "$*" >> "$SSH_LOG"
cat "$SSH_REMOTE_FILE" 2>/dev/null; exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash
cat > "$FZF_CAPTURE"
[ -n "\${FZF_PICK:-}" ] && printf '%s\\n' "$FZF_PICK"
exit \${FZF_RC:-0}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash
echo "${HOST}"
`, { mode: 0o755 });
  // no-op curl: the background live-reload poster fires one; keep it off the network.
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
exit 0
`, { mode: 0o755 });

  const sshLog = path.join(bin, 'ssh.log'); fs.writeFileSync(sshLog, '');
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    WEZ_LIST_FILE: listFile, SSH_REMOTE_FILE: remoteFile, SSH_LOG: sshLog,
    WEZ_ACTIVATE_LOG: activateLog, TMUX_LOG: tmuxLog, WEZ_SPAWN_LOG: spawnLog, FZF_CAPTURE: capture,
  };
  delete env.TMUX;          // never let the test host's tmux socket leak into detection
  delete env.WEZTERM_PANE;  // nor its WezTerm pane id — remote-attach branches on it
  return { bin, home, env, listFile, remoteFile, activateLog, tmuxLog, spawnLog, sshLog, capture };
}

function stateFile(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
function run(env, args, extraEnv = {}) {
  try {
    return { out: execFileSync(BASH, [VIEW, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv },
    }), code: 0, err: '' };
  } catch (e) { return { out: e.stdout || '', code: e.status, err: e.stderr || '' }; }
}
// A wezterm `cli list` pane entry.
const pane = (id, cwd, title) => ({ pane_id: id, cwd, title, window_id: 0, tab_id: 0 });

// ---- --card (preview render) --------------------------------------------
test('--card renders a local session card with PC machine label', { skip }, () => {
  const { env } = makeEnv();
  const ts = nowSec() - 300; // 5 minutes ago
  const blob = cardKey([HOST, 'C:\\Users\\daniel\\My_Vault', 'working', String(ts), 'fixing the parser', '7', 'host', 'wezterm:7']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, /claude · My_Vault/);
  assert.match(txt, /State\s+working/);
  assert.match(txt, new RegExp(`Machine\\s+PC · ${HOST}`));
  assert.match(txt, /Folder\s+My_Vault/);
  assert.match(txt, /Task\s+fixing the parser/);
  assert.match(txt, /Updated\s+5m ago/);
});

test('--card labels a daniel-server session as homelab', { skip }, () => {
  const { env } = makeEnv();
  const blob = cardKey(['daniel-server', '/home/ubuntu/proj', 'needs-input', '0', '', '1', 'host', 'none:']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, /Machine\s+homelab · daniel-server/);
  assert.match(txt, /State\s+needs input/);
});

test('--card marks a sandbox session distinctly', { skip }, () => {
  const { env } = makeEnv();
  const blob = cardKey([HOST, 'C:\\repos\\airflow', 'working', '0', 'airflow · claude/foo', '9', 'sandbox', 'wezterm:9']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, /sandbox · airflow/, 'sandbox rows carry a sandbox label');
  assert.match(txt, /Kind\s+sandbox/);
});

// ---- --resolve (cwd correlation, legacy path) ---------------------------
test('--resolve picks the non-shell pane at a matching local cwd', { skip }, () => {
  const list = JSON.stringify([
    pane(3, 'file:///C:/Users/daniel/My_Vault', 'bash.exe'),        // shell — excluded
    pane(7, 'file:///C:/Users/daniel/My_Vault', 'Claude — task'),   // the real one
  ]);
  const { env } = makeEnv({ list });
  const key = [HOST, 'C:\\Users\\daniel\\My_Vault', '7'].join(US);
  assert.strictEqual(run(env, ['--resolve', key]).out.trim(), '7');
});

test('--resolve correlates a remote POSIX cwd by prefix', { skip }, () => {
  const list = JSON.stringify([pane(12, 'file:///home/ubuntu/project', 'editing main.rs')]);
  const { env } = makeEnv({ list });
  const key = ['daniel-server', '/home/ubuntu/project', '1'].join(US);
  assert.strictEqual(run(env, ['--resolve', key]).out.trim(), '12');
});

// ---- default mode: grouped body piped to fzf ----------------------------
test('body groups sessions by state and hides sessions older than a day', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'a', { pane: '1', state: 'working',     cwd: 'C:\\a\\alpha',  session: 'a', host: HOST, ts: now - 10 });
  stateFile(home, 'b', { pane: '2', state: 'needs-input', cwd: 'C:\\b\\bravo',  session: 'b', host: HOST, ts: now - 20 });
  stateFile(home, 'c', { pane: '3', state: 'completed',   cwd: 'C:\\c\\charlie',session: 'c', host: HOST, ts: now - 30 });
  stateFile(home, 'old', { pane: '4', state: 'working',   cwd: 'C:\\d\\staleone', session: 'old', host: HOST, ts: now - 200000 });
  run(env, []); // fzf stub exits 0 with no pick -> agentview exits after capture
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /WORKING/);
  assert.match(body, /NEEDS INPUT/);
  assert.match(body, /COMPLETED/);
  assert.match(body, /alpha/); assert.match(body, /bravo/); assert.match(body, /charlie/);
  assert.doesNotMatch(body, /staleone/, 'session older than a day must be hidden');
});

test('body labels a sandbox row as "sandbox ·"', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'sb', { key: 'sb', run: 'r1', kind: 'sandbox', state: 'working',
    cwd: 'C:\\repos\\airflow', title: 'airflow · claude/foo', host: HOST, ts: now - 5,
    backend: 'wezterm', locator: 'wezterm:9', pane: '9' });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /sandbox · airflow/, 'sandbox kind renders a sandbox label');
  assert.match(body, /airflow · claude\/foo/, 'registry title is used for the row text');
});

test('body merges remote (homelab) sessions from the cache snapshot', { skip }, () => {
  const now = nowSec();
  const remote = JSON.stringify({ pane: '1', state: 'working', cwd: '/home/ubuntu/remoteproj', session: 'r', host: 'daniel-server', ts: now - 5 });
  const { env, home, capture } = makeEnv({ remote });
  stateFile(home, 'local', { pane: '1', state: 'working', cwd: 'C:\\x\\localproj', session: 'local', host: HOST, ts: now - 5 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /localproj/);
  assert.match(body, /remoteproj/, 'remote session from the cache must appear');
});

test('--body prints the grouped list (local + cache) to stdout for the live reload', { skip }, () => {
  const now = nowSec();
  const remote = JSON.stringify({ pane: '1', state: 'needs-input', cwd: '/home/ubuntu/remotebody', session: 'r', host: 'daniel-server', ts: now - 5 });
  const { env, home } = makeEnv({ remote });
  stateFile(home, 'local', { pane: '1', state: 'working', cwd: 'C:\\x\\localbody', session: 'local', host: HOST, ts: now - 5 });
  const r = run(env, ['--body']);
  const out = stripAnsi(r.out);
  assert.strictEqual(r.code, 0);
  assert.match(out, /WORKING/);
  assert.match(out, /NEEDS INPUT/);
  assert.match(out, /localbody/, 'local session must render in --body');
  assert.match(out, /remotebody/, 'cached homelab session must render in --body');
});

// ---- activation: locator-direct + legacy fallback -----------------------
test('selecting a legacy row (no locator) activates the cwd-correlated pane', { skip }, () => {
  const list = JSON.stringify([pane(7, 'file:///C:/Users/daniel/My_Vault', 'Claude — task')]);
  const { env, activateLog } = makeEnv({ list });
  // 6-field KEY (no kind/locator) mimics a pre-rename row -> legacy cwd-correlation.
  const pick = [cardKey([HOST, 'C:\\Users\\daniel\\My_Vault', 'working', '0', 'task', '7']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  assert.match(fs.readFileSync(activateLog, 'utf8'), /^7$/m, 'activate-pane called with the resolved id');
});

test('selecting a row with a wezterm locator activates it directly (no list)', { skip }, () => {
  // Empty mux list: if activation used cwd-correlation it would find nothing. It must
  // use the stored locator instead.
  const { env, activateLog } = makeEnv({ list: '[]' });
  const pick = [cardKey([HOST, 'C:\\repos\\airflow', 'working', '0', 'airflow', '9', 'sandbox', 'wezterm:9']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  assert.match(fs.readFileSync(activateLog, 'utf8'), /^9$/m, 'activate-pane called directly with the locator id');
});

test('a LOCAL row with a 4-field tmux locator dispatches select-pane', { skip }, () => {
  const { env, tmuxLog } = makeEnv({ list: '[]' });
  // host == HOST (selfhost) -> local activation path; locator has socket:session:pane.
  const pick = [cardKey([HOST, '/home/ubuntu/proj', 'working', '0', 'proj', '%3', 'sandbox', 'tmux:/tmp/tmux-1000/default:sess:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /select-pane -t %3/, 'tmux backend focuses the captured pane');
});

test('a LOCAL tmux row, NOT inside tmux -> attaches the session (switch-client cannot)', { skip }, () => {
  const { env, tmuxLog } = makeEnv({ list: '[]' });   // makeEnv deletes TMUX -> a bare shell
  const pick = [cardKey([HOST, '/home/ubuntu/proj', 'working', '0', 'proj', '%3', 'sandbox', 'tmux:/tmp/tmux-1000/default:sess:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /attach-session -t sess/, 'a bare shell has no client to switch, so it attaches');
  assert.doesNotMatch(log, /switch-client/, 'switch-client would fail with "no current client"');
});

test('a LOCAL tmux row, INSIDE tmux -> switches the existing client (no attach)', { skip }, () => {
  const { env, tmuxLog } = makeEnv({ list: '[]' });
  const pick = [cardKey([HOST, '/home/ubuntu/proj', 'working', '0', 'proj', '%3', 'sandbox', 'tmux:/tmp/tmux-1000/default:sess:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick, TMUX: '/tmp/tmux-1000/default,1,0' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /switch-client -t %3/, 'inside tmux, move the current client to the pane');
  assert.doesNotMatch(log, /attach-session/, 'never spawn a nested attach from inside tmux');
});

// Round-trip through the REAL renderer (build_pretty), which the stubbed-fzf tests skip.
// Sandbox rows have an empty pane; a tab-collapsing read would shift locator out of the
// KEY's 8th field and the jump would silently fall through.
test('a sandbox row with an EMPTY pane keeps the locator at KEY field 8 (no tab-collapse)', { skip }, () => {
  const { env, home } = makeEnv({ list: '[]' });
  const loc = 'tmux:/tmp/tmux-1000/default:sb-proj-1:%0';
  stateFile(home, 'sb-proj-1', {
    key: 'sb-proj-1', kind: 'sandbox', cwd: '/home/ubuntu/proj', title: 'proj (sandbox)',
    state: 'working', host: HOST, ts: nowSec(), backend: 'tmux', locator: loc, pane: '', run: 'sb-proj-1-x',
  });
  const { out } = run(env, ['--body']);
  const line = out.split('\n').find((l) => l.includes('proj (sandbox)'));
  assert.ok(line, `the sandbox row rendered (body=${JSON.stringify(out)})`);
  const fields = line.split('\t')[0].split(US);
  assert.strictEqual(fields[7], loc, `locator must land in KEY field 8; got ${JSON.stringify(fields)}`);
});

test('REMOTE tmux row, WEZTERM_PANE set -> WezTerm spawns an ssh-attach tab', { skip }, () => {
  const { env, spawnLog, activateLog } = makeEnv({ list: '[]' });
  // host != selfhost (daniel-server) -> remote attach, NOT local activation. Not inside
  // tmux, but WEZTERM_PANE is set so `wezterm cli spawn` can target a pane -> a GUI tab.
  const pick = [cardKey(['daniel-server', '/home/ubuntu/airflow', 'working', '0', 'airflow', '%3', 'host', 'tmux:/tmp/tmux-1000/default:airflow:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick, WEZTERM_PANE: '0' });
  const spawned = fs.readFileSync(spawnLog, 'utf8');
  assert.match(spawned, /spawn -- ssh -t daniel-server/, 'spawns a local tab ssh-ing to the remote');
  assert.match(spawned, /attach -t 'airflow'/, 'attaches the target tmux session');
  assert.match(spawned, /select-pane -t '%3'/, 'lands on the captured pane');
  assert.strictEqual(fs.readFileSync(activateLog, 'utf8'), '', 'must NOT activate a remote pane locally');
});

test('REMOTE tmux row, no tmux and no WEZTERM_PANE -> exec ssh -t attach in place', { skip }, () => {
  const { env, sshLog, spawnLog, activateLog } = makeEnv({ list: '[]' });
  // Bare WSL shell: no $TMUX, and `wezterm cli spawn` can't work without $WEZTERM_PANE, so
  // the attach must run in the CURRENT terminal (exec ssh) rather than silently no-op.
  const pick = [cardKey(['daniel-server', '/home/ubuntu/airflow', 'working', '0', 'airflow', '%3', 'host', 'tmux:/tmp/tmux-1000/default:airflow:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  const ssh = fs.readFileSync(sshLog, 'utf8');
  assert.match(ssh, /-t daniel-server/, 'ssh -t to the remote host');
  assert.match(ssh, /attach -t 'airflow'/, 'attaches the target session in place');
  assert.match(ssh, /select-pane -t '%3'/, 'lands on the captured pane');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn without WEZTERM_PANE');
  assert.strictEqual(fs.readFileSync(activateLog, 'utf8'), '', 'no local activation of a remote pane');
});

test('REMOTE tmux row, INSIDE tmux -> portable `tmux new-window` (no wezterm)', { skip }, () => {
  const { env, tmuxLog, spawnLog } = makeEnv({ list: '[]' });
  const pick = [cardKey(['daniel-server', '/home/ubuntu/airflow', 'working', '0', 'airflow', '%3', 'host', 'tmux:/tmp/tmux-1000/default:airflow:%3']), 'display'].join('\t');
  // $TMUX set -> the picker is running inside tmux -> open a new tmux window instead of
  // a WezTerm tab (works under Ghostty / WSL / bare ssh — the unification lever).
  run(env, [], { FZF_PICK: pick, TMUX: '/tmp/tmux-1000/default,1,0' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /new-window -n airflow/, 'opens a new tmux window for the attach');
  assert.match(log, /ssh -t daniel-server/, 'the window runs the ssh-attach');
  assert.match(log, /attach -t 'airflow'/, 'attaches the target session');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'must NOT use wezterm spawn when inside tmux');
});

test('a REMOTE row with a non-tmux locator does not activate locally', { skip }, () => {
  const { env, spawnLog, activateLog } = makeEnv({ list: '[]' });
  const pick = [cardKey(['daniel-server', '/x', 'working', '0', 't', '1', 'host', 'none:']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no spawn for a non-tmux remote');
  assert.strictEqual(fs.readFileSync(activateLog, 'utf8'), '', 'no local activation of a remote pane');
});

// ---- reliability --------------------------------------------------------
test('exits with a clear error when a required tool is missing', { skip }, () => {
  const { env } = makeEnv();
  const bare = scratch('av-bare-');           // PATH with none of jq/fzf
  const r = run(env, [], { PATH: bare });
  assert.notStrictEqual(r.code, 0, 'must exit non-zero when a tool is missing');
  assert.match(`${r.out}${r.err}`, /agentview:.*not found/i);
});

test('prunes long-dead local state files from disk', { skip }, () => {
  const { env, home } = makeEnv();
  const dead = path.join(home, '.claude', 'agent-view', 'dead.json');
  stateFile(home, 'dead', { pane: '9', state: 'completed', cwd: 'C:\\z\\zombie', session: 'dead', host: HOST, ts: nowSec() - 8 * 86400 });
  run(env, []);
  assert.ok(!fs.existsSync(dead), 'a state file untouched for >7 days should be removed');
});

// ---- --remove (Ctrl+X: drop a session from the view) --------------------
const avFile = (home, sid) => path.join(home, '.claude', 'agent-view', `${sid}.json`);

test('--remove deletes the local file matching the row locator, leaving others', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'keep', { kind: 'sandbox', cwd: '/r/keep', state: 'working', host: HOST, ts: now, locator: 'tmux:/s:sess-keep:%1' });
  stateFile(home, 'gone', { kind: 'sandbox', cwd: '/r/gone', state: 'working', host: HOST, ts: now, locator: 'tmux:/s:sess-gone:%2' });
  const key = cardKey([HOST, '/r/gone', 'working', String(now), 'gone', '%2', 'sandbox', 'tmux:/s:sess-gone:%2']);
  assert.strictEqual(run(env, ['--remove', key]).code, 0);
  assert.ok(!fs.existsSync(avFile(home, 'gone')), 'the selected session file is removed');
  assert.ok(fs.existsSync(avFile(home, 'keep')), 'a different session (different locator) is untouched');
});

test('--remove matches a legacy row (no locator) by host+cwd+kind', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'legacy', { kind: 'host', cwd: '/r/legacy', state: 'working', host: HOST, ts: now, locator: '' });
  const key = cardKey([HOST, '/r/legacy', 'working', String(now), 't', '1', 'host', '']); // empty locator field
  assert.strictEqual(run(env, ['--remove', key]).code, 0);
  assert.ok(!fs.existsSync(avFile(home, 'legacy')), 'a locator-less legacy row falls back to cwd/host/kind match');
});

test('--remove of a remote (non-self host) row leaves local files untouched', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'localkeep', { kind: 'host', cwd: '/r/localkeep', state: 'working', host: HOST, ts: now, locator: 'tmux:/s:x:%1' });
  const key = cardKey(['daniel-server', '/home/ubuntu/remote', 'working', String(now), 't', '1', 'host', 'tmux:/s:remote:%9']);
  assert.strictEqual(run(env, ['--remove', key]).code, 0);
  assert.ok(fs.existsSync(avFile(home, 'localkeep')), 'a remote row has no local file — nothing is deleted here');
});

test('--remove of a remote row filters it out of the ssh-snapshot cache, keeping others', { skip }, () => {
  const now = nowSec();
  const gone = JSON.stringify({ kind: 'host', cwd: '/r/rgone', state: 'working', host: 'daniel-server', ts: now, locator: 'tmux:/s:rgone:%2' });
  const keep = JSON.stringify({ kind: 'host', cwd: '/r/rkeep', state: 'working', host: 'daniel-server', ts: now, locator: 'tmux:/s:rkeep:%1' });
  const { env, home } = makeEnv({ remote: `${gone}\n${keep}` });
  const cache = path.join(home, '.agentview-remote-cache');
  const key = cardKey(['daniel-server', '/r/rgone', 'working', String(now), 'rgone', '%2', 'host', 'tmux:/s:rgone:%2']);
  assert.strictEqual(run(env, ['--remove', key]).code, 0);
  const after = fs.readFileSync(cache, 'utf8');
  assert.doesNotMatch(after, /rgone/, 'the removed remote session is filtered from the cache');
  assert.match(after, /rkeep/, 'other remote sessions stay in the cache');
});

test('after removing a remote row, --body no longer renders it', { skip }, () => {
  const now = nowSec();
  const gone = JSON.stringify({ kind: 'host', cwd: '/home/ubuntu/rgonebody', state: 'working', host: 'daniel-server', ts: now, locator: 'tmux:/s:gb:%2' });
  const keep = JSON.stringify({ kind: 'host', cwd: '/home/ubuntu/rkeepbody', state: 'working', host: 'daniel-server', ts: now, locator: 'tmux:/s:kb:%1' });
  const { env } = makeEnv({ remote: `${gone}\n${keep}` });
  const key = cardKey(['daniel-server', '/home/ubuntu/rgonebody', 'working', String(now), 'rgonebody', '%2', 'host', 'tmux:/s:gb:%2']);
  assert.strictEqual(run(env, ['--remove', key]).code, 0);
  const out = stripAnsi(run(env, ['--body']).out);
  assert.doesNotMatch(out, /rgonebody/, 'the removed remote row is gone from the rendered body');
  assert.match(out, /rkeepbody/, 'the other remote row still renders');
});

test('--remove with an empty KEY (group header / spacer row) deletes nothing', { skip }, () => {
  const { env, home } = makeEnv();
  stateFile(home, 'safe', { kind: 'sandbox', cwd: '/r/safe', state: 'working', host: HOST, ts: nowSec(), locator: 'tmux:/s:safe:%1' });
  assert.strictEqual(run(env, ['--remove', '']).code, 0);
  assert.ok(fs.existsSync(avFile(home, 'safe')), 'an empty KEY must never match a real session');
});

test('picker binds ctrl-x to --remove and hints it in the footer', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /ctrl-x:execute-silent\([^)]*--remove {1}/, 'ctrl-x runs agentview --remove on the selected KEY');
  assert.match(src, /reload\(/, 'removal reloads the body so the row disappears');
  assert.match(src, /⌃x remove/, 'footer advertises the remove action');
});

// ---- state coloring (yellow=needs-input, green=working, grey=completed) --
// The group-header label and each session name are tinted by state; fzf preserves
// per-token ANSI on the current line, so --highlight-line makes the hovered row show
// that color. These assert on the RAW capture — the ANSI codes ARE the thing under test.
const SC = { need: '38;2;249;226;175', work: '38;2;166;227;161', done: '38;2;108;112;134' };

test('group-header labels are tinted by their state color (bold)', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'w', { pane: '1', state: 'working',     cwd: 'C:\\a\\wproj', host: HOST, ts: now - 5 });
  stateFile(home, 'n', { pane: '2', state: 'needs-input', cwd: 'C:\\b\\nproj', host: HOST, ts: now - 6 });
  stateFile(home, 'c', { pane: '3', state: 'completed',   cwd: 'C:\\c\\cproj', host: HOST, ts: now - 7 });
  run(env, []);
  const raw = fs.readFileSync(capture, 'utf8');
  assert.match(raw, new RegExp(`\\x1b\\[1m\\x1b\\[${SC.work}mWORKING`), 'WORKING header is bold green');
  assert.match(raw, new RegExp(`\\x1b\\[1m\\x1b\\[${SC.need}mNEEDS INPUT`), 'NEEDS INPUT header is bold yellow');
  assert.match(raw, new RegExp(`\\x1b\\[1m\\x1b\\[${SC.done}mCOMPLETED`), 'COMPLETED header is bold grey');
  assert.doesNotMatch(raw, /38;2;180;190;254/, 'header no longer uses the old lavender');
});

test('session names are tinted by their state color', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'w', { pane: '1', state: 'working',     cwd: 'C:\\a\\greenname',  host: HOST, ts: now - 5 });
  stateFile(home, 'n', { pane: '2', state: 'needs-input', cwd: 'C:\\b\\yellowname', host: HOST, ts: now - 6 });
  stateFile(home, 'c', { pane: '3', state: 'completed',   cwd: 'C:\\c\\greyname',   host: HOST, ts: now - 7 });
  run(env, []);
  const raw = fs.readFileSync(capture, 'utf8');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.work}mgreenname`), 'working session name is green');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.need}myellowname`), 'needs-input session name is yellow');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.done}mgreyname`), 'completed session name is grey');
});

test('picker highlights the whole current line so the state color reads on hover', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /--highlight-line/, 'the current row gets a full-width highlight bar');
});

// ---- source badges rendered as rounded pills (boxes) --------------------
// The machine source (PC / homelab) is wrapped in powerline half-circle caps
// (U+E0B6  … U+E0B4 ) so it reads as a rounded box. Assert the caps enclose the label.
test('machine source badges render as rounded pills (boxed)', { skip }, () => {
  const { env, home, capture } = makeEnv();
  stateFile(home, 'w', { pane: '1', state: 'working', cwd: 'C:\\a\\vaultproj', host: HOST, ts: nowSec() - 5 });
  run(env, []);
  const raw = fs.readFileSync(capture, 'utf8');
  assert.match(raw, /\ue0b6/, 'left rounded cap present');
  assert.match(raw, /\ue0b4/, 'right rounded cap present');
  assert.match(raw, /\ue0b6[^\n]*?PC[^\n]*?\ue0b4/, 'the pill encloses the PC source label');
  // Tight body: caps hug the label directly — no icon, no inner padding.
  assert.match(raw, /\x1b\[38;2;137;180;250mPC\x1b\[0m/, 'PC pill hugs the label tight');
});

// ---- per-group left accent rule (\u258e, state-colored) ----------------------
test('each group carries a state-colored left accent rule', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'n', { pane: '1', state: 'needs-input', cwd: 'C:\\a\\nbar', host: HOST, ts: now - 5 });
  stateFile(home, 'w', { pane: '2', state: 'working',     cwd: 'C:\\a\\wbar', host: HOST, ts: now - 6 });
  stateFile(home, 'c', { pane: '3', state: 'completed',   cwd: 'C:\\a\\cbar', host: HOST, ts: now - 3600 });
  run(env, []);
  const raw = fs.readFileSync(capture, 'utf8');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.need}m\u258e`), 'needs-input rows carry a yellow accent rule');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.work}m\u258e`), 'working rows carry a green accent rule');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.done}m\u258e`), 'completed rows carry a grey accent rule');
});

// ---- fit narrow windows: slim margins + trimmed footer ------------------
test('picker slims margins and trims the footer to fit narrow windows', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /--margin=1,2%/, 'side margins are slimmed to reclaim width');
  assert.doesNotMatch(src, /state from Claude Code hooks/, 'the long footer tagline is dropped');
  assert.match(src, /⌃x remove/, 'the key hints stay in the trimmed footer');
});

// ---- right column: task title, else age (never the redundant state word) --
test('the right column shows the task title, or the age — never the state word', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'titled', { pane: '1', state: 'needs-input', cwd: 'C:\\a\\proj1', host: HOST, ts: now - 120, title: 'Fixing the parser' });
  stateFile(home, 'bare',   { pane: '2', state: 'working',     cwd: 'C:\\a\\proj2', host: HOST, ts: now - 300 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /Fixing the parser/, 'a captured title shows in the right column');
  assert.match(body, /5m/, 'a title-less row shows its age instead of the state word');
  assert.doesNotMatch(body, /needs input/, 'no redundant lowercase "needs input" in a row');
  assert.doesNotMatch(body, /·\s+working\b/, 'no redundant "working" in a row');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
