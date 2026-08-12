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
const { agentviewWinSeams } = require('../lib/agentview-env');

const VIEW = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_agentview');
// The footer is built at startup from render.sh's AV_HINTS (width-aware), so the hint
// strings live there rather than in the picker's flags.
const RENDER = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview', 'render.sh');
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
  // The picker reads homelab sessions from a per-host cache file (the background ssh
  // refreshes it + live-reloads fzf); seed daniel-server's so the initial render sees them.
  // Fixtures below all use host: 'daniel-server'.
  const cacheFile = path.join(home, '.agentview-remote-cache.daniel-server');
  if (remote) fs.writeFileSync(cacheFile, remote);
  const activateLog = path.join(bin, 'activate.log'); fs.writeFileSync(activateLog, '');
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const spawnLog = path.join(bin, 'spawn.log'); fs.writeFileSync(spawnLog, '');
  const capture = path.join(bin, 'fzf-capture.txt'); fs.writeFileSync(capture, '');
  const fzfArgs = path.join(bin, 'fzf-args.txt'); fs.writeFileSync(fzfArgs, '');
  const paneTextFile = path.join(bin, 'pane-text.txt'); fs.writeFileSync(paneTextFile, '');

  // WEZ_TEXT_FILE seeds what `get-text` returns, i.e. what the pane is currently showing —
  // the card's pane tail reads it. Absent file = a pane that captures as nothing.
  fs.writeFileSync(path.join(bin, 'wezterm'), `#!/bin/bash
case "$*" in
  *list*) cat "$WEZ_LIST_FILE" 2>/dev/null ;;
  *get-text*) cat "\${WEZ_TEXT_FILE:-/dev/null}" 2>/dev/null ;;
  *activate-pane*) prev=""; for a in "$@"; do [ "$prev" = "--pane-id" ] && echo "$a" >> "$WEZ_ACTIVATE_LOG"; prev="$a"; done ;;
  *spawn*) echo "$*" >> "$WEZ_SPAWN_LOG" ;;
esac
exit 0
`, { mode: 0o755 });
  // tmux stub with a window registry, mirroring agentview-actions.test.js: `select-window`
  // only succeeds for a window some earlier `new-window` created. The picker's reuse paths
  // are built on that failure, so a stub that exits 0 unconditionally would report reuse for
  // windows that never existed and hide whether a window is ever actually opened.
  // Registry rows are `<session>:<index>\t<name>` — the same shape real tmux prints for the
  // `list-windows -a -F` the reuse lookup runs. A flat name-only registry cannot model the
  // session scoping that made `-t "=name"` miss, so it would pass either implementation.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "$TMUX_LOG"
wins="$TMUX_LOG.wins"; touch "$wins"
sess="\${AV_TMUX_SESSION:-0}"
opts="$TMUX_LOG.opts"; touch "$opts"
case "$1" in
  display-message)
    case "$3" in *window_id*) tail -n1 "$wins" | cut -f2 ;; *) echo "$sess" ;; esac; exit 0 ;;
  list-windows)  cat "$wins"; exit 0 ;;
  select-window) cut -f2 "$wins" | grep -qxF "$3" && exit 0; exit 1 ;;
  # $(( )) strips the leading pad BSD wc -l writes. An unstripped "@       0" is not the @N
  # shape the reuse lookup and its assertions match, so this only fails off GNU coreutils.
  new-window)    printf '%s\\t@%s\\t%s\\n' "$sess" "$(( $(wc -l < "$wins") ))" "$3" >> "$wins" ;;
  show-options)  awk -F'\\t' -v w="$5" '$1==w{print $2}' "$opts"; exit 0 ;;
  set-option)    awk -F'\\t' -v w="$4" '$1!=w' "$opts" > "$opts.t"; mv "$opts.t" "$opts"
                 printf '%s\\t%s\\n' "$4" "$6" >> "$opts"; exit 0 ;;
  respawn-pane)  exit 0 ;;
esac
case " $* " in *" capture-pane "*) cat "\${TMUX_TEXT_FILE:-/dev/null}" 2>/dev/null ;; esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
echo "$*" >> "$SSH_LOG"
# When agentview asks for a remote shell (bash -s) AND a fake remote HOME is provided,
# run the piped script against it — exercises the remote-side live-registry fold. Otherwise
# behave like the old stub and just cat the canned snapshot (every pre-existing test path).
if [ -n "\${SSH_REMOTE_HOME:-}" ] && printf ' %s ' "$*" | grep -q -- ' -s '; then
  HOME="$SSH_REMOTE_HOME" bash -s
else
  cat "$SSH_REMOTE_FILE" 2>/dev/null
fi
exit 0
`, { mode: 0o755 });
  // Args as well as stdin: the list arrives on stdin, but the header/footer/binds are flags,
  // so anything asserting on those needs the argv.
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash
printf '%s\\n' "$*" > "$FZF_ARGS"
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
  const seams = agentviewWinSeams({ bin, scratch });
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    ...seams.env,
    WEZ_LIST_FILE: listFile, SSH_REMOTE_FILE: remoteFile, SSH_LOG: sshLog,
    WEZ_ACTIVATE_LOG: activateLog, TMUX_LOG: tmuxLog, WEZ_SPAWN_LOG: spawnLog, FZF_CAPTURE: capture,
    FZF_ARGS: fzfArgs,
    WEZ_TEXT_FILE: paneTextFile, TMUX_TEXT_FILE: paneTextFile,
  };
  delete env.TMUX;          // never let the test host's tmux socket leak into detection
  delete env.WEZTERM_PANE;  // nor its WezTerm pane id — remote-attach branches on it
  delete env.WSL_DISTRO_NAME; // nor its WSL-ness, which would route the cli to the real wezterm.exe
  return { bin, home, env, listFile, remoteFile, activateLog, tmuxLog, spawnLog, sshLog, capture, paneTextFile, fzfArgs };
}

function stateFile(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
function run(env, args, extraEnv = {}, input = '') {
  try {
    return { out: execFileSync(BASH, [VIEW, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv }, input,
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

// ---- --card pane tail (what the session is actually showing) ------------
test('--card shows the tail of the pane, so a blocked agent\'s question is readable in the list', { skip }, () => {
  const { env, paneTextFile } = makeEnv();
  fs.writeFileSync(paneTextFile, [
    'Reading src/parser.ts',
    'Do you want me to rewrite the tokenizer? (y/n)',
    '', '', '',            // captured panes are mostly trailing blank rows
  ].join('\n'));
  const blob = cardKey([HOST, '/r/p', 'needs-input', String(nowSec()), 'parser', '7', 'host', 'wezterm:7']);
  const txt = stripAnsi(run(env, ['--card', blob], { FZF_PREVIEW_COLUMNS: '80' }).out);
  assert.match(txt, /Pane/, 'the card grew a pane section');
  assert.match(txt, /Do you want me to rewrite the tokenizer\? \(y\/n\)/, 'the question itself reaches the card');
  assert.doesNotMatch(txt, /Pane\n\s*\n\s*\n/, 'trailing blank rows are trimmed off the tail');
});

test('--card truncates a pane line to the preview width instead of wrapping it', { skip }, () => {
  const { env, paneTextFile } = makeEnv();
  fs.writeFileSync(paneTextFile, `${'y'.repeat(200)}\n`);
  const blob = cardKey([HOST, '/r/p', 'working', String(nowSec()), '', '7', 'host', 'wezterm:7']);
  const txt = stripAnsi(run(env, ['--card', blob], { FZF_PREVIEW_COLUMNS: '40' }).out);
  const line = txt.split('\n').find((l) => l.includes('yyy'));
  assert.ok(line.length <= 40, `pane line must fit the preview, got ${line.length}`);
  assert.match(line, /…$/, 'and says it was cut');
});

test('--card takes a tmux row\'s tail from capture-pane, not from wezterm', { skip }, () => {
  const { env, paneTextFile, tmuxLog } = makeEnv();
  fs.writeFileSync(paneTextFile, 'waiting on your answer\n');
  const blob = cardKey([HOST, '/r/p', 'needs-input', String(nowSec()), '', '%3', 'host', 'tmux:/s:sc:%3']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, /waiting on your answer/);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /capture-pane -p -t %3/, 'plain capture: no -e, so the pane\'s own escapes stay out');
});

test('--card skips the tail for a REMOTE row: a preview must not do network I/O', { skip }, () => {
  const { env, paneTextFile, sshLog } = makeEnv();
  fs.writeFileSync(paneTextFile, 'remote pane content\n');
  const blob = cardKey(['daniel-server', '/r/p', 'working', String(nowSec()), '', '%3', 'host', 'tmux:/s:sc:%3']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.doesNotMatch(txt, /remote pane content/, 'no tail for a session on another machine');
  assert.strictEqual(fs.readFileSync(sshLog, 'utf8'), '', 'and no ssh was attempted');
});

test('--card tail is suppressed by AGENTVIEW_NO_TAIL', { skip }, () => {
  const { env, paneTextFile } = makeEnv();
  fs.writeFileSync(paneTextFile, 'should not appear\n');
  const blob = cardKey([HOST, '/r/p', 'working', String(nowSec()), '', '7', 'host', 'wezterm:7']);
  const txt = stripAnsi(run(env, ['--card', blob], { AGENTVIEW_NO_TAIL: '1' }).out);
  assert.doesNotMatch(txt, /should not appear/);
  assert.doesNotMatch(txt, /Pane/);
});

test('--card has no pane section for a session with no addressable pane', { skip }, () => {
  const { env, paneTextFile } = makeEnv();
  fs.writeFileSync(paneTextFile, 'stale text from some other pane\n');
  const blob = cardKey([HOST, '/r/p', 'idle', String(nowSec()), '', '', 'host', 'none:']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.doesNotMatch(txt, /stale text/, 'a none: locator names no pane, so nothing is captured');
});

test('--card labels a daniel-server session as Homelab', { skip }, () => {
  const { env } = makeEnv();
  const blob = cardKey(['daniel-server', '/home/ubuntu/proj', 'needs-input', '0', '', '1', 'host', 'none:']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, /Machine\s+Homelab · daniel-server/);
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
  // charlie is a live local session, so fold_live_completed_to_idle re-groups it under
  // IDLE, not COMPLETED (task 6 for the fold, this change for the regroup); expand it so
  // charlie's row still renders for the assertion below.
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'idle\n');
  run(env, []); // fzf stub exits 0 with no pick -> agentview exits after capture
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /WORKING/);
  assert.match(body, /NEEDS INPUT/);
  assert.match(body, /IDLE/);
  assert.match(body, /alpha/); assert.match(body, /bravo/); assert.match(body, /charlie/);
  assert.doesNotMatch(body, /staleone/, 'session older than a day must be hidden');
});

// ---- CTRL+G: group by repo instead of by state --------------------------
test('--groupby toggles the sidecar between state and repo, and back', { skip }, () => {
  const { env, home } = makeEnv();
  const gb = path.join(home, '.claude', 'agent-view-groupby');
  run(env, ['--groupby']);
  assert.strictEqual(fs.readFileSync(gb, 'utf8').trim(), 'repo', 'first press leaves state grouping');
  run(env, ['--groupby']);
  assert.strictEqual(fs.readFileSync(gb, 'utf8').trim(), 'state', 'second press returns');
});

test('body in repo mode groups each checkout together instead of by state', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-groupby'), 'repo\n');
  stateFile(home, 'a1', { pane: '1', state: 'working',     cwd: '/r/alpha', session: 'a1', host: HOST, ts: now - 30 });
  stateFile(home, 'a2', { pane: '2', state: 'needs-input', cwd: '/r/alpha', session: 'a2', host: HOST, ts: now - 10 });
  stateFile(home, 'b1', { pane: '3', state: 'completed',   cwd: '/r/bravo', session: 'b1', host: HOST, ts: now - 20 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.doesNotMatch(body, /NEEDS INPUT/, 'state headers give way to repo headers');
  const headers = body.split('\n').filter((l) => /●/.test(l)).map((l) => l.replace(/^\s*▎?\s*●\s*/, '').trim());
  assert.deepStrictEqual(headers, ['alpha 2', 'bravo 1'], 'one header per repo, alphabetical, with its count');
});

test('body in repo mode puts the session that needs you at the top of its repo', { skip }, () => {
  // Newest-first alone would bury a question under a session that merely printed something
  // more recently — the ordering exists so a group is scannable, not chronological.
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-groupby'), 'repo\n');
  stateFile(home, 'q', { pane: '1', state: 'needs-input', cwd: '/r/alpha', title: 'asking', session: 'q', host: HOST, ts: now - 300 });
  stateFile(home, 'w', { pane: '2', state: 'working', cwd: '/r/alpha', title: 'busy', session: 'w', host: HOST, ts: now - 5 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.ok(body.indexOf('asking') < body.indexOf('busy'), 'the needs-input row leads its group');
});

test('body in repo mode keeps PINNED as its own group at the top', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-groupby'), 'repo\n');
  stateFile(home, 'p1', { pane: '1', state: 'working', cwd: '/r/alpha', session: 'p1', host: HOST, ts: now - 10, locator: 'wezterm:1' });
  stateFile(home, 'p2', { pane: '2', state: 'working', cwd: '/r/bravo', session: 'p2', host: HOST, ts: now - 20, locator: 'wezterm:2' });
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-pins'), 'wezterm:2\n');
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /PINNED/);
  assert.ok(body.indexOf('PINNED') < body.indexOf('alpha'), 'pins stay above the repo groups');
  assert.doesNotMatch(body, /bravo 1/, 'a pinned row is not also counted under its repo');
});

// ---- per-session resource usage (sampled by the refresh job, shown on the card) ----
const procSkip = skip || (fs.existsSync('/proc/self/stat') ? false : 'no procfs');
test('--refresh-remote samples a live session\'s process tree into the usage cache', { skip: procSkip }, () => {
  const { env, home } = makeEnv();
  const child = require('node:child_process').spawn('sleep', ['5'], { stdio: 'ignore' });
  try {
    stateFile(home, 'u1', {
      session: 'u1', host: HOST, cwd: '/r/measured', kind: 'host', locator: 'wezterm:42',
      state: 'working', ts: nowSec(), pid: String(child.pid),
    });
    run(env, ['--refresh-remote']);
    const cache = fs.readFileSync(path.join(home, '.agentview-usage-cache'), 'utf8');
    const line = cache.split('\n').find((l) => l.startsWith('wezterm:42'));
    assert.ok(line, `expected a usage line keyed by the row identity, got:\n${cache}`);
    const [, cpu, mem] = line.split('\t');
    assert.match(cpu, /^\d+$/, 'cpu is a whole percent');
    assert.ok(Number(mem) >= 0, 'rss in MB');
  } finally { child.kill(); }
});

test('usage for an AMBIGUOUS row identity is not attributed to either session', { skip: procSkip }, () => {
  // Background sessions started without a real pane all record the same locator, so two live
  // sessions can share one identity. Keyed lookup would hand a row its neighbour's numbers.
  const { env, home } = makeEnv();
  const cp = require('node:child_process');
  const a = cp.spawn('sleep', ['5'], { stdio: 'ignore' });
  const b = cp.spawn('sleep', ['5'], { stdio: 'ignore' });
  try {
    for (const [sid, pid] of [['ua', a.pid], ['ub', b.pid]]) {
      stateFile(home, sid, {
        session: sid, host: HOST, cwd: '/r/same', kind: 'host', locator: 'wezterm:0',
        state: 'working', ts: nowSec(), pid: String(pid),
      });
    }
    run(env, ['--refresh-remote']);
    const cache = fs.readFileSync(path.join(home, '.agentview-usage-cache'), 'utf8').trim();
    const lines = cache.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, 'both sessions are still measured for the fleet total');
    assert.ok(lines.every((l) => l.startsWith('?\t')), `neither is claimed by a row identity:\n${cache}`);
  } finally { a.kill(); b.kill(); }
});

test('--card shows usage for a row the cache can identify, and omits it otherwise', { skip }, () => {
  const { env, home } = makeEnv();
  fs.writeFileSync(path.join(home, '.agentview-usage-cache'), 'wezterm:42\t7\t512\n?\t3\t256\n');
  const known = cardKey([HOST, '/r/measured', 'working', String(nowSec()), '', '42', 'host', 'wezterm:42']);
  assert.match(stripAnsi(run(env, ['--card', known]).out), /Usage\s+7% cpu · 512 MB/);
  const unknown = cardKey([HOST, '/r/other', 'working', String(nowSec()), '', '9', 'host', 'wezterm:9']);
  assert.doesNotMatch(stripAnsi(run(env, ['--card', unknown]).out), /Usage/);
});

test('the header carries the fleet total, including sessions no row can claim', { skip }, () => {
  const { env, home, fzfArgs } = makeEnv();
  fs.writeFileSync(path.join(home, '.agentview-usage-cache'), 'wezterm:42\t7\t1024\n?\t3\t1024\n');
  stateFile(home, 'h1', { pane: '1', state: 'working', cwd: '/r/alpha', session: 'h1', host: HOST, ts: nowSec() });
  run(env, []);
  const args = fs.readFileSync(fzfArgs, 'utf8');
  assert.match(args, /10% cpu · 2\.0 GB/, 'cpu and memory are summed across every sampled session');
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

// ---- refresh_remote: fold the homelab's OWN live registry over its hook state --------
// A remote session's hook state (~/.claude/agent-view/<sid>.json) lags: an idle/permission
// Notification writes "needs-input" and NO later hook fires when the user merely reads the
// pane, so the picker showed a sticky needs-input. --refresh-remote runs the fold ON the
// remote (ssh bash -s), where Claude's live per-process registry is readable + its pids are
// kill -0-able, and rewrites the cached row's state from the live status. This is the remote
// analog of the LOCAL merge (load_session_map/merge_session_row) covered in bg-sessions.
test('--refresh-remote folds the homelab live registry over a stale needs-input row', { skip }, () => {
  const now = nowSec();
  const { env, home } = makeEnv();                     // no seeded cache: refresh_remote writes it
  const rhome = scratch('av-remote-');                 // the fake remote HOME the ssh stub folds against
  fs.mkdirSync(path.join(rhome, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(rhome, '.claude', 'sessions'), { recursive: true });
  const sid = 'cccc3333-0000-0000-0000-0000000000cc';
  // Stale hook state: needs-input, recorded 5 minutes ago.
  fs.writeFileSync(path.join(rhome, '.claude', 'agent-view', `${sid}.json`),
    JSON.stringify({ key: sid, session: sid, kind: 'host', state: 'needs-input', cwd: '/home/ubuntu/server',
      host: 'daniel-server', ts: now - 300, locator: 'tmux:/tmp/t:main:%2', title: 'Homelab review' }));
  // Live registry: the SAME session is actually busy, updated seconds ago — the truth.
  fs.writeFileSync(path.join(rhome, '.claude', 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: sid, status: 'busy', entrypoint: 'cli',
      updatedAt: (now - 5) * 1000, statusUpdatedAt: (now - 5) * 1000 }));
  run(env, ['--refresh-remote'], { SSH_REMOTE_HOME: rhome });
  const folded = fs.readFileSync(path.join(home, '.agentview-remote-cache.daniel-server'), 'utf8');
  const row = JSON.parse(folded.trim().split('\n').filter(Boolean)[0]);
  assert.strictEqual(row.state, 'working', 'live busy status overrides the stale needs-input hook state');
  assert.strictEqual(row.locator, 'tmux:/tmp/t:main:%2', 'hook identity fields (locator) survive the fold');
  assert.strictEqual(row.title, 'Homelab review', 'the /rename title survives the fold');
});

// A dead-pid registry entry must NOT override — a leaked stale session can't resurrect a row.
test('--refresh-remote ignores a dead-pid registry entry and keeps the hook state', { skip }, () => {
  const now = nowSec();
  const { env, home } = makeEnv();
  const rhome = scratch('av-remote-');
  fs.mkdirSync(path.join(rhome, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(rhome, '.claude', 'sessions'), { recursive: true });
  const sid = 'dddd4444-0000-0000-0000-0000000000dd';
  fs.writeFileSync(path.join(rhome, '.claude', 'agent-view', `${sid}.json`),
    JSON.stringify({ key: sid, session: sid, kind: 'host', state: 'needs-input', cwd: '/home/ubuntu/server',
      host: 'daniel-server', ts: now - 300, locator: 'tmux:/tmp/t:main:%2', title: 'Homelab review' }));
  fs.writeFileSync(path.join(rhome, '.claude', 'sessions', `33554432.json`),   // pid beyond pid_max -> dead
    JSON.stringify({ pid: 33554432, sessionId: sid, status: 'busy', entrypoint: 'cli', updatedAt: (now - 5) * 1000 }));
  run(env, ['--refresh-remote'], { SSH_REMOTE_HOME: rhome });
  const folded = fs.readFileSync(path.join(home, '.agentview-remote-cache.daniel-server'), 'utf8');
  const row = JSON.parse(folded.trim().split('\n').filter(Boolean)[0]);
  assert.strictEqual(row.state, 'needs-input', 'a dead-pid registry entry does not override the hook state');
});

// A daemon-hosted homelab session has NO pane anywhere — its hook row is written with a
// none: locator, which the jump path can only reject. The fold already reads the remote live
// registry, so it must do what the local merge does: flip kind to bg and carry the JOB id as
// the focus target, or <enter> on the row reports "no pane found" and nothing opens.
test('--refresh-remote marks a remote DAEMON session bg and gives it a bg:<jobId> locator', { skip }, () => {
  const now = nowSec();
  const { env, home } = makeEnv();
  const rhome = scratch('av-remote-');
  fs.mkdirSync(path.join(rhome, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(rhome, '.claude', 'sessions'), { recursive: true });
  const sid = 'eeee5555-0000-0000-0000-0000000000ee';
  // What the remote state hook records for a daemon job: no pane, so no locator.
  fs.writeFileSync(path.join(rhome, '.claude', 'agent-view', `${sid}.json`),
    JSON.stringify({ key: sid, session: sid, kind: 'host', state: 'needs-input', cwd: '/home/ubuntu/server',
      host: 'daniel-server', ts: now - 300, backend: 'none', locator: 'none:', title: '' }));
  // The remote live registry knows it is a bg job and knows its jobId — the attach handle.
  fs.writeFileSync(path.join(rhome, '.claude', 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: sid, status: 'waiting', entrypoint: 'cli',
      kind: 'bg', jobId: 'eeee5555', updatedAt: (now - 5) * 1000, statusUpdatedAt: (now - 5) * 1000 }));
  run(env, ['--refresh-remote'], { SSH_REMOTE_HOME: rhome });
  const folded = fs.readFileSync(path.join(home, '.agentview-remote-cache.daniel-server'), 'utf8');
  const row = JSON.parse(folded.trim().split('\n').filter(Boolean)[0]);
  assert.strictEqual(row.kind, 'bg', 'kind routes <enter> to the remote bg attach');
  assert.strictEqual(row.locator, 'bg:eeee5555', 'locator carries the JOB id, not the session uuid');
  assert.strictEqual(row.backend, 'bg', 'backend mirrors the locator prefix');
  assert.strictEqual(row.state, 'needs-input', 'live waiting status still folds into the state');
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

test('REMOTE tmux row, WEZTERM_PANE set -> STILL attaches in place, never a wezterm tab', { skip }, () => {
  const { env, sshLog, spawnLog, activateLog } = makeEnv({ list: '[]' });
  // host != selfhost (daniel-server) -> remote attach, NOT local activation. WEZTERM_PANE is
  // set, which used to divert this to `wezterm cli spawn`. From WSL that binary reaches its own
  // mux rather than the Windows GUI, so the attach landed in a pane no window displays — and
  // because the branch sat ABOVE the exec, setting this var was enough to make <enter> look
  // dead. The picker owns its terminal here, so the attach belongs in THIS tab.
  const pick = [cardKey(['daniel-server', '/home/ubuntu/airflow', 'working', '0', 'airflow', '%3', 'host', 'tmux:/tmp/tmux-1000/default:airflow:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick, WEZTERM_PANE: '0' });
  const ssh = fs.readFileSync(sshLog, 'utf8');
  assert.match(ssh, /-t daniel-server/, 'ssh -t to the remote host, in this terminal');
  assert.match(ssh, /attach -t 'airflow'/, 'attaches the target tmux session');
  assert.match(ssh, /select-pane -t '%3'/, 'lands on the captured pane');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn — it would be invisible');
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
  const line = log.split('\n').find((l) => l.startsWith('new-window -n av:Homelab')) || '';
  assert.ok(line, 'opens a new tmux window for the attach');
  // Checks the meaningful shape (ssh, targeting daniel-server with -t, the remote command) —
  // not the literal adjacency of "ssh" and "-t", which the mux option list (AV_SSH_OPTS) sits
  // between and keeps growing (Task 1 added keepalives after this test was first written).
  assert.match(line, /\bssh\b/, 'the window runs ssh');
  assert.match(line, /-t daniel-server\b/, 'ssh targets daniel-server with -t');
  assert.match(line, /attach -t 'airflow'/, 'attaches the target session');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'must NOT use wezterm spawn when inside tmux');
});

test('REMOTE tmux row jumped twice reuses its window instead of stacking a second', { skip }, () => {
  const { env, tmuxLog } = makeEnv({ list: '[]' });
  // Under the popup entry point every jump used to call new-window unconditionally, so
  // returning to one remote session repeatedly buried the client in duplicates.
  const pick = [cardKey(['daniel-server', '/home/ubuntu/airflow', 'working', '0', 'airflow', '%3', 'host', 'tmux:/tmp/tmux-1000/default:airflow:%3']), 'display'].join('\t');
  const inTmux = { FZF_PICK: pick, TMUX: '/tmp/tmux-1000/default,1,0' };
  run(env, [], inTmux);
  run(env, [], inTmux);
  const opened = fs.readFileSync(tmuxLog, 'utf8').split('\n').filter((l) => l.startsWith('new-window -n av:Homelab'));
  assert.strictEqual(opened.length, 1, 'the second jump reuses the window the first opened');
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /select-window -t @\d+/,
    'and gets there by selecting the window id the lookup resolved');
});

// Windows are per host, and the lookup spans every tmux session, so the name has to carry
// the host or one machine's window would answer a jump meant for another's. Two hosts each
// running a session called "main" is the case that catches it.
test('two hosts running an identically-named session get separate windows', { skip }, () => {
  const { env, tmuxLog } = makeEnv({ list: '[]' });
  const row = (host) => [cardKey([host, '/home/ubuntu/main', 'working', '0', 'main', '%3', 'host', 'tmux:/tmp/tmux-1000/default:main:%3']), 'display'].join('\t');
  const inTmux = { TMUX: '/tmp/tmux-1000/default,1,0' };
  run(env, [], { ...inTmux, FZF_PICK: row('daniel-server') });
  run(env, [], { ...inTmux, FZF_PICK: row('daniel-box') });
  const opened = fs.readFileSync(tmuxLog, 'utf8').split('\n').filter((l) => l.startsWith('new-window -n '));
  assert.deepStrictEqual(opened.map((l) => l.split(' ')[2]).sort(),
    ['av:Box', 'av:Homelab'],
    'each host gets its own window, so neither jump lands on the other');
});

test('a REMOTE row with a non-tmux locator does not activate locally', { skip }, () => {
  const { env, spawnLog, activateLog } = makeEnv({ list: '[]' });
  const pick = [cardKey(['daniel-server', '/x', 'working', '0', 't', '1', 'host', 'none:']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no spawn for a non-tmux remote');
  assert.strictEqual(fs.readFileSync(activateLog, 'utf8'), '', 'no local activation of a remote pane');
});

// A homelab bg row is the remote analog of the local bg jump (agentview-bg-sessions): there is
// no pane on either side, so the only way in is the remote daemon's own client. It must run
// THERE, over ssh — the local `claude` cannot attach a session hosted on another machine.
const RBG = ['daniel-server', '/home/ubuntu/server', 'needs-input', '0', 'job', '', 'bg', 'bg:eeee5555'];

test('a REMOTE bg row execs `claude attach <jobId>` on the remote, not locally', { skip }, () => {
  const { env, sshLog, spawnLog, activateLog } = makeEnv({ list: '[]' });
  const pick = [cardKey(RBG), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  const ssh = fs.readFileSync(sshLog, 'utf8');
  assert.match(ssh, /-t daniel-server/, 'ssh -t to the remote host, in this terminal');
  assert.match(ssh, /claude attach eeee5555/, 'attaches the daemon job by its jobId');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn');
  assert.strictEqual(fs.readFileSync(activateLog, 'utf8'), '', 'no local pane to activate');
});

test('a REMOTE bg row INSIDE tmux opens one reusable per-session window', { skip }, () => {
  const { env, tmuxLog } = makeEnv({ list: '[]' });
  const inTmux = { FZF_PICK: [cardKey(RBG), 'display'].join('\t'), TMUX: '/tmp/tmux-1000/default,1,0' };
  run(env, [], inTmux);
  run(env, [], inTmux);
  const log = fs.readFileSync(tmuxLog, 'utf8');
  const opened = log.split('\n').filter((l) => l.startsWith('new-window -n av:Homelab'));
  assert.strictEqual(opened.length, 1, 'the second jump reuses the window the first opened');
  // Checks the meaningful shape (ssh, targeting daniel-server with -t, the remote command) —
  // not the literal adjacency of "ssh" and "-t", which the mux option list (AV_SSH_OPTS) sits
  // between and keeps growing (Task 1 added keepalives after this test was first written).
  assert.match(opened[0], /\bssh\b/, 'the window runs ssh');
  assert.match(opened[0], /-t daniel-server\b/, 'ssh targets daniel-server with -t');
  assert.match(opened[0], /claude attach eeee5555/, 'attaching the job, not a tmux session');
});

test('a REMOTE bg row with no jobId falls back to the remote agents roster', { skip }, () => {
  const { env, sshLog } = makeEnv({ list: '[]' });
  const pick = [cardKey([...RBG.slice(0, 7), 'bg:']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  assert.match(fs.readFileSync(sshLog, 'utf8'), /claude agents/, 'no job id -> open the roster there');
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
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
  assert.ok(!fs.existsSync(avFile(home, 'gone')), 'the selected session file is removed');
  assert.ok(fs.existsSync(avFile(home, 'keep')), 'a different session (different locator) is untouched');
});

test('--remove matches a legacy row (no locator) by host+cwd+kind', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'legacy', { kind: 'host', cwd: '/r/legacy', state: 'working', host: HOST, ts: now, locator: '' });
  const key = cardKey([HOST, '/r/legacy', 'working', String(now), 't', '1', 'host', '']); // empty locator field
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
  assert.ok(!fs.existsSync(avFile(home, 'legacy')), 'a locator-less legacy row falls back to cwd/host/kind match');
});

test('--remove of a remote (non-self host) row leaves local files untouched', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'localkeep', { kind: 'host', cwd: '/r/localkeep', state: 'working', host: HOST, ts: now, locator: 'tmux:/s:x:%1' });
  const key = cardKey(['daniel-server', '/home/ubuntu/remote', 'working', String(now), 't', '1', 'host', 'tmux:/s:remote:%9']);
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
  assert.ok(fs.existsSync(avFile(home, 'localkeep')), 'a remote row has no local file — nothing is deleted here');
});

test('--remove of a remote row filters it out of the ssh-snapshot cache, keeping others', { skip }, () => {
  const now = nowSec();
  const gone = JSON.stringify({ kind: 'host', cwd: '/r/rgone', state: 'working', host: 'daniel-server', ts: now, locator: 'tmux:/s:rgone:%2' });
  const keep = JSON.stringify({ kind: 'host', cwd: '/r/rkeep', state: 'working', host: 'daniel-server', ts: now, locator: 'tmux:/s:rkeep:%1' });
  const { env, home } = makeEnv({ remote: `${gone}\n${keep}` });
  const cache = path.join(home, '.agentview-remote-cache.daniel-server');
  const key = cardKey(['daniel-server', '/r/rgone', 'working', String(now), 'rgone', '%2', 'host', 'tmux:/s:rgone:%2']);
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
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
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
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
  // The literal action is $AV_EXEC — execute-silent under tmux so the confirm chooser can
  // float over the list, plain execute otherwise. See av_pick in the script.
  assert.match(src, /ctrl-x:'"\$AV_EXEC"'\([^)]*--remove {1}/, 'ctrl-x runs agentview --remove on the selected KEY');
  assert.match(src, /reload\(/, 'removal reloads the body so the row disappears');
  assert.match(fs.readFileSync(RENDER, 'utf8'), /⌃x remove/, 'footer advertises the remove action');
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
  // 'c' is a live local session, so fold_live_completed_to_idle re-groups it under IDLE,
  // not COMPLETED — idle shares COMPLETED's grey (C_DONE), so it still proves the same
  // color mapping. IDLE collapses behind a fold line by default (task 6); expand it so
  // this asserts the expanded header. The collapsed one is state-colored too, so color
  // alone no longer tells the two apart — the fold-glyph test below is what discriminates.
  stateFile(home, 'c', { pane: '3', state: 'completed',   cwd: 'C:\\c\\cproj', host: HOST, ts: now - 7 });
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'idle\n');
  run(env, []);
  const raw = fs.readFileSync(capture, 'utf8');
  assert.match(raw, new RegExp(`\\x1b\\[1m\\x1b\\[${SC.work}mWORKING`), 'WORKING header is bold green');
  assert.match(raw, new RegExp(`\\x1b\\[1m\\x1b\\[${SC.need}mNEEDS INPUT`), 'NEEDS INPUT header is bold yellow');
  assert.match(raw, new RegExp(`\\x1b\\[1m\\x1b\\[${SC.done}mIDLE`), 'IDLE header is bold grey');
  assert.doesNotMatch(raw, /38;2;180;190;254/, 'header no longer uses the old lavender');
});

// ---- fold affordance + host-status color ----
// These assert on `--body`, not the picker: --body is the pure render path, while the picker
// detaches a --refresh-remote child that rewrites the very status files seeded below.
const SC_ERR = '38;2;243;139;168';   // red — unreachable / fetch failed
const lineOf = (raw, needle) => {
  const l = raw.split('\n').find((x) => x.includes(needle));
  assert.ok(l, `expected a line containing ${JSON.stringify(needle)}, got:\n${raw}`);
  return l;
};

test('a foldable header shows ▸ collapsed and ▾ expanded; other headers keep ●', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'w', { pane: '1', state: 'working',   cwd: 'C:\\a\\wproj', host: HOST, ts: now - 5 });
  // 'c' is a live local session, so fold_live_completed_to_idle re-groups it under IDLE —
  // idle is foldable exactly like completed, so it still exercises the same fold affordance.
  stateFile(home, 'c', { pane: '3', state: 'completed', cwd: 'C:\\c\\cproj', host: HOST, ts: now - 7 });

  // Collapsed is the default — no foldfile.
  const shut = lineOf(run(env, ['--body']).out, 'IDLE');
  assert.match(shut, /▸/, 'a collapsed IDLE header carries the collapsed glyph');
  assert.doesNotMatch(shut, /▾/, 'and never the expanded one');
  assert.match(shut, new RegExp(`\\x1b\\[${SC.done}m▸`), 'the glyph is tinted by the group state');

  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'idle\n');
  const open = run(env, ['--body']).out;
  const shown = lineOf(open, 'IDLE');
  assert.match(shown, /▾/, 'an expanded IDLE header carries the expanded glyph');
  assert.doesNotMatch(shown, /▸/, 'and never the collapsed one');

  // WORKING cannot be folded, so the affordance would be a lie there.
  const fixed = lineOf(open, 'WORKING');
  assert.match(fixed, /●/, 'a non-foldable header keeps the plain bullet');
  assert.doesNotMatch(fixed, /[▸▾]/, 'a non-foldable header carries no fold glyph');
});

test('an unhealthy host status row is colored by kind, and a healthy host adds none', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'w', { pane: '1', state: 'working', cwd: 'C:\\a\\wproj', host: HOST, ts: now });
  fs.writeFileSync(path.join(home, '.agentview-remote-status.daniel-box'), `unreachable\t${now}\n`);
  fs.writeFileSync(path.join(home, '.agentview-remote-status.daniel-server'), `ok\t${now - 3600}\n`);

  const raw = run(env, ['--body']).out;
  assert.match(lineOf(raw, 'unreachable'), new RegExp(`\\x1b\\[${SC_ERR}m`), 'unreachable reads red');
  const stale = lineOf(raw, ' old');
  assert.match(stale, new RegExp(`\\x1b\\[${SC.need}m`), 'a stale-but-reachable host reads yellow');
  assert.doesNotMatch(stale, new RegExp(`\\x1b\\[${SC_ERR}m`), 'stale data is not a failure');
});

test('a healthy host puts no red anywhere in the body', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'w', { pane: '1', state: 'working', cwd: 'C:\\a\\wproj', host: HOST, ts: now });
  fs.writeFileSync(path.join(home, '.agentview-remote-status.daniel-box'), `ok\t${now}\n`);
  fs.writeFileSync(path.join(home, '.agentview-remote-status.daniel-server'), `ok\t${now}\n`);

  // Red is used for nothing else, so its absence is the whole assertion.
  assert.doesNotMatch(run(env, ['--body']).out, new RegExp(`\\x1b\\[${SC_ERR}m`));
});

test('session names are tinted by their state color', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'w', { pane: '1', state: 'working',     cwd: 'C:\\a\\greenname',  host: HOST, ts: now - 5 });
  stateFile(home, 'n', { pane: '2', state: 'needs-input', cwd: 'C:\\b\\yellowname', host: HOST, ts: now - 6 });
  stateFile(home, 'c', { pane: '3', state: 'completed',   cwd: 'C:\\c\\greyname',   host: HOST, ts: now - 7 });
  // 'c' is a live local session, so fold_live_completed_to_idle re-groups it under IDLE,
  // which is grey too (both share C_DONE). IDLE collapses behind a fold line by default
  // (task 6); expand it so greyname's row still renders for the assertion below.
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'idle\n');
  run(env, []);
  const raw = fs.readFileSync(capture, 'utf8');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.work}mgreenname`), 'working session name is green');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.need}myellowname`), 'needs-input session name is yellow');
  assert.match(raw, new RegExp(`\\x1b\\[${SC.done}mgreyname`), 'idle session name is grey');
});

test('picker highlights the whole current line so the state color reads on hover', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /--highlight-line/, 'the current row gets a full-width highlight bar');
});

test('picker height is fixed, not adaptive — reloaded rows must not overflow into scrolling', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  // The session picker opens on a cached snapshot and live-reloads rows in afterwards;
  // fzf sizes an adaptive (~) window once at start and never re-fits it, so ~ here means
  // late rows scroll while the terminal below the box sits empty.
  const picker = src.split('\n').filter((l) => l.includes('--min-height=12'));
  assert.strictEqual(picker.length, 1, 'exactly one session-picker height line');
  assert.match(picker[0], /--height='90%'/, 'session picker uses a fixed height');
  assert.doesNotMatch(picker[0], /--height='~/, 'adaptive height would freeze at the initial row count');
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

// ---- the local machine's badge ----
// This was HOST_LABEL[$selfhost]="WSL", hardcoded, so the badge named whatever host agentview
// happened to run on: every session on a native Linux box rendered as WSL.
//
// These re-stub the hostname on purpose. makeEnv reports daniel-desktop, which IS winhost, so
// the "PC" entry overwrites the self entry and the local label cannot be observed there --
// which is why the suite never caught this.
const localHost = (bin, name) =>
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash\necho ${name}\n`, { mode: 0o755 });

test('a native Linux box badges its own sessions Linux, not WSL', { skip }, () => {
  const { env, home, bin } = makeEnv();
  localHost(bin, 'fedora');
  stateFile(home, 'w', { pane: '1', state: 'working', cwd: '/home/d/wproj', host: 'fedora', ts: nowSec() - 5 });
  const body = stripAnsi(run(env, ['--body']).out);
  assert.match(body, /Linux/, `expected a Linux badge, got:\n${body}`);
  assert.doesNotMatch(body, /WSL/, 'nothing about this host is WSL');
});

test('the same box badges WSL when it really is WSL', { skip }, () => {
  // WSL_DISTRO_NAME is the signal the spawn paths already branch on; the badge follows it
  // rather than asserting a machine identity of its own.
  const { env, home, bin } = makeEnv();
  localHost(bin, 'fedora');
  stateFile(home, 'w', { pane: '1', state: 'working', cwd: '/home/d/wproj', host: 'fedora', ts: nowSec() - 5 });
  const body = stripAnsi(run(env, ['--body'], { WSL_DISTRO_NAME: 'Ubuntu' }).out);
  assert.match(body, /WSL/, `expected a WSL badge, got:\n${body}`);
  assert.doesNotMatch(body, /Linux/, 'the badge is one or the other, never both');
});

test('a Mac badges its own sessions macOS', { skip }, () => {
  const { env, home, bin } = makeEnv();
  localHost(bin, 'MacBook-Pro-2');
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/bash\necho Darwin\n', { mode: 0o755 });
  stateFile(home, 'w', { pane: '1', state: 'working', cwd: '/Users/d/wproj', host: 'MacBook-Pro-2', ts: nowSec() - 5 });
  const body = stripAnsi(run(env, ['--body']).out);
  assert.match(body, /macOS/, `expected a macOS badge, got:\n${body}`);
  assert.doesNotMatch(body, /Linux|WSL/, 'the badge names the actual OS, not the Linux/WSL fallback');
});

// ---- per-group left accent rule (\u258e, state-colored) ----------------------
test('each group carries a state-colored left accent rule', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'n', { pane: '1', state: 'needs-input', cwd: 'C:\\a\\nbar', host: HOST, ts: now - 5 });
  stateFile(home, 'w', { pane: '2', state: 'working',     cwd: 'C:\\a\\wbar', host: HOST, ts: now - 6 });
  stateFile(home, 'c', { pane: '3', state: 'completed',   cwd: 'C:\\a\\cbar', host: HOST, ts: now - 3600 });
  // completed collapses behind a fold line by default (task 6); expand it so cbar's row
  // still renders for the accent-rule assertion below.
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'completed\n');
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
  assert.match(fs.readFileSync(RENDER, 'utf8'), /⌃x remove/, 'the key hints stay in the trimmed footer');
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

// ---- leaked-session cleanup: prune local rows whose recorded pid is dead ----
test('prunes a local host row whose recorded pid is dead (leaked session)', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'dead', { state: 'working', cwd: 'C:\\a\\deadproj', host: HOST, kind: 'host', ts: now - 60, pid: '2147483647', locator: 'none:' });
  stateFile(home, 'live', { state: 'working', cwd: 'C:\\a\\liveproj', host: HOST, kind: 'host', ts: now - 60, pid: String(process.pid), locator: 'none:' });
  run(env, []);
  assert.ok(!fs.existsSync(avFile(home, 'dead')), 'dead-pid local session file is pruned');
  assert.ok(fs.existsSync(avFile(home, 'live')), 'live-pid local session file is kept');
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.doesNotMatch(body, /deadproj/, 'a dead session is not rendered');
  assert.match(body, /liveproj/, 'a live session still renders');
});

// gather_local_rows emits one tagged jq line per file and pairs them with the glob BY INDEX,
// so a file jq cannot parse desyncs the pairing and the whole run falls to the no-prune
// fallback. One unreadable file therefore stops EVERY dead row on the machine from being
// pruned — they keep rendering indefinitely, which is what was seen live: five rows whose
// processes were long gone, all still listed.
test('one unparseable state file does not disable pruning for every other row', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'dead', { state: 'working', cwd: 'C:\\a\\deadproj', host: HOST, kind: 'host', ts: now - 60, pid: '2147483647', locator: 'none:' });
  stateFile(home, 'live', { state: 'working', cwd: 'C:\\a\\liveproj', host: HOST, kind: 'host', ts: now - 60, pid: String(process.pid), locator: 'none:' });
  fs.writeFileSync(avFile(home, 'truncated'), '{"key":"truncated","state":"wor');   // interrupted write
  run(env, []);
  assert.ok(!fs.existsSync(avFile(home, 'dead')), 'a dead row is still pruned despite a corrupt sibling');
  assert.ok(fs.existsSync(avFile(home, 'live')), 'the live row is untouched');
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.doesNotMatch(body, /deadproj/, 'the dead session is not rendered');
  assert.match(body, /liveproj/, 'the live session still renders');
});

test('keeps a local row with no recorded pid (legacy entry — no liveness signal)', { skip }, () => {
  const { env, home } = makeEnv();
  stateFile(home, 'legacy', { state: 'working', cwd: 'C:\\a\\legacyproj', host: HOST, kind: 'host', ts: nowSec() - 60, locator: 'none:' }); // no pid
  run(env, []);
  assert.ok(fs.existsSync(avFile(home, 'legacy')), 'a pid-less legacy row is left alone');
});

test('never pid-prunes a non-self host or a sandbox row (pid is not locally checkable)', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'remoteish', { state: 'working', cwd: '/x', host: 'other-host', kind: 'host', ts: now - 60, pid: '2147483647', locator: 'none:' });
  stateFile(home, 'sb', { state: 'working', cwd: '/y', host: HOST, kind: 'sandbox', ts: now - 60, pid: '2147483647', locator: 'wezterm:5' });
  run(env, []);
  assert.ok(fs.existsSync(avFile(home, 'remoteish')), 'a non-self host row is never pid-pruned locally');
  assert.ok(fs.existsSync(avFile(home, 'sb')), 'a sandbox row (container pid) is never pid-pruned');
});

// ---- pin sidecar GC: drop pins whose session no longer exists anywhere ----
const pinFile = (home) => path.join(home, '.claude', 'agent-view-pins');

test('render drops an orphaned pin and keeps live / remote / locator-less pins', { skip }, () => {
  const now = nowSec();
  const remote = JSON.stringify({ state: 'working', cwd: '/r/pr', host: 'daniel-server', kind: 'host', ts: now - 5, locator: 'tmux:/s:sess:%1' });
  const { env, home } = makeEnv({ remote });
  stateFile(home, 'live', { state: 'working', cwd: 'C:\\a\\livepin', host: HOST, kind: 'host', ts: now - 60, pid: String(process.pid), locator: 'wezterm:9' });
  stateFile(home, 'nl', { state: 'working', cwd: '/home/x/noloc', host: HOST, kind: 'host', ts: now - 60, pid: String(process.pid), locator: 'none:' });
  const nlPin = [HOST, '/home/x/noloc', 'host'].join(US);
  fs.writeFileSync(pinFile(home), `wezterm:9\n${nlPin}\ntmux:/s:sess:%1\nwezterm:404\n`);
  run(env, []);
  const pins = fs.readFileSync(pinFile(home), 'utf8').split('\n').filter(Boolean);
  assert.ok(pins.includes('wezterm:9'), 'a live local session (locator pin) keeps its pin');
  assert.ok(pins.includes(nlPin), 'a live locator-less session keeps its host|cwd|kind pin');
  assert.ok(pins.includes('tmux:/s:sess:%1'), 'a live remote (cache) session keeps its pin');
  assert.ok(!pins.includes('wezterm:404'), 'a pin with no matching session is dropped');
});

test('the GC never creates a pinfile when nothing is pinned', { skip }, () => {
  const { env, home } = makeEnv();
  stateFile(home, 's', { state: 'working', cwd: 'C:\\a\\p', host: HOST, kind: 'host', ts: nowSec() - 60, pid: String(process.pid), locator: 'wezterm:1' });
  run(env, []);
  assert.ok(!fs.existsSync(pinFile(home)), 'no pinfile is created by the GC when nothing is pinned');
});

test('the GC clears every pin when no session exists (all orphaned)', { skip }, () => {
  const { env, home } = makeEnv();
  fs.writeFileSync(pinFile(home), 'wezterm:1\nwezterm:2\n');
  run(env, []);
  assert.strictEqual(fs.readFileSync(pinFile(home), 'utf8').trim(), '', 'every pin is dropped when no session exists');
});

// ---- REVIEW bucket: stopped-but-dirty sessions grouped apart from COMPLETED ----
// The hook stamps a `git` marker + writes state "review" when a stop left the tree dirty or
// unpushed. The picker renders REVIEW between WORKING and COMPLETED, peach-accented, with the
// marker in the right column. For a LOCAL session the render re-derives state from the live
// registry (idle -> completed), so the marker also drives a completed -> review upgrade.
const SC_REVIEW = '38;2;250;179;135';   // peach

// Write a live registry entry so load_session_map/merge_session_row fold over the hook row.
function sessionFile(home, pid, obj) {
  const d = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${pid}.json`), JSON.stringify(obj));
}

test('a review row renders in its own REVIEW bucket with the git marker', { skip }, () => {
  const { env, home, capture } = makeEnv();
  stateFile(home, 'rv', { state: 'review', cwd: 'C:\\a\\dirtyproj', session: 'rv', host: HOST,
    ts: nowSec() - 180, git: '⚠ dirty' });
  run(env, []);
  const raw = fs.readFileSync(capture, 'utf8');
  const body = stripAnsi(raw);
  assert.match(body, /REVIEW/, 'a REVIEW group header renders');
  assert.match(body, /⚠ dirty/, 'the git marker shows in the row');
  assert.match(raw, new RegExp(`\\x1b\\[1m\\x1b\\[${SC_REVIEW}mREVIEW`), 'REVIEW header is bold peach');
  assert.match(raw, new RegExp(`\\x1b\\[${SC_REVIEW}mdirtyproj`), 'the review session name is peach');
});

test('REVIEW sorts between WORKING and COMPLETED', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'w', { state: 'working',   cwd: 'C:\\a\\wproj', session: 'w', host: HOST, ts: now - 5 });
  stateFile(home, 'r', { state: 'review',    cwd: 'C:\\a\\rproj', session: 'r', host: HOST, ts: now - 6, git: '↑2' });
  // A non-self host: a local host row would be re-grouped under IDLE by
  // fold_live_completed_to_idle, and this test is specifically about the COMPLETED
  // group's position in the sort order.
  stateFile(home, 'c', { state: 'completed', cwd: '/home/ubuntu/cproj', session: 'c', host: 'daniel-server', ts: now - 7 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  const iW = body.indexOf('WORKING'), iR = body.indexOf('REVIEW'), iC = body.indexOf('COMPLETED');
  assert.ok(iW > -1 && iR > -1 && iC > -1, 'all three headers present');
  assert.ok(iW < iR && iR < iC, `order must be WORKING < REVIEW < COMPLETED (got ${iW},${iR},${iC})`);
});

test('a clean completed row (no marker) stays in COMPLETED', { skip }, () => {
  const { env, home, capture } = makeEnv();
  // A non-self host: a local host row would be re-grouped under IDLE by
  // fold_live_completed_to_idle, and this test is specifically about a completed row
  // staying in COMPLETED (as opposed to REVIEW) when its git marker is clean.
  stateFile(home, 'c', { state: 'completed', cwd: '/home/ubuntu/cleanproj', session: 'c', host: 'daniel-server', ts: nowSec() - 30, git: '' });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /COMPLETED/);
  assert.doesNotMatch(body, /REVIEW/, 'a clean stop is not reviewed');
});

// ---- fold_live_completed_to_idle: COMPLETED -> IDLE for a live local session -----------
test('a live local host session in state completed renders under IDLE, not COMPLETED', { skip }, () => {
  const { env, home, capture } = makeEnv();
  stateFile(home, 'c', { state: 'completed', cwd: 'C:\\a\\liveproj', session: 'c', host: HOST, ts: nowSec() - 30 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /IDLE/, 'a live local session merely between turns is IDLE');
  assert.doesNotMatch(body, /COMPLETED/, 'not COMPLETED — the process is still there');
});

test('a completed row on a non-self host stays COMPLETED, not IDLE', { skip }, () => {
  // fold_live_completed_to_idle only trusts liveness for a row it can verify: a non-self
  // host is not locally pid-checkable, so it stays COMPLETED rather than assume the
  // session is still running.
  const { env, home, capture } = makeEnv();
  stateFile(home, 'c', { state: 'completed', cwd: '/home/ubuntu/cproj', session: 'c', host: 'daniel-server', ts: nowSec() - 30 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /COMPLETED/);
  assert.doesNotMatch(body, /IDLE/, 'a remote row is not locally verifiable as live');
});

test('the live registry fold re-derives review from the git marker (idle -> completed -> review)', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  const sid = 'aaaa1111-0000-0000-0000-0000000000aa';
  // Hook row: a local host session with a dirty marker and a live (this-process) pid.
  stateFile(home, sid, { state: 'review', session: sid, kind: 'host', cwd: 'C:\\a\\foldproj',
    host: HOST, ts: now - 60, pid: String(process.pid), locator: 'none:', git: '⚠ dirty' });
  // Live registry says idle -> the fold maps that to "completed"; the marker upgrades it back.
  sessionFile(home, process.pid, { pid: process.pid, sessionId: sid, status: 'idle', entrypoint: 'cli',
    updatedAt: (now - 5) * 1000, statusUpdatedAt: (now - 5) * 1000 });
  run(env, []);
  const body = stripAnsi(fs.readFileSync(capture, 'utf8'));
  assert.match(body, /REVIEW/, 'the folded idle session is upgraded to review, not shown as completed');
  assert.match(body, /foldproj/);
});

test('--card labels a review session with the peach state', { skip }, () => {
  const { env } = makeEnv();
  const blob = cardKey([HOST, 'C:\\a\\rproj', 'review', '0', 'fixing things', '1', 'host', 'none:']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, /State\s+review/);
});

// ---- row geometry: name block · title · shared status column ----------------
// The row used to right-align "title + marker" as one blob, so every title began at a
// different column and there was no edge to run the eye down. It also computed its width
// from a formula that disagreed with fzf's actual list width, so fzf silently ellipsised
// the last 1-2 cells of every row that reached the edge. These pin both.

const LCOLS = 110;
// What row_width must compute at startup: fzf's list geometry for --margin=1,2% --padding=1
// --border=rounded, less its 2-column gutter. Verified against fzf 0.74's own $FZF_COLUMNS.
const rowWidth = (c) => c - 2 * Math.floor((c * 2) / 100) - 8;

// Display cells, mirroring av_dwidth: East Asian Wide and emoji take two, everything else one.
const dwidth = (s) => [...s].reduce((n, ch) => {
  const cp = ch.codePointAt(0);
  const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff);
  return n + (wide ? 2 : 1);
}, 0);

// The DISPLAY field of each SESSION row (KEY \t TRACKID \t DISPLAY). Group headers, spacers
// and host-status rows carry no machine pill, which is what separates them here.
const sessionRows = (capture) => fs.readFileSync(capture, 'utf8').split('\n')
  .filter((l) => l.includes(''))
  .map((l) => stripAnsi(l.split('\t').slice(2).join('\t')));

test('no rendered row overruns the width fzf gives the list', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  // Long titles so every row reaches the right edge, and one carrying a wide glyph: `${#s}`
  // counts runes, so an emoji title measured a cell short per glyph and overran.
  stateFile(home, 'w', { pane: '1', state: 'working', cwd: '/r/alpha', host: HOST, ts: now - 5, title: 'w'.repeat(200) });
  stateFile(home, 'e', { pane: '2', state: 'working', cwd: '/r/emoji', host: HOST, ts: now - 6, title: '🚀'.repeat(80) });
  // 'c' is a live local session, so fold_live_completed_to_idle re-groups it under IDLE.
  stateFile(home, 'c', { pane: '3', state: 'completed', cwd: '/r/beta', host: HOST, ts: now - 4000, title: 'c'.repeat(200) });
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'idle\n');
  run(env, [], { COLUMNS: String(LCOLS) });
  const rows = sessionRows(capture);
  assert.strictEqual(rows.length, 3, `expected three session rows, got:\n${rows.join('\n')}`);
  for (const d of rows) {
    assert.strictEqual(dwidth(d), rowWidth(LCOLS),
      `row is ${dwidth(d)} cells, the list is ${rowWidth(LCOLS)}:\n${d}`);
  }
});

test('titles end on one column whatever their row state, with the marker in its own', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  // `<` marks each title's last cell: if the titles share a right edge it lands on one column.
  stateFile(home, 'w', { pane: '1', state: 'working',   cwd: '/r/alpha', host: HOST, ts: now - 5, title: 'AA<' });
  stateFile(home, 'c', { pane: '2', state: 'completed', cwd: '/r/beta',  host: HOST, ts: now - 4000, title: 'BBBBBB<' });
  stateFile(home, 'i', { pane: '3', state: 'idle',      cwd: '/r/gamma', host: HOST, ts: now - 9000, title: 'CCCCCCCCCC<' });
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'completed\nidle\n');
  run(env, [], { COLUMNS: String(LCOLS) });
  const ends = sessionRows(capture).map((d) => d.indexOf('<'));
  assert.strictEqual(ends.length, 3, 'three rows rendered');
  assert.ok(ends.every((e) => e > 0), `every row kept its title:\n${sessionRows(capture).join('\n')}`);
  assert.strictEqual(new Set(ends).size, 1, `titles must share a right edge, got columns ${ends}`);
  // …and the markers are right-aligned in the column past it, so they share an edge too.
  const marked = sessionRows(capture).filter((d) => /idle/.test(d));
  assert.strictEqual(marked.length, 2, 'the two finished rows carry an idle marker');
  for (const d of marked) assert.match(d, /idle \d+[smhd]$/, `marker sits flush right:\n${d}`);
});

test('the kind column appears only when a sandbox row needs it', { skip }, () => {
  const { env, home, capture } = makeEnv();
  const now = nowSec();
  stateFile(home, 'a', { pane: '1', state: 'working', cwd: '/r/alpha', host: HOST, ts: now - 5, title: 'one' });
  run(env, [], { COLUMNS: String(LCOLS) });
  assert.doesNotMatch(stripAnsi(fs.readFileSync(capture, 'utf8')), /claude ·/,
    '"claude ·" on every row distinguishes nothing — it is only ever claude or sandbox');

  const two = makeEnv();
  stateFile(two.home, 'a', { pane: '1', state: 'working', cwd: '/r/alpha', host: HOST, ts: now - 5, title: 'one' });
  stateFile(two.home, 's', { pane: '2', state: 'working', cwd: '/r/box', host: HOST, ts: now - 6, kind: 'sandbox', title: 'two' });
  run(two.env, [], { COLUMNS: String(LCOLS) });
  const body = stripAnsi(fs.readFileSync(two.capture, 'utf8'));
  assert.match(body, /sandbox ·/, 'a sandbox row still says so');
  assert.match(body, /claude ·/, 'and its neighbour keeps the column so the two line up');
});

test('each machine badge gets its own colour', { skip }, () => {
  // Only PC and Homelab were ever listed, so this box and the Box rendered in the same
  // default text colour and the pill carried no information.
  const now = nowSec();
  const remote = JSON.stringify({ pane: '1', state: 'working', cwd: '/home/ubuntu/srv',
    session: 'r', host: 'daniel-server', ts: now - 5 });
  const { env, home, bin, capture } = makeEnv({ remote });
  localHost(bin, 'fedora');   // else selfhost IS winhost and the local badge reads "PC"
  stateFile(home, 'a', { pane: '1', state: 'working', cwd: '/r/alpha', host: 'fedora', ts: now - 5, title: 'local' });
  run(env, [], { COLUMNS: String(LCOLS) });
  const raw = fs.readFileSync(capture, 'utf8');
  const pills = [...raw.matchAll(/\x1b\[38;2;([\d;]+)m(PC|Box|Linux|WSL|Homelab)\x1b\[0m/g)];
  const labels = new Set(pills.map((m) => m[2]));
  const hues = new Set(pills.map((m) => m[1]));
  assert.ok(labels.has('Linux') && labels.has('Homelab'), `expected both machines, got ${[...labels]}`);
  assert.strictEqual(hues.size, labels.size, `each machine needs its own hue, got ${[...hues]} for ${[...labels]}`);
});

test('the footer drops whole hints to fit rather than being cut off mid-word', { skip }, () => {
  const { env, home, fzfArgs } = makeEnv();
  stateFile(home, 'a', { pane: '1', state: 'working', cwd: '/r/alpha', host: HOST, ts: nowSec() - 5, title: 'one' });

  run(env, [], { COLUMNS: '80' });
  const narrow = fs.readFileSync(fzfArgs, 'utf8');
  const line = /--footer=(.*?)(?: --|\n)/s.exec(narrow);
  assert.ok(line, `no --footer in argv:\n${narrow}`);
  assert.ok(dwidth(line[1]) <= rowWidth(80), `footer is ${dwidth(line[1])} cells, list is ${rowWidth(80)}`);
  assert.match(narrow, /\? keys/, 'the hint that reveals the dropped ones is the last to go');
  assert.match(narrow, /↵ switch\/fold/, 'and so is the one that says what enter does');
  assert.doesNotMatch(narrow, /⌃x remove/, 'the lowest-priority hint goes first');

  run(env, [], { COLUMNS: '220' });
  const wide = fs.readFileSync(fzfArgs, 'utf8');
  for (const hint of ['↵ switch/fold', 'alt-# jump', '⌃t send', '⌃v resume', '⌃r rename',
    '⌃p pin', '⌃g group', '⌃n new', '⌃x remove', '⌃f refresh', '? keys', 'esc']) {
    assert.ok(wide.includes(hint), `a wide pane shows every hint; missing "${hint}"`);
  }
});

test('the header states the grouping on the left and the totals on the right', { skip }, () => {
  const { env, home, fzfArgs } = makeEnv();
  stateFile(home, 'a', { pane: '1', state: 'working', cwd: '/r/alpha', host: HOST, ts: nowSec() - 5, title: 'one' });
  run(env, [], { COLUMNS: String(LCOLS) });
  // Appending "· by repo" only in repo mode meant the default never said what it grouped by,
  // nor that ⌃g could change it.
  assert.match(fs.readFileSync(fzfArgs, 'utf8'), /--header=\s+by state\s+1 session · 1 machine/,
    'state mode names itself, with the totals right-aligned away from it');
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-groupby'), 'repo\n');
  run(env, [], { COLUMNS: String(LCOLS) });
  assert.match(fs.readFileSync(fzfArgs, 'utf8'), /--header=\s+by repo\s/);
});

test('the pointer is not the glyph fzf already paints down the gutter', { skip }, () => {
  // fzf 0.74 draws ▌ in the gutter of every NON-current row on its own (independent of
  // --pointer/--marker/--scrollbar), so a ▌ pointer marked the current row with the same
  // glyph as every other one and only --highlight-line's background told them apart.
  const src = fs.readFileSync(VIEW, 'utf8');
  const ptr = /--pointer='(.+?)'/.exec(src);
  assert.ok(ptr, 'the picker sets a pointer');
  assert.notStrictEqual(ptr[1], '▌', 'the pointer must differ from fzf’s own gutter bar');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
