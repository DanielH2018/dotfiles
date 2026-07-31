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
const { agentviewWinSeams } = require('./lib/agentview-env');

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

  // This suite is the one that drives the Windows seams rather than just isolating them, so it
  // supplies behaviour for both stubs instead of taking the inert defaults.
  //
  // wezterm.exe: log activate-pane ids and send-text payloads. $WEZWIN_PANES, when set to a
  // `cli list --format json` payload, makes the stub model a REAL mux — it serves that
  // inventory and fails activate-pane for any id not in it, the way the real binary answers a
  // stale locator with "Error: pane N not found". Unset, it accepts every id (the pre-existing
  // tests predate the inventory and only care that the right id was asked for).
  //
  // claude.exe: answers `agents --json` from $WIN_AGENTS — the daemon roster that decides
  // whether a paneless session is still attachable. Default [] means "daemon holds nothing",
  // the pre-existing respawn path. $WIN_AGENTS_RC forces the query to fail, which must never
  // be mistaken for an empty roster.
  const seams = agentviewWinSeams({
    bin,
    windir,
    weztermBody: `#!/bin/bash
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
`,
    winClaudeBody: `#!/bin/bash
case "$*" in
  *"agents --json"*)
    [ -n "\${WIN_AGENTS_RC:-}" ] && exit "\${WIN_AGENTS_RC}"
    printf '%s' "\${WIN_AGENTS:-[]}" ;;
esac
exit 0
`,
  });
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
    ...seams.env,
    // Windows rows only exist on a WSL host — they are discovered through the /mnt/c mount.
    // Most of this file got away without saying so because focus.sh and spawn.sh invoke
    // "$WEZTERM_WIN" directly, but av_send_rename goes through av_wezterm_bin, which picks the
    // Windows cli only under WSL. Without this the rename test ran as a plain-Linux host,
    // resolved `wezterm` off PATH, and silently sent nothing — passing on Daniel's WSL box and
    // failing on every other Linux machine.
    WSL_DISTRO_NAME: 'Ubuntu',
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

// ---- reap: reconcile the windir against the daemon roster ---------------
// A Windows session that dies without firing SessionEnd (tab killed hard, crash) leaves its
// registry file behind, and WSL has no checkable pid to notice — so the row lingers as a phantom
// offering a jump nothing can serve. The daemon roster is the stand-in for the `kill -0` the
// local prune gets for free, so the policy matches it: gone is gone, no 7-day wait. It costs
// ~0.7s, hence --refresh-remote (already detached for the homelab pull) rather than a render.
test('--refresh-remote reaps a Windows row the daemon no longer runs', { skip }, () => {
  const { env, home, windir } = makeEnv();
  const ts = nowSec() - 600;
  winRow(windir, 'ghost', { key: 'ghost', session: 'ghost', host: WINHOST, cwd: 'C:\\x', state: 'idle', ts, kind: 'host', locator: 'wezterm:12', pane: '12', title: 'phantom row', pid: '1' });
  wslRow(home, 'l1', { key: 'l1', session: 'l1', host: SELF, cwd: '/home/daniel/dev', state: 'working', ts, kind: 'host', locator: 'tmux:/tmp/t:s:%1', pane: '', title: 'WSL task', pid: '' });
  run({ ...env, WIN_AGENTS: '[]' }, ['--refresh-remote']);
  assert.ok(!fs.existsSync(path.join(windir, 'ghost.json')), 'a session absent from the roster is reaped');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'agent-view', 'l1.json')), 'the Windows roster says nothing about WSL rows');
  assert.doesNotMatch(stripAnsi(run(env, ['--body']).out), /phantom row/, 'and the row is gone from the next render');
});

test('--refresh-remote keeps a Windows row the daemon still runs', { skip }, () => {
  const { env, windir } = makeEnv();
  // The detached-but-live case: no pane, hook state long stale, yet the daemon holds its pty.
  // Reaping this row would delete a session the user is still using.
  winRow(windir, 'w9', { key: 'w9', session: 'w9', host: WINHOST, cwd: 'C:\\x', state: 'needs-input', ts: nowSec() - 600, kind: 'host', locator: 'wezterm:12', pane: '12', title: 'detached', pid: '1' });
  const agents = JSON.stringify([{ id: 'w9short', sessionId: 'w9', kind: 'background', status: 'idle' }]);
  run({ ...env, WIN_AGENTS: agents }, ['--refresh-remote']);
  assert.ok(fs.existsSync(path.join(windir, 'w9.json')), 'a session on the roster is live, whatever its pane says');
});

test('--refresh-remote reaps nothing when the roster query fails', { skip }, () => {
  const { env, windir } = makeEnv();
  const ts = nowSec() - 600;
  winRow(windir, 'a', { key: 'a', session: 'a', host: WINHOST, cwd: 'C:\\a', state: 'idle', ts, kind: 'host', locator: 'none:', pane: '', title: 'a', pid: '1' });
  winRow(windir, 'b', { key: 'b', session: 'b', host: WINHOST, cwd: 'C:\\b', state: 'idle', ts, kind: 'host', locator: 'none:', pane: '', title: 'b', pid: '2' });
  run({ ...env, WIN_AGENTS_RC: '3' }, ['--refresh-remote']);
  assert.ok(fs.existsSync(path.join(windir, 'a.json')), 'an unreachable oracle is not evidence of death');
  assert.ok(fs.existsSync(path.join(windir, 'b.json')), 'one broken query must not wipe every Windows row');
});

test('--refresh-remote spares a just-started Windows row not yet on the roster', { skip }, () => {
  const { env, windir } = makeEnv();
  // The hook writes the row and the session registers with the daemon independently, so a
  // newborn session is briefly on disk but absent from the roster. REAP_GRACE covers that gap.
  winRow(windir, 'newborn', { key: 'newborn', session: 'newborn', host: WINHOST, cwd: 'C:\\n', state: 'working', ts: nowSec(), kind: 'host', locator: 'wezterm:3', pane: '3', title: 'newborn', pid: '1' });
  run({ ...env, WIN_AGENTS: '[]' }, ['--refresh-remote']);
  assert.ok(fs.existsSync(path.join(windir, 'newborn.json')), 'a session younger than the grace window is not reapable');
});

// ---- sync: synthesize rows for live sessions no hook registered ---------
// The registry is written by state hooks, which fire only AFTER activity. A session started or
// resumed and then left idle submits no prompt and ends no turn, so it never wrote a row and the
// picker could not see it — nothing had been reaped, there was never a row. The daemon roster
// already knows the session, so the same query that drives the reap fills the gap.
test('--refresh-remote synthesizes a row for a live session that never registered one', { skip }, () => {
  const { env, windir } = makeEnv();
  const agents = JSON.stringify([{ id: 'n3w', sessionId: 'unreg', cwd: 'C:\\Users\\daniel',
    kind: 'background', status: 'busy', name: 'never registered', startedAt: (nowSec() - 300) * 1000 }]);
  run({ ...env, WIN_AGENTS: agents }, ['--refresh-remote']);
  const file = path.join(windir, 'unreg.json');
  assert.ok(fs.existsSync(file), 'a live session with no row gets one');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(row.session, 'unreg', 'keyed by the stable session id');
  assert.strictEqual(row.host, WINHOST, 'attributed to the Windows host, so it renders with a PC badge');
  assert.strictEqual(row.state, 'working', 'roster status busy maps to working');
  assert.strictEqual(row.cwd, 'C:\\Users\\daniel',
    'the Windows cwd round-trips verbatim — @tsv would have escaped it to C:\\\\Users\\\\daniel');
  assert.ok(row.ts > nowSec() - 400 && row.ts <= nowSec(), 'startedAt (ms) becomes a second-resolution ts');
  const txt = stripAnsi(run(env, ['--body']).out);
  assert.match(txt, /never registered/, 'and the row renders in the picker');
  assert.match(txt, /\bPC\b/, 'carrying the PC badge');
});

test('--refresh-remote never overwrites a row a hook already wrote', { skip }, () => {
  const { env, windir } = makeEnv();
  // The hook captured a real pane; the roster cannot supply one. Synthesizing over the top would
  // silently downgrade a direct jump to "no pane", so an existing file is left strictly alone.
  winRow(windir, 'w5', { key: 'w5', session: 'w5', host: WINHOST, cwd: 'C:\\real', state: 'needs-input', ts: nowSec() - 600, kind: 'host', locator: 'wezterm:12', pane: '12', title: 'hook title', pid: '99' });
  const agents = JSON.stringify([{ id: 'w5short', sessionId: 'w5', cwd: 'C:\\roster', kind: 'background', status: 'idle', name: 'roster title', startedAt: nowSec() * 1000 }]);
  run({ ...env, WIN_AGENTS: agents }, ['--refresh-remote']);
  const row = JSON.parse(fs.readFileSync(path.join(windir, 'w5.json'), 'utf8'));
  assert.strictEqual(row.locator, 'wezterm:12', 'the hook-captured pane survives');
  assert.strictEqual(row.title, 'hook title', 'and so does its title');
});

test('a synthesized row locates a background session by agent id, an interactive one not at all', { skip }, () => {
  const { env, windir } = makeEnv();
  const agents = JSON.stringify([
    { id: 'sh0rt', sessionId: 'bgsid', cwd: 'C:\\b', kind: 'background', status: 'idle', name: 'bg', startedAt: nowSec() * 1000 },
    { pid: 4242, sessionId: 'intsid', cwd: 'C:\\i', kind: 'interactive', status: 'idle', name: 'int', startedAt: nowSec() * 1000 },
  ]);
  run({ ...env, WIN_AGENTS: agents }, ['--refresh-remote']);
  const bg = JSON.parse(fs.readFileSync(path.join(windir, 'bgsid.json'), 'utf8'));
  const int = JSON.parse(fs.readFileSync(path.join(windir, 'intsid.json'), 'utf8'));
  assert.strictEqual(bg.locator, 'bg:sh0rt', 'a daemon-held session is attachable by its agent id');
  assert.strictEqual(bg.kind, 'bg', 'and is labelled bg');
  assert.strictEqual(int.locator, 'none:', 'an interactive session has no pane WSL can name — never invent one');
});

test('--refresh-remote synthesizes nothing when the roster query fails', { skip }, () => {
  const { env, windir } = makeEnv();
  run({ ...env, WIN_AGENTS_RC: '3' }, ['--refresh-remote']);
  assert.strictEqual(fs.readdirSync(windir).length, 0, 'an unreachable oracle invents no rows');
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
// hook) keeps running, refreshing a row that offers a jump nothing can serve. What tier 3 does
// about that turns on a distinction panes cannot see: a detached session whose daemon still
// holds its pty is LIVE and must be attached, while one the daemon has forgotten is gone and can
// only be resumed. Resuming a live one forks a second process onto its transcript, so the roster
// (`claude agents --json`) is the oracle here, not the mux inventory.
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

test('--jump attaches a paneless session the daemon still holds, never resuming it', { skip }, () => {
  const { env, windir, sendLog } = makeEnv();
  winRow(windir, 'w9', { key: 'w9', session: 'w9', host: WINHOST, cwd: 'C:\\Users\\daniel\\dotfiles', state: 'idle', ts: nowSec() - 60, kind: 'host', locator: 'wezterm:12', pane: '12', title: 'detached', pid: '29644' });
  const key = cardKey([WINHOST, tsvCwd('C:\\Users\\daniel\\dotfiles'), 'idle', '0', 'detached', '12', 'host', 'wezterm:12']);
  // The row looks identical to the reopen case above — same dead pane, same missing cwd
  // correlation. Only the roster distinguishes them.
  const agents = JSON.stringify([{ pid: 29644, id: 'w9short', sessionId: 'w9', kind: 'background', status: 'idle' }]);
  const r = run({ ...env, WEZWIN_PANES: JSON.stringify([WIN_PANES_ARR[0]]), WIN_AGENTS: agents }, ['--jump', key]);
  assert.strictEqual(r.code, 0, 'an attached session is a successful jump');
  const spawned = fs.readFileSync(sendLog, 'utf8');
  assert.match(spawned, /claude attach w9short/, 'attaches by the daemon id, re-hosting the live pty');
  assert.doesNotMatch(spawned, /--resume/, 'resuming would fork a second process onto one transcript');
});

test('--jump reopens rather than attaches when the roster query itself fails', { skip }, () => {
  const { env, windir, sendLog } = makeEnv();
  winRow(windir, 'w9', { key: 'w9', session: 'w9', host: WINHOST, cwd: 'C:\\Users\\daniel\\dotfiles', state: 'idle', ts: nowSec() - 60, kind: 'host', locator: 'wezterm:12', pane: '12', title: 'detached', pid: '29644' });
  const key = cardKey([WINHOST, tsvCwd('C:\\Users\\daniel\\dotfiles'), 'idle', '0', 'detached', '12', 'host', 'wezterm:12']);
  const r = run({ ...env, WEZWIN_PANES: JSON.stringify([WIN_PANES_ARR[0]]), WIN_AGENTS_RC: '3' }, ['--jump', key]);
  assert.strictEqual(r.code, 0, 'an unreachable oracle must not turn a jump into a failure');
  const spawned = fs.readFileSync(sendLog, 'utf8');
  assert.match(spawned, /--resume w9/, 'falls back to reopening the conversation');
  assert.doesNotMatch(spawned, /claude attach/, 'and never invents an agent id it could not read');
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
  run({ ...env, FZF_PICK: 'Remove' }, ['--remove', key]);
  assert.match(fs.readFileSync(killLog, 'utf8'), /5150/, 'taskkill invoked on the Windows pid');
  assert.ok(!fs.existsSync(path.join(windir, 'w9.json')), 'Windows row file removed');
  assert.strictEqual(fs.readFileSync(sshLog, 'utf8'), '', 'no ssh for a same-machine Windows remove');
});

test('--remove of a pid-less Windows bg row taskkills the pid from the daemon roster', { skip }, () => {
  // A bg row synthesized from the roster (sync_windows_rows) carries no pid — only the daemon
  // knows it. Deleting the file alone is not a removal: the very next --refresh-remote asks the
  // roster, sees the job still running, and writes the row straight back. The roster is also the
  // only place that pid exists, so ask it before dropping the file.
  const { env, windir, killLog } = makeEnv();
  const sid = '3eeba696-5038-4ede-8030-c7db135032f1';
  winRow(windir, sid, { key: sid, session: sid, host: WINHOST, cwd: 'C:\\Users\\daniel', state: 'idle', ts: nowSec(), kind: 'bg', locator: 'bg:3eeba696', pane: '', title: 'Bg job', pid: '' });
  const roster = JSON.stringify([{ pid: 26984, id: '3eeba696', cwd: 'C:\\Users\\daniel', kind: 'background', sessionId: sid, name: 'Bg job', status: 'idle' }]);
  const key = cardKey([WINHOST, 'C:\\Users\\daniel', 'idle', '0', 'Bg job', '', 'bg', 'bg:3eeba696']);
  run({ ...env, WIN_AGENTS: roster, FZF_PICK: 'Remove' }, ['--remove', key]);
  assert.match(fs.readFileSync(killLog, 'utf8'), /26984/, 'taskkill invoked on the roster pid');
  assert.ok(!fs.existsSync(path.join(windir, `${sid}.json`)), 'Windows bg row file removed');
});

test('--remove matches a Windows row by cwd when the KEY arrives @tsv-backslash-doubled', { skip }, () => {
  // JQ_ROW renders the body through @tsv, which doubles every backslash, so a KEY's cwd reads
  // "C:\\Users\\daniel" while the registry stores "C:\Users\daniel". The locator-less fallback
  // compared the two raw, so it could never fire for a Windows path.
  const { env, windir } = makeEnv();
  winRow(windir, 'w7', { key: 'w7', session: 'w7', host: WINHOST, cwd: 'C:\\Users\\daniel', state: 'idle', ts: nowSec(), kind: 'host', locator: '', pane: '', title: 'legacy', pid: '7007' });
  const key = cardKey([WINHOST, 'C:\\\\Users\\\\daniel', 'idle', '0', 'legacy', '', 'host', '']);
  run({ ...env, FZF_PICK: 'Remove' }, ['--remove', key]);
  assert.ok(!fs.existsSync(path.join(windir, 'w7.json')), 'the doubled-backslash cwd still matches the row');
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
