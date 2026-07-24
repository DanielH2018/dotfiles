// Regression guard for the Windows-source integration in executable_agentview: same-machine
// Windows-native Claude sessions surfaced over /mnt/c, focused/killed/renamed via the Windows
// wezterm.exe + taskkill.exe rather than ssh. Hermetic — stubs hostname/wezterm.exe/taskkill
// on PATH and points AGENT_VIEW_WINDIR at a temp dir. Unlike agentview.test.js (which reports
// hostname == daniel-desktop, i.e. self IS the Windows host), here hostname == daniel-wsl so
// the Windows side is a DISTINCT source and its cross-boundary branches engage.
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
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'bash'); if (fs.existsSync(p)) return p;
  }
  return 'bash';
}
const BASH = findBash();

const SELF = 'daniel-wsl';       // where agentview runs
const WINHOST = 'daniel-desktop'; // the Windows side of the same machine
const nowSec = () => Math.floor(Date.now() / 1000);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:]*m/g, '');
const cardKey = (fields) => fields.join(US); // host|cwd|state|ts|title|pane|kind|locator

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// A hermetic env: stub bin (hostname/wezterm.exe/taskkill.exe/ssh/fzf/curl), temp HOME, temp windir.
function makeEnv() {
  const bin = scratch('avw-bin-');
  const home = scratch('avw-home-');
  const windir = scratch('avw-win-');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });

  const activateLog = path.join(bin, 'wezwin-activate.log'); fs.writeFileSync(activateLog, '');
  const sendLog = path.join(bin, 'wezwin-send.log'); fs.writeFileSync(sendLog, '');
  const killLog = path.join(bin, 'taskkill.log'); fs.writeFileSync(killLog, '');
  const sshLog = path.join(bin, 'ssh.log'); fs.writeFileSync(sshLog, '');
  const capture = path.join(bin, 'fzf-capture.txt'); fs.writeFileSync(capture, '');

  // Windows wezterm.exe stub: log activate-pane ids and send-text payloads. $WEZWIN_PANES, when
  // set to a `cli list --format json` payload, makes the stub model a REAL mux — it serves that
  // inventory and fails activate-pane for any id not in it, the way the real binary answers a
  // stale locator with "Error: pane N not found". Unset, it accepts every id (the pre-existing
  // tests predate the inventory and only care that the right id was asked for).
  const wezwin = path.join(bin, 'wezterm-win.sh');
  fs.writeFileSync(wezwin, `#!/bin/bash
case "$*" in
  *"cli list"*)    printf '%s' "\${WEZWIN_PANES:-}" ;;
  *activate-pane*)
    prev=""; id=""
    for a in "$@"; do [ "$prev" = "--pane-id" ] && id="$a"; prev="$a"; done
    echo "$id" >> "$WEZWIN_ACTIVATE_LOG"
    if [ -n "\${WEZWIN_PANES:-}" ]; then
      printf '%s' "$WEZWIN_PANES" | jq -e --arg p "$id" 'any(.[]; (.pane_id|tostring) == $p)' >/dev/null 2>&1 || exit 1
    fi ;;
  *send-text*)     echo "$*" >> "$WEZWIN_SEND_LOG" ;;
  *spawn*)         echo "$*" >> "$WEZWIN_SEND_LOG" ;;
esac
exit 0
`, { mode: 0o755 });
  // taskkill.exe stub: log the pid it was asked to kill.
  fs.writeFileSync(path.join(bin, 'taskkill.exe'), `#!/bin/bash
echo "$*" >> "$TASKKILL_LOG"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
echo "$*" >> "$SSH_LOG"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash
cat > "$FZF_CAPTURE"
[ -n "\${FZF_PICK:-}" ] && printf '%s\\n' "$FZF_PICK"
exit \${FZF_RC:-0}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash
echo "${SELF}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
exit 0
`, { mode: 0o755 });

  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    AGENT_VIEW_WINDIR: windir,
    AGENT_VIEW_WEZTERM_WIN: wezwin,      // stub stands in for the real wezterm.exe
    AV_WINKILL: path.join(bin, 'taskkill.exe'),
    WEZWIN_ACTIVATE_LOG: activateLog, WEZWIN_SEND_LOG: sendLog,
    TASKKILL_LOG: killLog, SSH_LOG: sshLog, FZF_CAPTURE: capture,
  };
  delete env.TMUX; delete env.WEZTERM_PANE;
  return { bin, home, windir, env, activateLog, sendLog, killLog, sshLog, capture };
}

function winRow(windir, sid, obj) {
  fs.writeFileSync(path.join(windir, `${sid}.json`), JSON.stringify(obj));
}
function wslRow(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
function run(env, args, input = '') {
  try {
    return { out: execFileSync(BASH, [VIEW, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env, input }), code: 0, err: '' };
  } catch (e) { return { out: e.stdout || '', code: e.status, err: e.stderr || '' }; }
}

// ---- discovery + labels -------------------------------------------------
test('--body surfaces a Windows session with a PC badge alongside a WSL row', { skip }, () => {
  const { env, home, windir } = makeEnv();
  const ts = nowSec() - 120;
  winRow(windir, 'w1', { key: 'w1', session: 'w1', host: WINHOST, cwd: 'C:\\Users\\daniel\\My_Vault', state: 'working', ts, kind: 'host', locator: 'wezterm:1', pane: '', title: 'Windows task', pid: '4242' });
  wslRow(home, 'l1', { key: 'l1', session: 'l1', host: SELF, cwd: '/home/daniel/dev', state: 'working', ts, kind: 'host', locator: 'tmux:/tmp/t:s:%1', pane: '', title: 'WSL task', pid: '' });
  const txt = stripAnsi(run(env, ['--body']).out);
  assert.match(txt, /Windows task/, 'Windows row renders');
  assert.match(txt, /\bPC\b/, 'Windows row carries the PC badge');
  assert.match(txt, /WSL task/, 'WSL row still renders');
  assert.match(txt, /\bWSL\b/, 'WSL row carries the WSL badge');
});

test('--card labels a Windows session PC · daniel-desktop', { skip }, () => {
  const { env } = makeEnv();
  const blob = cardKey([WINHOST, 'C:\\Users\\daniel\\My_Vault', 'working', String(nowSec() - 60), 'fixing parser', '1', 'host', 'wezterm:1']);
  const txt = stripAnsi(run(env, ['--card', blob]).out);
  assert.match(txt, new RegExp(`Machine\\s+PC · ${WINHOST}`));
  assert.match(txt, /Folder\s+My_Vault/);
});

test('a >7d Windows row is pruned from the windir', { skip }, () => {
  const { env, windir } = makeEnv();
  const old = nowSec() - 8 * 86400;
  winRow(windir, 'stale', { key: 'stale', session: 'stale', host: WINHOST, cwd: 'C:\\x', state: 'idle', ts: old, kind: 'host', locator: 'none:', pane: '', title: '', pid: '1' });
  run(env, ['--body']);
  assert.ok(!fs.existsSync(path.join(windir, 'stale.json')), 'stale Windows row deleted');
});

// ---- jump (focus in place, no ssh, no new tab) --------------------------
test('--jump of a Windows row activates its pane via wezterm.exe, not ssh', { skip }, () => {
  const { env, activateLog, sshLog } = makeEnv();
  const key = cardKey([WINHOST, 'C:\\Users\\daniel\\My_Vault', 'working', '0', 'task', '1', 'host', 'wezterm:7']);
  run(env, ['--jump', key]);
  assert.match(fs.readFileSync(activateLog, 'utf8'), /(^|\n)7(\n|$)/, 'activate-pane called with pane 7');
  assert.strictEqual(fs.readFileSync(sshLog, 'utf8'), '', 'no ssh for a same-machine Windows row');
});

// ---- jump with a stale locator ------------------------------------------
// A Windows session outlives its pane id (the mux renumbers on a domain re-attach) but keeps
// writing the old one, because its hook reads $WEZTERM_PANE from the session's own frozen
// environment. The picker must not trust the recorded id blindly.
const WIN_PANES_ARR = [
  { window_id: 0, tab_id: 0, pane_id: 0, title: 'wezterm.exe', cwd: 'file://daniel-wsl/home/daniel/dev' },
  { window_id: 0, tab_id: 4, pane_id: 5, title: 'Investigate typing lag', cwd: 'file://daniel-desktop/c/Users/daniel' },
];
const WIN_PANES = JSON.stringify(WIN_PANES_ARR);
const activated = (log) => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
// --body renders row KEYs through jq's @tsv, which escapes every backslash as two — so the key
// fzf hands back for a Windows row really does carry "C:\\Users\\daniel". Build the fixtures the
// way the picker builds them, or these tests pass on a path production never takes.
const tsvCwd = (p) => p.replace(/\\/g, '\\\\');

test('--jump re-resolves a stale Windows pane id by cwd instead of no-oping', { skip }, () => {
  const { env, activateLog } = makeEnv();
  // Row says pane 12; the live mux only has 0 (a WSL shell) and 5 (this session, one dir up).
  const key = cardKey([WINHOST, tsvCwd('C:\\Users\\daniel\\dotfiles'), 'working', '0', 'task', '12', 'host', 'wezterm:12']);
  const r = run({ ...env, WEZWIN_PANES: WIN_PANES }, ['--jump', key]);
  const ids = activated(activateLog);
  assert.ok(ids.includes('12'), 'tries the recorded pane first');
  assert.ok(ids.includes('5'), 'falls back to the live Windows pane serving that cwd');
  assert.ok(!ids.includes('0'), 'never grabs the WSL pane — its cwd does not correlate');
  assert.strictEqual(r.code, 0, 'a re-resolved jump reports success');
});

test('--jump falls back to a bare-shell pane when no retitled pane matches', { skip }, () => {
  const { env, activateLog } = makeEnv();
  const panes = JSON.stringify([
    { window_id: 0, tab_id: 1, pane_id: 7, title: 'bash.exe', cwd: 'file://daniel-desktop/c/Users/daniel' },
  ]);
  const key = cardKey([WINHOST, tsvCwd('C:\\Users\\daniel'), 'idle', '0', 'task', '12', 'host', 'wezterm:12']);
  run({ ...env, WEZWIN_PANES: panes }, ['--jump', key]);
  assert.ok(activated(activateLog).includes('7'), 'second tier accepts a pane Claude never retitled');
});

// ---- jump tier 3: no pane anywhere --------------------------------------
// A Windows session can outlive its pane entirely — close the tab and the process (plus its
// hook) keeps running, refreshing a row that offers a jump nothing can serve. A Windows pty
// can't be attached from WSL the way a tmux one can, so the only way back in is a fresh pane.
test('--jump reopens a Windows session whose pane is gone, resuming its conversation', { skip }, () => {
  const { env, windir, activateLog, sendLog } = makeEnv();
  winRow(windir, 'w9', { key: 'w9', session: 'w9', host: WINHOST, cwd: 'C:\\Users\\daniel\\dotfiles', state: 'needs-input', ts: nowSec() - 60, kind: 'host', locator: 'wezterm:12', pane: '12', title: 'orphan', pid: '29644' });
  const key = cardKey([WINHOST, tsvCwd('C:\\Users\\daniel\\dotfiles'), 'needs-input', '0', 'orphan', '12', 'host', 'wezterm:12']);
  // The live mux has pane 0 (a WSL shell) and pane 5 (cwd c/Users/daniel) — neither serves
  // ...\dotfiles, so both the recorded id and the cwd correlation come up empty.
  const r = run({ ...env, WEZWIN_PANES: JSON.stringify([WIN_PANES_ARR[0]]) }, ['--jump', key]);
  assert.strictEqual(r.code, 0, 'a reopened session is a successful jump');
  const spawned = fs.readFileSync(sendLog, 'utf8');
  assert.match(spawned, /cli spawn --domain-name local/, 'opens a new Windows tab');
  assert.match(spawned, /--resume w9/, 'resumes the row\'s own conversation, not a blank one');
  assert.match(spawned, /C:\/Users\/daniel\/dotfiles/, 'lands in the row cwd, backslashes undoubled');
  assert.deepStrictEqual(activated(activateLog), ['12'], 'no unrelated pane was activated');
});

test('--jump still fails loudly when there is nothing to reopen', { skip }, () => {
  const { env, activateLog, sendLog } = makeEnv();
  // No cwd on the row and no windir entry: nothing to correlate, resume, or even cd into.
  const key = cardKey([WINHOST, '', 'working', '0', 'task', '12', 'host', 'wezterm:12']);
  const r = run({ ...env, WEZWIN_PANES: WIN_PANES }, ['--jump', key]);
  assert.notStrictEqual(r.code, 0, 'a jump that focused nothing must not exit 0');
  assert.match(r.err, /no pane found/, 'and must say so — silence reads as a dead keybinding');
  assert.strictEqual(fs.readFileSync(sendLog, 'utf8'), '', 'and must not spawn a blank session');
  assert.deepStrictEqual(activated(activateLog), ['12'], 'no unrelated pane was activated');
});

test('--jump does not respawn when a live pane still serves the row', { skip }, () => {
  const { env, windir, sendLog } = makeEnv();
  winRow(windir, 'w5', { key: 'w5', session: 'w5', host: WINHOST, cwd: 'C:\\Users\\daniel', state: 'working', ts: nowSec() - 60, kind: 'host', locator: 'wezterm:5', pane: '5', title: 'live', pid: '1' });
  const key = cardKey([WINHOST, tsvCwd('C:\\Users\\daniel'), 'working', '0', 'live', '5', 'host', 'wezterm:5']);
  const r = run({ ...env, WEZWIN_PANES: WIN_PANES }, ['--jump', key]);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(sendLog, 'utf8'), '', 'focusing a live pane must never open a second one');
});

test('--jump leaves a live locator alone (no needless re-resolve)', { skip }, () => {
  const { env, activateLog } = makeEnv();
  const key = cardKey([WINHOST, 'C:\\Users\\daniel\\dotfiles', 'working', '0', 'task', '5', 'host', 'wezterm:5']);
  const r = run({ ...env, WEZWIN_PANES: WIN_PANES }, ['--jump', key]);
  assert.deepStrictEqual([...new Set(activated(activateLog))], ['5'], 'activates the recorded pane, nothing else');
  assert.strictEqual(r.code, 0);
});

// ---- remove (taskkill + drop the windir row, no ssh) --------------------
test('--remove of a Windows row taskkills the pid and drops its windir file', { skip }, () => {
  const { env, windir, killLog, sshLog } = makeEnv();
  winRow(windir, 'w9', { key: 'w9', session: 'w9', host: WINHOST, cwd: 'C:\\p', state: 'idle', ts: nowSec(), kind: 'host', locator: 'wezterm:9', pane: '', title: 't', pid: '5150' });
  const key = cardKey([WINHOST, 'C:\\p', 'idle', '0', 't', '9', 'host', 'wezterm:9']);
  run(env, ['--remove', key], 'y\n');
  assert.match(fs.readFileSync(killLog, 'utf8'), /5150/, 'taskkill invoked on the Windows pid');
  assert.ok(!fs.existsSync(path.join(windir, 'w9.json')), 'Windows row file removed');
  assert.strictEqual(fs.readFileSync(sshLog, 'utf8'), '', 'no ssh for a same-machine Windows remove');
});

// ---- rename (send /rename into the Windows pane) ------------------------
test('--rename of an idle Windows row sends /rename via wezterm.exe send-text', { skip }, () => {
  const { env, sendLog } = makeEnv();
  const key = cardKey([WINHOST, 'C:\\p', 'idle', '0', 'old', '3', 'host', 'wezterm:3']);
  run(env, ['--rename', key], 'renamed title\n');
  assert.match(fs.readFileSync(sendLog, 'utf8'), /send-text.*--pane-id 3.*\/rename renamed title/, 'send-text carried the /rename to pane 3');
});

// ---- spawn (a new Windows-native session from the picker) ---------------
test('--spawn offers a Windows entry and opens a local-domain WezTerm tab', { skip }, () => {
  const { env, sendLog, capture } = makeEnv();
  run({ ...env, FZF_PICK: 'PC (Windows)' }, ['--spawn']);
  assert.match(fs.readFileSync(capture, 'utf8'), /PC \(Windows\)/, 'the host pick lists the Windows (PC) entry');
  const spawnLog = fs.readFileSync(sendLog, 'utf8');
  assert.match(spawnLog, /spawn --domain-name local/, 'spawns a Windows local-domain tab via wezterm.exe');
  // The exe must be the absolute Windows git bash, NOT a bare `bash` (which resolves into WSL —
  // wrong $HOME/claude, so the session never registers on the Windows side).
  assert.match(spawnLog, /Git\\bin\\bash\.exe/, 'spawns via the absolute Windows git bash path');
  assert.doesNotMatch(spawnLog, /-- bash /, 'never spawns a bare bash (would land in WSL)');
  // Lands in a trusted folder (the Vault) so Claude runs hooks and the session registers.
  assert.match(spawnLog, /cd ~\/My_Vault/, 'lands the new session in the trusted Vault');
});
