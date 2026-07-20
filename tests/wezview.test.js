// Characterization + regression guard for executable_wezview (the WezTerm
// Agent-View fzf picker). Drives the ACTUAL script with stub `wezterm`/`ssh`/`fzf`/
// `hostname` on PATH and a temp $HOME of state files, so it's hermetic — no real
// mux, no network, no TTY. Real jq/coreutils are used. Skips without bash/jq.
//
// Modes exercised without a TTY:
//   --card KEY     deterministic preview render (KEY = US-delimited card fields)
//   --resolve KEY  cwd-correlation to a client pane id
//   (default)      builds the grouped body, pipes it to `fzf` (stubbed to capture)
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIEW = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_wezview');
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
// The row KEY (and the --card arg) is just the card fields joined by US — no base64.
const cardKey = (fields) => fields.join(US);

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// A hermetic environment: a stub-bin dir (wezterm/ssh/fzf/hostname) + a temp HOME.
function makeEnv({ list = '[]', remote = '' } = {}) {
  const bin = scratch('wv-bin-');
  const home = scratch('wv-home-');
  fs.mkdirSync(path.join(home, '.claude', 'wez-state'), { recursive: true });
  const listFile = path.join(bin, 'list.json'); fs.writeFileSync(listFile, list);
  const remoteFile = path.join(bin, 'remote.json'); fs.writeFileSync(remoteFile, remote);
  // The picker now reads homelab sessions from the cache file (the background ssh
  // refreshes it + live-reloads fzf); seed it directly so the initial render sees them.
  const cacheFile = path.join(home, '.wezview-remote-cache');
  if (remote) fs.writeFileSync(cacheFile, remote);
  const activateLog = path.join(bin, 'activate.log'); fs.writeFileSync(activateLog, '');
  const capture = path.join(bin, 'fzf-capture.txt'); fs.writeFileSync(capture, '');

  fs.writeFileSync(path.join(bin, 'wezterm'), `#!/bin/bash
case "$*" in
  *list*) cat "$WEZ_LIST_FILE" 2>/dev/null ;;
  *activate-pane*) prev=""; for a in "$@"; do [ "$prev" = "--pane-id" ] && echo "$a" >> "$WEZ_ACTIVATE_LOG"; prev="$a"; done ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
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

  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    WEZ_LIST_FILE: listFile, SSH_REMOTE_FILE: remoteFile,
    WEZ_ACTIVATE_LOG: activateLog, FZF_CAPTURE: capture,
  };
  return { bin, home, env, listFile, remoteFile, activateLog, capture };
}

function stateFile(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'wez-state', `${sid}.json`), JSON.stringify(obj));
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
  const blob = cardKey([HOST, 'C:\\Users\\daniel\\My_Vault', 'working', String(ts), 'fixing the parser', '7']);
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
  const blob = cardKey(['daniel-server', '/home/ubuntu/proj', 'needs-input', '0', '', '1']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, /Machine\s+homelab · daniel-server/);
  assert.match(txt, /State\s+needs input/);
});

// ---- --resolve (cwd correlation) ----------------------------------------
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
  run(env, []); // fzf stub exits 0 with no pick -> wezview exits after capture
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /WORKING/);
  assert.match(body, /NEEDS INPUT/);
  assert.match(body, /COMPLETED/);
  assert.match(body, /alpha/); assert.match(body, /bravo/); assert.match(body, /charlie/);
  assert.doesNotMatch(body, /staleone/, 'session older than a day must be hidden');
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

test('selecting a row activates the correlated client pane', { skip }, () => {
  const list = JSON.stringify([pane(7, 'file:///C:/Users/daniel/My_Vault', 'Claude — task')]);
  const { env, activateLog } = makeEnv({ list });
  // A row is KEY<TAB>DISPLAY now; the KEY carries the 6 card fields (field 2 = cwd).
  const pick = [cardKey([HOST, 'C:\\Users\\daniel\\My_Vault', 'working', '0', 'task', '7']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  assert.match(fs.readFileSync(activateLog, 'utf8'), /^7$/m, 'activate-pane called with the resolved id');
});

// ---- RED: new reliability behavior --------------------------------------
test('exits with a clear error when a required tool is missing', { skip }, () => {
  const { env } = makeEnv();
  const bare = scratch('wv-bare-');           // PATH with none of jq/wezterm/fzf
  const r = run(env, [], { PATH: bare });
  assert.notStrictEqual(r.code, 0, 'must exit non-zero when a tool is missing');
  assert.match(`${r.out}${r.err}`, /wezview:.*not found/i);
});

test('prunes long-dead local state files from disk', { skip }, () => {
  const { env, home } = makeEnv();
  const dead = path.join(home, '.claude', 'wez-state', 'dead.json');
  stateFile(home, 'dead', { pane: '9', state: 'completed', cwd: 'C:\\z\\zombie', session: 'dead', host: HOST, ts: nowSec() - 8 * 86400 });
  run(env, []);
  assert.ok(!fs.existsSync(dead), 'a state file untouched for >7 days should be removed');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
