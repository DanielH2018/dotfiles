// Regression guard for the interactive action handlers of executable_agentview that had
// ZERO test coverage: do_jump, do_remove, do_pin, do_rename, av_purge_local/windows/remote,
// remote_attach, and the title lookup (load_titles/title_for_cwd). These are the exact code
// paths that attach/kill/rename sessions across local tmux, Windows (wezterm.exe/taskkill.exe)
// and remote SSH hosts — a wrong-field read here misroutes <enter> or CTRL+X to a stranger's
// pane/pid. Drives the ACTUAL script with stub tmux/wezterm/wezterm.exe/taskkill.exe/ssh/fzf
// on PATH and a temp $HOME, so it's hermetic — no real mux, no network, no TTY. Real jq used.
// Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentviewWinSeams } = require('../lib/agentview-env');

const VIEW = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_agentview');
const US = '\x1f';

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function findBash() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'bash'); if (fs.existsSync(p)) return p;
  }
  return 'bash';
}
const BASH = findBash();
const nowSec = () => Math.floor(Date.now() / 1000);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:]*m/g, '');
const cardKey = (fields) => fields.join(US); // host|cwd|state|ts|title|pane|kind|locator

// selfhost (arbitrary, distinct from the hardcoded winhost + our remote fixtures below), so
// the Windows-source and remote branches both engage as cross-boundary sources.
const SELF = 'agentview-actions-host';
const WINHOST = 'daniel-desktop';        // hardcoded in the script — can't be overridden
const REMOTE1 = 'daniel-server';         // mapped by HOST_SSH (to itself)
const REMOTE2 = 'other-remote-host';     // unmapped -> remote_alias falls back to the name itself

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// Hermetic env: stub-bin (tmux/wezterm/wezterm.exe/taskkill.exe/ssh/fzf/hostname/curl/claude)
// + a temp HOME (with agent-view + sessions dirs) + a temp Windows registry dir.
function makeEnv() {
  const bin = scratch('ava-bin-');
  const home = scratch('ava-home-');
  const windir = scratch('ava-win-');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });

  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const activateLog = path.join(bin, 'activate.log'); fs.writeFileSync(activateLog, '');
  const spawnLog = path.join(bin, 'spawn.log'); fs.writeFileSync(spawnLog, '');
  const wezSendLog = path.join(bin, 'wez-send.log'); fs.writeFileSync(wezSendLog, '');
  const sshLog = path.join(bin, 'ssh.log'); fs.writeFileSync(sshLog, '');
  const sshArgvLog = path.join(bin, 'ssh-argv.log'); fs.writeFileSync(sshArgvLog, '');
  const wezwinActivateLog = path.join(bin, 'wezwin-activate.log'); fs.writeFileSync(wezwinActivateLog, '');
  const wezwinSendLog = path.join(bin, 'wezwin-send.log'); fs.writeFileSync(wezwinSendLog, '');
  const taskkillLog = path.join(bin, 'taskkill.log'); fs.writeFileSync(taskkillLog, '');
  const claudeLog = path.join(bin, 'claude.log'); fs.writeFileSync(claudeLog, '');
  const killLog = path.join(bin, 'kill.log'); fs.writeFileSync(killLog, '');
  const capture = path.join(bin, 'fzf-capture.txt'); fs.writeFileSync(capture, '');
  const wezListFile = path.join(bin, 'list.json'); fs.writeFileSync(wezListFile, '[]');

  // Local wezterm: activate-pane/spawn/send-text each logged to their own file; `list` cats
  // the seeded pane snapshot (for title_for_cwd/load_titles).
  fs.writeFileSync(path.join(bin, 'wezterm'), `#!/bin/bash
case "$*" in
  *list*) cat "$WEZ_LIST_FILE" 2>/dev/null ;;
  *activate-pane*) prev=""; for a in "$@"; do [ "$prev" = "--pane-id" ] && echo "$a" >> "$WEZ_ACTIVATE_LOG"; prev="$a"; done ;;
  *send-text*) echo "$*" >> "$WEZ_SEND_LOG" ;;
  *spawn*) echo "$*" >> "$WEZ_SPAWN_LOG" ;;
esac
exit 0
`, { mode: 0o755 });
  // Stateful tmux stub (mirrors agentview-bg-sessions.test.js): select-window only "succeeds"
  // (exit 0) for a window new-window has already created, so the bg-jump reuse-vs-spawn branch
  // is real, not always-true. new-window actually executes its command string through sh
  // so we can verify quoting survives the shell reparse.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "$TMUX_LOG"
wins="$TMUX_LOG.wins"; touch "$wins"
case "$1" in
  select-window) name="\${3#=}"; grep -qxF "$name" "$wins" && exit 0; exit 1 ;;
  new-window)
    echo "$3" >> "$wins"
    # Execute the command string through sh to test quoting post-reparse
    if [ -n "\${4:-}" ]; then
      sh -c "$4" 2>/dev/null
    fi
    ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
echo "$*" >> "$SSH_LOG"
# "$*" above joins argv with spaces and can't tell a correctly-quoted multi-word
# ControlPath from one split by a broken quoting scheme (both flatten to the same
# text). Also record one argv element per line, with a record-separator line
# between calls, so tests can recover exact argument boundaries.
printf '%s\\n' "$@" >> "$SSH_ARGV_LOG"
printf '\\x1e\\n' >> "$SSH_ARGV_LOG"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash
cat > "$FZF_CAPTURE"
[ -n "\${FZF_PICK:-}" ] && printf '%s\\n' "$FZF_PICK"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash
echo "${SELF}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
echo "$*" >> "$CLAUDE_LOG"
exit 0
`, { mode: 0o755 });
  // The WSL-routing tests drive the Windows wezterm, so it gets a body: same shape as the
  // local stub, on its own logs. The other two seams take the helper's inert defaults.
  const seams = agentviewWinSeams({
    bin,
    windir,
    weztermBody: `#!/bin/bash
case "$*" in
  *activate-pane*) prev=""; for a in "$@"; do [ "$prev" = "--pane-id" ] && echo "$a" >> "$WEZWIN_ACTIVATE_LOG"; prev="$a"; done ;;
  *send-text*|*spawn*) echo "$*" >> "$WEZWIN_SEND_LOG" ;;
esac
exit 0
`,
  });
  fs.writeFileSync(path.join(bin, 'taskkill.exe'), `#!/bin/bash
echo "$*" >> "$TASKKILL_LOG"
exit 0
`, { mode: 0o755 });
  // AV_KILLCMD test seam: log the pid instead of signalling anything real.
  const killStub = path.join(bin, 'killstub'); fs.writeFileSync(killStub, `#!/bin/bash
echo "$1" >> "$KILL_LOG"
exit 0
`, { mode: 0o755 });

  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    ...seams.env,
    AV_WINKILL: path.join(bin, 'taskkill.exe'),
    AV_KILLCMD: killStub,
    TMUX_LOG: tmuxLog, WEZ_ACTIVATE_LOG: activateLog, WEZ_SPAWN_LOG: spawnLog, WEZ_SEND_LOG: wezSendLog,
    WEZ_LIST_FILE: wezListFile, SSH_LOG: sshLog, SSH_ARGV_LOG: sshArgvLog, WEZWIN_ACTIVATE_LOG: wezwinActivateLog,
    WEZWIN_SEND_LOG: wezwinSendLog, TASKKILL_LOG: taskkillLog, CLAUDE_LOG: claudeLog, KILL_LOG: killLog,
    FZF_CAPTURE: capture,
  };
  // These model agentview running where the LOCAL cli owns the GUI, so the `wezterm` stub above
  // is the one that should be reached. Under WSL that is false — only wezterm.exe reaches the
  // GUI — and the suite itself runs in WSL, so say which scenario this is instead of inheriting
  // it. The WSL routing gets its own tests further down.
  delete env.TMUX; delete env.WEZTERM_PANE; delete env.WSL_DISTRO_NAME;
  return {
    bin, home, windir, env, tmuxLog, activateLog, spawnLog, wezSendLog, wezListFile, sshLog, sshArgvLog,
    wezwinActivateLog, wezwinSendLog, taskkillLog, claudeLog, killLog, capture,
  };
}

const read = (p) => fs.readFileSync(p, 'utf8');
function localFile(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
function winFile(windir, sid, obj) {
  fs.writeFileSync(path.join(windir, `${sid}.json`), JSON.stringify(obj));
}
function sessionProc(home, pid, sid) {
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid }));
}
function remoteCache(home, objs) {
  fs.writeFileSync(path.join(home, '.agentview-remote-cache'), objs.map((o) => JSON.stringify(o)).join('\n'));
}
const localAvFile = (home, sid) => path.join(home, '.claude', 'agent-view', `${sid}.json`);
const winAvFile = (windir, sid) => path.join(windir, `${sid}.json`);
const cacheFile = (home) => path.join(home, '.agentview-remote-cache');
const pinFile = (home) => path.join(home, '.claude', 'agent-view-pins');
const pane = (id, cwd, title) => ({ pane_id: id, cwd, title, window_id: 0, tab_id: 0 });

function run(env, args, extraEnv = {}, input = '') {
  try {
    return { out: execFileSync(BASH, [VIEW, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv }, input,
    }), code: 0, err: '' };
  } catch (e) { return { out: e.stdout || '', code: e.status, err: e.stderr || '' }; }
}
// A row as its KEY (host|cwd|state|ts|title|pane|kind|locator).
function rowKey({ host = SELF, cwd, state = 'working', ts = nowSec(), title = '', pane: p = '%1', kind = 'host', locator }) {
  return cardKey([host, cwd, state, String(ts), title, p, kind, locator]);
}

// ==========================================================================
// do_jump — table-driven: each locator/host/kind combination must dispatch to
// EXACTLY its own backend, leaving every other backend's log untouched. A
// misrouted <enter> is the historic bug class this guards against.
// ==========================================================================
const jumpScenarios = [
  {
    name: 'local tmux, INSIDE tmux -> switch-client only (never attach-session)',
    key: rowKey({ cwd: '/local/a', kind: 'host', locator: 'tmux:/tmp/tmux-1000/default:sess-a:%3' }),
    extraEnv: { TMUX: '/tmp/tmux-1000/default,1,0' },
    check: (l) => {
      assert.match(l.tmuxLog, /switch-client -t %3/);
      assert.doesNotMatch(l.tmuxLog, /attach-session/);
      assert.strictEqual(l.activateLog, ''); assert.strictEqual(l.wezwinActivateLog, '');
      assert.strictEqual(l.sshLog, ''); assert.strictEqual(l.spawnLog, '');
    },
  },
  {
    name: 'local tmux, BARE shell -> attach-session only (never switch-client)',
    key: rowKey({ cwd: '/local/a', kind: 'host', locator: 'tmux:/tmp/tmux-1000/default:sess-a:%3' }),
    extraEnv: {},
    check: (l) => {
      assert.match(l.tmuxLog, /attach-session -t sess-a/);
      assert.doesNotMatch(l.tmuxLog, /switch-client/);
      assert.strictEqual(l.activateLog, ''); assert.strictEqual(l.sshLog, '');
    },
  },
  {
    name: 'local wezterm -> activate-pane only, no tmux/ssh/windows',
    key: rowKey({ cwd: '/local/b', kind: 'host', locator: 'wezterm:11' }),
    extraEnv: {},
    check: (l) => {
      assert.match(l.activateLog, /(^|\n)11(\n|$)/);
      assert.strictEqual(l.tmuxLog, ''); assert.strictEqual(l.wezwinActivateLog, ''); assert.strictEqual(l.sshLog, '');
    },
  },
  {
    name: 'Windows row -> Windows wezterm.exe activate-pane only, never the local wezterm/ssh',
    key: rowKey({ host: WINHOST, cwd: 'C:\\p', kind: 'host', locator: 'wezterm:22' }),
    extraEnv: {},
    check: (l) => {
      assert.match(l.wezwinActivateLog, /(^|\n)22(\n|$)/);
      assert.strictEqual(l.activateLog, '', 'must never activate a local wezterm pane for a Windows row');
      assert.strictEqual(l.tmuxLog, ''); assert.strictEqual(l.sshLog, '');
    },
  },
  {
    // The row's host says WSL, but the question is which cli can reach the GUI — and from WSL
    // the Linux /usr/bin/wezterm cannot, at all. Routing on the host would send this to the
    // local cli, which answers out of a mux server it silently starts: the pane is "activated"
    // in a headless phantom and the jump looks like a no-op.
    name: 'WSL: a local-host wezterm row routes to wezterm.exe, never the Linux cli',
    key: rowKey({ cwd: '/local/c', kind: 'host', locator: 'wezterm:33' }),
    extraEnv: { WSL_DISTRO_NAME: 'Ubuntu' },
    check: (l) => {
      assert.match(l.wezwinActivateLog, /(^|\n)33(\n|$)/);
      assert.strictEqual(l.activateLog, '', 'the Linux cli cannot reach the GUI from WSL');
      assert.strictEqual(l.tmuxLog, ''); assert.strictEqual(l.sshLog, '');
    },
  },
  {
    name: 'remote tmux, INSIDE local tmux -> new-window ssh-attach (ssh embedded, never exec\'d here)',
    key: rowKey({ host: REMOTE1, cwd: '/home/ubuntu/r', kind: 'host', locator: 'tmux:/tmp/tmux-1000/default:rsess:%4' }),
    extraEnv: { TMUX: '/tmp/tmux-1000/default,1,0' },
    check: (l) => {
      assert.match(l.tmuxLog, /new-window -n rsess/);
      // The command string should be logged by tmux before reparse
      assert.match(l.tmuxLog, /ssh -o ControlMaster=auto/);
      // But the critical test: post-reparse ssh argv must have -o and ControlPath as separate args
      const sshLine = l.sshLog.trim().split('\n')[0];
      assert.ok(sshLine && sshLine.includes('-o'), 'post-reparse ssh must receive -o as separate arg');
      assert.ok(sshLine.includes('ControlPath='), 'post-reparse ssh must receive ControlPath= value');
      // The quoting test: ControlPath value should be intact, not mangled
      const controlPathMatch = sshLine.match(/ControlPath=(\S+)/);
      assert.ok(controlPathMatch && controlPathMatch[1].includes('.ssh/agentview'), 'ControlPath value must be intact post-reparse');
      assert.match(l.tmuxLog, /-t daniel-server/);
      assert.match(l.tmuxLog, /attach -t 'rsess'/);
      assert.strictEqual(l.spawnLog, ''); assert.strictEqual(l.activateLog, '');
    },
  },
  {
    // WEZTERM_PANE set used to divert this to `wezterm cli spawn`, which from WSL reaches its
    // own mux rather than the Windows GUI — the attach landed where nothing displays it. The
    // picker owns its terminal here, so the attach belongs in it.
    name: 'remote tmux, WEZTERM_PANE set (no local tmux) -> still attaches in place',
    key: rowKey({ host: REMOTE1, cwd: '/home/ubuntu/r2', kind: 'host', locator: 'tmux:/tmp/tmux-1000/default:rsess2:%5' }),
    extraEnv: { WEZTERM_PANE: '0' },
    check: (l) => {
      assert.match(l.sshLog, /-t daniel-server/);
      assert.match(l.sshLog, /attach -t 'rsess2'/);
      assert.strictEqual(l.spawnLog, '', 'a wezterm spawn here would be invisible');
      assert.strictEqual(l.tmuxLog, ''); assert.strictEqual(l.activateLog, '');
    },
  },
  {
    name: 'remote tmux, bare shell (no tmux, no WEZTERM_PANE) -> exec ssh -t attach in place',
    key: rowKey({ host: REMOTE2, cwd: '/home/ubuntu/r3', kind: 'host', locator: 'tmux:/tmp/tmux-1000/default:rsess3:%6' }),
    extraEnv: {},
    check: (l) => {
      assert.match(l.sshLog, /-t other-remote-host/);
      assert.match(l.sshLog, /attach -t 'rsess3'/);
      assert.strictEqual(l.tmuxLog, ''); assert.strictEqual(l.spawnLog, ''); assert.strictEqual(l.activateLog, '');
    },
  },
  {
    name: 'bg row with a jobId, inside tmux -> claude attach in its own window',
    key: rowKey({ cwd: '/home/x', kind: 'bg', locator: 'bg:jobxyz' }),
    extraEnv: { TMUX: '/tmp/tmux-1000/default,1,0' },
    check: (l) => {
      assert.match(l.tmuxLog, /new-window -n cc-jobxyz claude attach jobxyz/);
      assert.strictEqual(l.sshLog, ''); assert.strictEqual(l.activateLog, ''); assert.strictEqual(l.wezwinActivateLog, '');
    },
  },
];

for (const sc of jumpScenarios) {
  test(`do_jump: ${sc.name}`, { skip }, () => {
    const paths = makeEnv();
    const r = run(paths.env, ['--jump', sc.key], sc.extraEnv);
    assert.strictEqual(r.code, 0);
    sc.check({
      tmuxLog: read(paths.tmuxLog), activateLog: read(paths.activateLog), spawnLog: read(paths.spawnLog),
      sshLog: read(paths.sshLog), wezwinActivateLog: read(paths.wezwinActivateLog),
    });
  });
}

// ==========================================================================
// do_remove / av_purge_local / av_purge_windows / av_purge_remote — the row
// selected must be the ONLY thing stopped: right pid, right file, right host.
// ==========================================================================
test('do_remove (local): kills only the targeted pid, deletes only its file', { skip }, () => {
  const { env, home, killLog, claudeLog } = makeEnv();
  localFile(home, 'alpha', { session: 'alpha', host: SELF, cwd: '/r/a', state: 'idle', kind: 'host', locator: 'tmux:/s:a:%1' });
  localFile(home, 'bravo', { session: 'bravo', host: SELF, cwd: '/r/b', state: 'idle', kind: 'host', locator: 'tmux:/s:b:%2' });
  sessionProc(home, 9001, 'alpha');
  sessionProc(home, 9002, 'bravo');
  const key = rowKey({ cwd: '/r/a', state: 'idle', locator: 'tmux:/s:a:%1' });
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
  assert.strictEqual(read(killLog).trim(), '9001', 'only alpha\'s pid is killed');
  assert.match(read(claudeLog), /rm alpha/);
  assert.doesNotMatch(read(claudeLog), /rm bravo/);
  assert.ok(!fs.existsSync(localAvFile(home, 'alpha')), 'the targeted row is dropped');
  assert.ok(fs.existsSync(localAvFile(home, 'bravo')), 'the other local session survives untouched');
});

test('do_remove (remote): purges only the targeted session over ssh, local files untouched', { skip }, () => {
  const { env, home, sshLog } = makeEnv();
  localFile(home, 'localkeep', { session: 'localkeep', host: SELF, cwd: '/r/lk', state: 'idle', kind: 'host', locator: 'tmux:/s:lk:%1' });
  remoteCache(home, [
    { session: 'rg', host: REMOTE1, cwd: '/r/rg', kind: 'host', state: 'working', locator: 'tmux:/s:rg:%2' },
    { session: 'rk', host: REMOTE1, cwd: '/r/rk', kind: 'host', state: 'idle', locator: 'tmux:/s:rk:%1' },
  ]);
  const key = rowKey({ host: REMOTE1, cwd: '/r/rg', locator: 'tmux:/s:rg:%2' });
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
  assert.match(read(sshLog), /daniel-server/);
  assert.match(read(sshLog), /s=rg/, 'purges the selected sid');
  assert.doesNotMatch(read(sshLog), /s=rk/, 'never touches the other remote sid');
  assert.ok(fs.existsSync(localAvFile(home, 'localkeep')), 'a remote removal never touches local files');
  const after = read(cacheFile(home));
  assert.doesNotMatch(after, /"rg"/, 'the purged remote row leaves the cache');
  assert.match(after, /"rk"/, 'the other remote row stays cached');
});

test('do_remove (Windows): taskkills only that pid, never touches local files or the remote cache', { skip }, () => {
  const { env, home, windir, taskkillLog, sshLog } = makeEnv();
  winFile(windir, 'w1', { session: 'w1', host: WINHOST, cwd: 'C:\\p1', state: 'idle', kind: 'host', locator: 'wezterm:9', pid: '4242' });
  localFile(home, 'localsafe', { session: 'localsafe', host: SELF, cwd: '/r/safe', state: 'idle', kind: 'host', locator: 'tmux:/s:safe:%1' });
  remoteCache(home, [{ session: 'rsafe', host: REMOTE1, cwd: '/r/rsafe', kind: 'host', state: 'idle', locator: 'tmux:/s:rsafe:%1' }]);
  const key = rowKey({ host: WINHOST, cwd: 'C:\\p1', locator: 'wezterm:9' });
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
  assert.match(read(taskkillLog), /4242/, 'the Windows pid is taskkilled');
  assert.ok(!fs.existsSync(winAvFile(windir, 'w1')), 'the Windows registry row is dropped');
  assert.ok(fs.existsSync(localAvFile(home, 'localsafe')), 'local files are untouched by a Windows removal');
  assert.match(read(cacheFile(home)), /"rsafe"/, 'the remote cache is untouched by a Windows removal');
  assert.strictEqual(read(sshLog), '', 'no ssh for a same-machine Windows removal');
});

test('do_remove (remote): two hosts sharing a cwd — removing one never sshes or filters the other', { skip }, () => {
  const { env, home, sshLog } = makeEnv();
  // Legacy locator-less rows: same cwd, different host. Only the host field must gate the match.
  remoteCache(home, [
    { session: 'sida', host: REMOTE1, cwd: '/shared/proj', kind: 'host', state: 'working', locator: '' },
    { session: 'sidb', host: REMOTE2, cwd: '/shared/proj', kind: 'host', state: 'working', locator: '' },
  ]);
  const key = rowKey({ host: REMOTE1, cwd: '/shared/proj', locator: '' });
  assert.strictEqual(run(env, ['--remove', key], { FZF_PICK: 'Remove' }).code, 0);
  const ssh = read(sshLog);
  assert.match(ssh, /daniel-server/);
  assert.match(ssh, /s=sida/);
  assert.doesNotMatch(ssh, /other-remote-host/, 'never sshes to the OTHER host sharing the cwd');
  assert.doesNotMatch(ssh, /s=sidb/, 'never purges the other host\'s sid');
  const after = read(cacheFile(home));
  assert.doesNotMatch(after, /"sida"/, 'the targeted host\'s row leaves the cache');
  assert.match(after, /"sidb"/, 'the other host\'s row (same cwd) survives');
});

// ==========================================================================
// do_pin — pin identity must distinguish rows that share host+cwd but differ
// by kind/locator, and toggling one must never disturb another's pin.
// ==========================================================================
test('do_pin: identity distinguishes rows across kind/locator, toggling one leaves the rest', { skip }, () => {
  const { env, home } = makeEnv();
  const hostKey = rowKey({ cwd: '/r/shared', kind: 'host', locator: 'none:' });
  const sandboxKey = rowKey({ cwd: '/r/shared', kind: 'sandbox', locator: 'none:' });
  const bgKey = rowKey({ cwd: '/r/bg', kind: 'bg', locator: 'bg:jobid' });
  const winKey = rowKey({ host: WINHOST, cwd: 'C:\\p', kind: 'host', locator: 'wezterm:5' });

  run(env, ['--pin', hostKey]);
  run(env, ['--pin', sandboxKey]);
  run(env, ['--pin', bgKey]);
  run(env, ['--pin', winKey]);
  let pins = read(pinFile(home)).split('\n').filter(Boolean);
  assert.ok(pins.includes(`${SELF}${US}/r/shared${US}host`), 'host-kind pin id');
  assert.ok(pins.includes(`${SELF}${US}/r/shared${US}sandbox`), 'sandbox-kind pin id is distinct from host-kind at the same cwd');
  assert.ok(pins.includes('bg:jobid'), 'a real bg locator is its own pin id');
  assert.ok(pins.includes('wezterm:5'), 'a real Windows locator is its own pin id');

  run(env, ['--pin', hostKey]); // unpin only the host-kind row
  pins = read(pinFile(home)).split('\n').filter(Boolean);
  assert.ok(!pins.includes(`${SELF}${US}/r/shared${US}host`), 'the toggled pin is gone');
  assert.ok(pins.includes(`${SELF}${US}/r/shared${US}sandbox`), 'the sandbox-kind pin (same cwd) survives');
  assert.ok(pins.includes('bg:jobid'), 'the bg pin survives');
  assert.ok(pins.includes('wezterm:5'), 'the Windows pin survives');
});

// ==========================================================================
// do_rename / av_send_rename — local WEZTERM backend (as distinct from the
// already-covered tmux and Windows-wezterm.exe branches).
// ==========================================================================
test('do_rename: local wezterm pane gets /rename via local wezterm cli, no tmux/ssh/Windows involved', { skip }, () => {
  const { env, wezSendLog, tmuxLog, sshLog, wezwinSendLog } = makeEnv();
  const key = rowKey({ cwd: '/r/w', state: 'idle', locator: 'wezterm:12' });
  assert.strictEqual(run(env, ['--rename', key], {}, 'New Title\n').code, 0);
  const sent = read(wezSendLog);
  assert.match(sent, /send-text.*--no-paste --pane-id 12/);
  assert.match(sent, /\/rename New Title/);
  assert.strictEqual(read(tmuxLog), '', 'no tmux for a wezterm-backed rename');
  assert.strictEqual(read(sshLog), '', 'no ssh for a local rename');
  assert.strictEqual(read(wezwinSendLog), '', 'never the Windows wezterm.exe for a local pane');
});

test('do_rename: every wezterm cli call carries --no-auto-start', { skip }, () => {
  // Without it a cli that finds no server does not fail — it STARTS one (wezterm-mux-server),
  // which comes up owning a default pane numbered from 0. That is a stray daemon, and its pane
  // ids collide with the real ones wezterm-pane-ssh resolves through $WEZTERM_PANE.
  const { env, wezSendLog } = makeEnv();
  const key = rowKey({ cwd: '/r/w', state: 'idle', locator: 'wezterm:12' });
  assert.strictEqual(run(env, ['--rename', key], {}, 'New Title\n').code, 0);
  assert.match(read(wezSendLog), /--no-auto-start/);
});

test('do_rename: under WSL the rename goes out through wezterm.exe, still --no-auto-start', { skip }, () => {
  const { env, wezSendLog, wezwinSendLog } = makeEnv();
  const key = rowKey({ cwd: '/r/w', state: 'idle', locator: 'wezterm:12' });
  assert.strictEqual(run(env, ['--rename', key], { WSL_DISTRO_NAME: 'Ubuntu' }, 'New Title\n').code, 0);
  const sent = read(wezwinSendLog);
  assert.match(sent, /send-text.*--no-paste --pane-id 12/);
  assert.match(sent, /--no-auto-start/);
  assert.strictEqual(read(wezSendLog), '', 'the Linux cli cannot reach the GUI from WSL');
});

// ==========================================================================
// title_for_cwd / load_titles — the mux-correlated title fallback when a row
// carries no registry title of its own.
// ==========================================================================
test('title_for_cwd fills a titleless row from the wezterm pane title, skipping shell panes, matching by prefix', { skip }, () => {
  const { env, home, wezListFile } = makeEnv();
  fs.writeFileSync(wezListFile, JSON.stringify([
    pane(1, 'file:///proj/x', 'bash'),          // shell — must be ignored by JQ_NONSHELL
    pane(2, 'file:///proj/x', 'Fixing bug'),    // the real Claude pane at that cwd
  ]));
  const now = nowSec();
  // Exact cwd match, no registry title of its own.
  localFile(home, 'exact', { session: 'exact', host: SELF, cwd: '/proj/x', state: 'working', kind: 'host', ts: now - 5, locator: 'none:', title: '' });
  // Subdirectory of the pane's cwd — title_for_cwd's prefix match must still resolve it.
  localFile(home, 'sub', { session: 'sub', host: SELF, cwd: '/proj/x/subdir', state: 'working', kind: 'host', ts: now - 6, locator: 'none:', title: '' });
  const body = stripAnsi(run(env, ['--body']).out);
  assert.match(body, /Fixing bug/, 'the non-shell pane title fills the exact-match row');
  const lines = body.split('\n').filter((l) => l.includes('Fixing bug'));
  assert.strictEqual(lines.length, 2, 'both the exact-cwd row and the subdirectory row pick up the pane title');
  assert.doesNotMatch(body, /\bbash\b/, 'the shell pane title never leaks into a row');
});

// ==========================================================================
// ssh quoting through tmux: %q protection must survive shell reparse with spaces
// ==========================================================================
test('remote tmux new-window embeds ssh with proper quoting for ControlPath containing space', { skip }, () => {
  const paths = makeEnv();
  // Create a control directory with a space to test quoting
  const ctldir = scratch('av-ctl ');
  const key = rowKey({ host: REMOTE1, cwd: '/home/ubuntu/r', kind: 'host', locator: 'tmux:/tmp/tmux-1000/default:rsess:%4' });
  const env = {
    ...paths.env,
    TMUX: '/tmp/tmux-1000/default,1,0',
    AGENT_VIEW_SSH_CTLDIR: ctldir,
  };
  run(env, ['--jump', key], {});
  // Jump fails (no pane), but ssh was called. Read argv with boundaries preserved
  // (one element per line, calls separated by \x1e) rather than the space-joined
  // sshLog: a ControlPath split by the space in `ctldir` and a ControlPath kept
  // intact as one argument both flatten to identical text once joined with "$*",
  // so only the unflattened argv can tell correct quoting from broken quoting.
  const calls = read(paths.sshArgvLog).split('\x1e\n').map((c) => c.split('\n').filter(Boolean)).filter((c) => c.length);
  assert.ok(calls.length, 'expected an ssh call through tmux');
  const argv = calls[0];
  const controlPathArgs = argv.filter((a) => a.startsWith('ControlPath='));
  assert.strictEqual(controlPathArgs.length, 1, 'ControlPath= should appear as exactly one argv element');
  assert.strictEqual(controlPathArgs[0], `ControlPath=${ctldir}/%C`, 'ControlPath must survive as a single intact argv element, not split by the space in the directory name');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
