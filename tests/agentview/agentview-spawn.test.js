// Tests for `agentview --spawn` (bonus §5): start a new claude-sandbox session from the
// picker. Drives the ACTUAL script with stub fzf/tmux/wezterm/claude-sandbox on PATH and
// a temp repos root, so it's hermetic — no real mux, no docker. The fzf stub answers by
// prompt (repo> vs branch>) so repo + branch selection are deterministic. Real jq used.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentviewWinSeams } = require('../lib/agentview-env');

const VIEW = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_agentview');
const SRC = fs.readFileSync(VIEW, 'utf8');
// The footer is assembled from render.sh's AV_HINTS now, not spelled out in the picker flags.
const HINTS = fs.readFileSync(path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview', 'render.sh'), 'utf8');
const HOST_ROW = '[no repo · plain claude]';   // first repo-pick row -> plain host session

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// A stub-bin dir (fzf/tmux/wezterm/claude-sandbox/hostname) + a repos root with fake git
// repos. The fzf stub picks by prompt; tmux/wezterm log their spawn command.
function makeEnv({ repos = ['airflow', 'webapp'], worktrees = [], winWezterm = false } = {}) {
  const bin = scratch('avs-bin-');
  const reposRoot = scratch('avs-repos-');
  for (const r of repos) fs.mkdirSync(path.join(reposRoot, r, '.git'), { recursive: true });
  // Linked worktrees look like repos but carry a `.git` FILE (a gitdir pointer), not a dir.
  for (const w of worktrees) {
    const d = path.join(reposRoot, w); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.git'), `gitdir: ${reposRoot}/${w.split('-wt-')[0]}/.git/worktrees/${w}\n`);
  }
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const spawnLog = path.join(bin, 'spawn.log'); fs.writeFileSync(spawnLog, '');
  const repoListFile = path.join(bin, 'repo-list.txt'); fs.writeFileSync(repoListFile, '');
  const hostListFile = path.join(bin, 'host-list.txt'); fs.writeFileSync(hostListFile, '');
  const sandboxLog = path.join(bin, 'sandbox.log'); fs.writeFileSync(sandboxLog, '');
  const claudeLog = path.join(bin, 'claude.log'); fs.writeFileSync(claudeLog, '');

  // fzf answers by prompt: repo> -> $FZF_REPO, branch> -> $FZF_BRANCH. The repo> and host>
  // lists are captured to $REPO_CAPTURE / $HOST_CAPTURE so a test can assert exactly what
  // each box offered.
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "--prompt" ] && prompt="$a"; prev="$a"; done
rows_tmp=\$(mktemp); trap 'rm -f "\$rows_tmp"' EXIT
# One line per chooser: "<prompt>\\t<argv>", so a test can assert how each box was styled.
[ -n "\${FZF_ARGS_LOG:-}" ] && printf '%s\\t%s\\n' "\$prompt" "\$*" >> "\$FZF_ARGS_LOG"
case "$prompt" in
  repo*)
    if [ -n "\${REPO_CAPTURE:-}" ]; then cat > "\$REPO_CAPTURE"; else cat >/dev/null; fi
    printf '%s\\n' "\${FZF_REPO:-}" ;;
  branch*) cat >/dev/null; printf '%s\\n' "\${FZF_BRANCH:-}" ;;
  host*)
    if [ -n "\${HOST_CAPTURE:-}" ]; then cat > "\$HOST_CAPTURE"; else cat > "\$rows_tmp"; fi
    # Unset FZF_HOST = take the FIRST row, the way an untouched fzf would. That row is this
    # machine, and its label tracks WSL_DISTRO_NAME, so the default follows the host instead
    # of naming one — pinning it to "WSL" made every local-spawn test pass only under WSL.
    if [ -n "\${FZF_HOST+x}" ]; then printf '%s\\n' "\$FZF_HOST"
    else head -1 "\${HOST_CAPTURE:-\$rows_tmp}"; fi ;;
  mode*) cat >/dev/null; printf '%s\\n' "\${FZF_MODE-sandbox}" ;;
  *)       cat >/dev/null ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "$TMUX_LOG"
# Real tmux RUNS the command string a display-popup is handed, and av_pick depends on that to
# get the pick back through a temp file. A stub that only logged would strand every chooser on
# an empty selection, so model the execution too.
if [ "$1" = "display-popup" ]; then
  for a in "$@"; do cmd="$a"; done
  bash -c "$cmd"
  exit $?
fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'wezterm'), `#!/bin/bash
case "$*" in *spawn*) echo "$*" >> "$WEZ_SPAWN_LOG" ;; esac
exit 0
`, { mode: 0o755 });
  // The WINDOWS wezterm.exe, reached over /mnt/c. Absent by default so the repo-picker tests
  // keep their '[Windows · plain claude]' row suppressed regardless of the real host (a dev
  // machine with a real wezterm.exe would otherwise leak it in); the WSL spawn tests opt in.
  const winWezLog = path.join(bin, 'win-wez.log'); fs.writeFileSync(winWezLog, '');
  const seams = agentviewWinSeams({
    bin,
    scratch,
    weztermBody: winWezterm ? `#!/bin/bash
echo "$*" >> "$WIN_WEZ_LOG"
exit 0
` : undefined,
  });
  fs.writeFileSync(path.join(bin, 'claude-sandbox'), `#!/bin/bash
echo "$*" >> "$SANDBOX_LOG"
case "$*" in *--complete-branches*) printf 'main\\nfeature-x\\n' ;; esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
echo "run $*" >> "$CLAUDE_LOG"
exit 0
`, { mode: 0o755 });
  const ctLog = path.join(bin, 'ct.log'); fs.writeFileSync(ctLog, '');
  const ctsLog = path.join(bin, 'cts.log'); fs.writeFileSync(ctsLog, '');
  fs.writeFileSync(path.join(bin, 'ct'), `#!/bin/bash
echo "$*" >> "$CT_LOG"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'cts'), `#!/bin/bash
echo "$*" >> "$CTS_LOG"
case "$*" in
  *--complete-repos*)    printf 'infra\\nnotes\\n' ;;
  *--complete-branches*) printf 'main\\ndev\\n' ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash
echo host
`, { mode: 0o755 });
  // curl stub: log the POST body so a test can assert the picker is told to `abort` after a
  // real spawn (the ctrl-n dismiss). The real close POST is detached (nohup+sleep), so tests
  // poll CURL_LOG rather than read it once.
  const curlLog = path.join(bin, 'curl.log'); fs.writeFileSync(curlLog, '');
  const fzfArgsLog = path.join(bin, 'fzf-args.log'); fs.writeFileSync(fzfArgsLog, '');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
prev=""; for a in "$@"; do [ "$prev" = "--data" ] && echo "$a" >> "$CURL_LOG"; prev="$a"; done
exit 0
`, { mode: 0o755 });

  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    SANDBOX_REPOS_ROOT: reposRoot,
    CLAUDE_SANDBOX_BIN: path.join(bin, 'claude-sandbox'),
    ...seams.env,
    TMUX_LOG: tmuxLog, WEZ_SPAWN_LOG: spawnLog, REPO_CAPTURE: repoListFile,
    HOST_CAPTURE: hostListFile,
    SANDBOX_LOG: sandboxLog, CLAUDE_LOG: claudeLog, CURL_LOG: curlLog,
    CT_LOG: ctLog, CTS_LOG: ctsLog, FZF_ARGS_LOG: fzfArgsLog, WIN_WEZ_LOG: winWezLog,
  };
  delete env.TMUX; delete env.WEZTERM_PANE; delete env.WSL_DISTRO_NAME;
  return { bin, reposRoot, env, tmuxLog, spawnLog, repoListFile, hostListFile, sandboxLog, claudeLog, curlLog,
    ctLog, ctsLog, fzfArgsLog, winWezLog, winWezBin: seams.wezterm,
    sandboxBin: path.join(bin, 'claude-sandbox') };
}
// `--spawn [portfile]`: a portfile arg opts into the ctrl-n dismiss (POST abort on success).
function run(env, extraEnv = {}, args = []) {
  try {
    return { out: execFileSync('bash', [VIEW, '--spawn', ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv },
    }), code: 0, err: '' };
  } catch (e) { return { out: e.stdout || '', code: e.status, err: e.stderr || '' }; }
}
// The close POST is detached (nohup; sleep 0.1) so it outlives the --spawn process — poll.
function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; execFileSync('sleep', ['0.05']); }
  return pred();
}

// ---- structural: the picker exposes the spawn action ----
test('interactive picker binds ctrl-n to --spawn and hints it in the footer', () => {
  // The literal action is $AV_EXEC now — execute-silent under tmux (so the spawn pickers can
  // float as a popup over the list), plain execute otherwise. See av_pick in the script.
  assert.match(SRC, /ctrl-n:'"\$AV_EXEC"'\([^)]*--spawn/, 'ctrl-n runs agentview --spawn');
  assert.match(HINTS, /⌃n new/, 'footer advertises the new-session action');
});

// ---- host pick: the first row names THIS machine, the ssh hosts always follow ----
test('host chooser offers Linux + the ssh hosts on a native box', { skip }, () => {
  const { env, hostListFile } = makeEnv();          // no WSL_DISTRO_NAME, no wezterm.exe
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'airflow', FZF_BRANCH: '' });
  const rows = fs.readFileSync(hostListFile, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(rows[0], 'Linux', `this machine leads the list; got ${JSON.stringify(rows)}`);
  // HOST_SSH is an associative array, so Box/Homelab come back in an unspecified order.
  assert.ok(rows.includes('Box') && rows.includes('Homelab'), `ssh hosts offered; got ${rows}`);
  assert.ok(!rows.includes('PC (Windows)'), `no Windows side off WSL; got ${rows}`);
});

test('host chooser offers WSL + PC under WSL', { skip }, () => {
  const { env, hostListFile } = makeEnv({ winWezterm: true });
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', WSL_DISTRO_NAME: 'Ubuntu',
    FZF_REPO: 'airflow', FZF_BRANCH: '' });
  const rows = fs.readFileSync(hostListFile, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(rows[0], 'WSL', `this machine leads the list; got ${JSON.stringify(rows)}`);
  assert.ok(rows.includes('PC (Windows)'), `the Windows side is a target too; got ${rows}`);
  assert.ok(rows.includes('Box') && rows.includes('Homelab'), `ssh hosts offered; got ${rows}`);
});

test('the host box is sized to its rows, not to a slice of the terminal', { skip }, () => {
  // 3 rows (Linux/Box/Homelab) + border, prompt and header = 7 lines. A percentage cannot
  // know that: at 30% the third host sat below the fold on an ordinary window.
  const { env, fzfArgsLog, hostListFile } = makeEnv();
  run(env, { FZF_REPO: 'airflow', FZF_BRANCH: '' });                     // no tmux -> plain fzf
  const rows = fs.readFileSync(hostListFile, 'utf8').split('\n').filter(Boolean);
  const hostArgs = fs.readFileSync(fzfArgsLog, 'utf8').split('\n')
    .filter((l) => l.startsWith('host'))[0];
  assert.ok(hostArgs, 'the host chooser ran');
  assert.match(hostArgs, new RegExp(`--height=~${rows.length + 4}(\\s|$)`),
    `box fits ${rows.length} rows; got ${hostArgs}`);
});

test('the tmux popup for the host pick gets the same fitted height', { skip }, () => {
  const { env, tmuxLog, hostListFile } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'airflow', FZF_BRANCH: '' });
  const rows = fs.readFileSync(hostListFile, 'utf8').split('\n').filter(Boolean);
  const popup = fs.readFileSync(tmuxLog, 'utf8').split('\n')
    // tmux re-parses the popup body, so av_pick %q-escapes every word: the prompt reads
    // `--prompt host\>\ ` in the log, not `host> `.
    .filter((l) => l.startsWith('display-popup') && l.includes('--prompt host'))[0];
  assert.ok(popup, `a popup opened for the host pick; got ${fs.readFileSync(tmuxLog, 'utf8')}`);
  // -B means tmux draws no border of its own, so the popup height IS the fzf box height.
  assert.match(popup, new RegExp(`-h ${rows.length + 4}(\\s|$)`), `popup fits the rows; got ${popup}`);
});

// ---- theming: every box the spawn flow opens is Catppuccin Mocha, like the terminal ----
test('every spawn chooser inherits the Mocha palette from av_pick', { skip }, () => {
  const { env, fzfArgsLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'airflow', FZF_BRANCH: 'feature-x' });
  const lines = fs.readFileSync(fzfArgsLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length >= 2, `the flow opened choosers; got ${JSON.stringify(lines)}`);
  // av_pick prepends --color, so no call site can forget it — the bug this guards is a NEW
  // chooser landing in raw terminal defaults beside a fully themed picker.
  for (const l of lines) {
    const [prompt, argv] = l.split('\t');
    assert.match(argv, /--color=[^ ]*fg:#cdd6f4/, `${prompt} chooser carries Mocha text`);
    assert.match(argv, /--color=[^ ]*bg\+:#313244/, `${prompt} chooser carries Mocha surface0`);
    // bg+ only paints something when the whole row is highlighted; without this the palette
    // is set but invisible, which is how these boxes read as unthemed.
    assert.match(argv, /--highlight-line/, `${prompt} chooser marks the selected row`);
  }
  const prompts = lines.map((l) => l.split('\t')[0]);
  assert.ok(prompts.some((p) => p.startsWith('repo')), `repo chooser ran; got ${prompts}`);
  assert.ok(prompts.some((p) => p.startsWith('branch')), `branch chooser ran; got ${prompts}`);
});

// ---- behavioral ----
test('under tmux, spawns claude-sandbox <repo> -b <branch> in a new window', { skip }, () => {
  const { env, tmuxLog, sandboxBin, reposRoot } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'airflow', FZF_BRANCH: 'feature-x' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /new-window -n airflow/, 'opens a titled tmux window');
  assert.ok(log.includes(`${sandboxBin} ${path.join(reposRoot, 'airflow')} -b feature-x`),
    `window runs the launcher with -b; got: ${log}`);
});

test('empty branch -> main repo, no -b flag', { skip }, () => {
  const { env, tmuxLog, sandboxBin, reposRoot } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'webapp', FZF_BRANCH: '' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.ok(log.includes(`${sandboxBin} ${path.join(reposRoot, 'webapp')}`), 'launches the repo');
  assert.ok(!log.includes(' -b '), 'no -b flag when the branch is empty');
});

test('the repo picker offers real repos but hides linked worktrees', { skip }, () => {
  const { env, repoListFile } = makeEnv({ repos: ['airflow'], worktrees: ['airflow-wt-feature'] });
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'airflow', FZF_BRANCH: '' });
  const offered = fs.readFileSync(repoListFile, 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(offered, [HOST_ROW, 'airflow'],
    `host row + the real checkout, not the worktree; got ${JSON.stringify(offered)}`);
});

// ---- no-repo host session ----
test('picking the no-repo row spawns plain host claude in a tmux window, no sandbox', { skip }, () => {
  const { env, tmuxLog, sandboxBin } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: HOST_ROW, FZF_BRANCH: 'ignored' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /new-window -n claude/, 'opens a window titled claude');
  assert.ok(log.includes('cd ~/dev 2>/dev/null || cd; claude'), `runs host claude in ~/dev; got: ${log}`);
  assert.ok(!log.includes(sandboxBin), 'claude-sandbox is not involved');
});

test('picking the no-repo row under wezterm spawns host claude in a new tab', { skip }, () => {
  const { env, spawnLog } = makeEnv();
  // No WSL_DISTRO_NAME: a NATIVE wezterm, where the local CLI reaches the GUI owning this pane.
  run(env, { WEZTERM_PANE: '3', FZF_REPO: HOST_ROW });
  const log = fs.readFileSync(spawnLog, 'utf8');
  assert.match(log, /spawn --/, 'uses wezterm cli spawn');
  assert.ok(log.includes('cd ~/dev 2>/dev/null || cd; claude'), `runs host claude in ~/dev; got: ${log}`);
});

test('under WSL with no wezterm.exe the spawn is skipped — it would land in a phantom mux', { skip }, () => {
  // From WSL the Linux cli reaches no GUI, so `wezterm cli spawn` silently starts a headless
  // mux server and spawns the tab THERE, where nothing displays it. With no wezterm.exe to
  // reach the real GUI either, falling through to the named-tmux launcher is the jumpable
  // outcome. Same failure the remote-attach path already guards against.
  const { env, spawnLog, ctLog } = makeEnv();   // winWezterm off -> WEZTERM_WIN does not exist
  run(env, { WEZTERM_PANE: '3', WSL_DISTRO_NAME: 'Ubuntu', FZF_REPO: HOST_ROW });
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn from WSL');
  assert.ok(fs.readFileSync(ctLog, 'utf8').includes(`${process.env.HOME}/dev`),
    'falls through to the named ct launcher instead of dropping the spawn');
});

test('the no-repo row is offered even when the repos root is empty', { skip }, () => {
  const { env, repoListFile, tmuxLog } = makeEnv({ repos: [] });
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: HOST_ROW });
  const offered = fs.readFileSync(repoListFile, 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(offered, [HOST_ROW], 'the host row alone is offered');
  assert.ok(fs.readFileSync(tmuxLog, 'utf8').includes('cd ~/dev 2>/dev/null || cd; claude'), 'and it still spawns');
});

test('under wezterm (no tmux), spawns a new tab running the launcher', { skip }, () => {
  const { env, spawnLog } = makeEnv();
  run(env, { WEZTERM_PANE: '3', FZF_REPO: 'airflow', FZF_BRANCH: 'main' });
  const log = fs.readFileSync(spawnLog, 'utf8');
  assert.match(log, /spawn --/, 'uses wezterm cli spawn');
  assert.match(log, /airflow -b main/, 'passes the repo + branch to the launcher');
});

// ---- WSL: the GUI is the WINDOWS wezterm, so the LINUX cli must not be used ----
// A WSL pane's WEZTERM_PANE is forwarded in over WSLENV (wezterm.lua), so it looks local
// while the GUI lives on Windows. `wezterm cli spawn` in WSL cannot reach that GUI: it
// daemonizes its own headless wezterm-mux-server and spawns there, where nobody is
// attached — CTRL+N read as a no-op. These pin the routing so that can't come back.
test('in WSL, a spawn goes out through wezterm.exe pinned to the WSL domain', { skip }, () => {
  const { env, winWezLog, spawnLog } = makeEnv({ winWezterm: true });
  run(env, { WEZTERM_PANE: '3', WSL_DISTRO_NAME: 'Ubuntu', FZF_HOST: 'Homelab', FZF_REPO: 'infra', FZF_BRANCH: 'dev' });
  const win = fs.readFileSync(winWezLog, 'utf8');
  assert.match(win, /cli --no-auto-start spawn/, `spawns via the Windows wezterm.exe; got: ${win}`);
  assert.match(win, /--domain-name WSL:Ubuntu/, `pins the WSL domain so the tab lands Linux-side; got: ${win}`);
  assert.match(win, /--ssh=daniel-server infra -b dev/, `carries the remote launcher; got: ${win}`);
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '',
    'the Linux wezterm cli is never used — it would spawn into a phantom mux server');
});

test('in WSL with no reachable wezterm.exe, a spawn execs the named launcher instead', { skip }, () => {
  const { env, ctsLog, spawnLog } = makeEnv();   // winWezterm off -> WEZTERM_WIN does not exist
  run(env, { WEZTERM_PANE: '3', WSL_DISTRO_NAME: 'Ubuntu', FZF_HOST: 'Homelab', FZF_REPO: 'infra', FZF_BRANCH: 'dev' });
  assert.match(fs.readFileSync(ctsLog, 'utf8'), /--ssh=daniel-server infra -b dev/,
    'falls through to the in-place named launcher rather than spawning into nowhere');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'still never the Linux wezterm cli');
});

test('cancelling the repo pick is a clean no-op (no spawn)', { skip }, () => {
  const { env, tmuxLog, spawnLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: '', FZF_BRANCH: 'x' });
  // The tmux log is no longer empty on a cancel — the chooser itself is a display-popup now.
  // What must not appear is a new-window: that is the actual spawn.
  assert.ok(!fs.readFileSync(tmuxLog, 'utf8').includes('new-window'), 'no window spawned when repo pick is empty');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn either');
});

test('no tmux/wezterm backend -> execs the named cts launcher in place', { skip }, () => {
  const { env, ctsLog, reposRoot } = makeEnv();
  const r = run(env, { FZF_REPO: 'airflow', FZF_BRANCH: 'main' });   // neither TMUX nor WEZTERM_PANE
  assert.strictEqual(r.code, 0, `in-place spawn exits clean; stderr: ${r.err}`);
  assert.ok(fs.readFileSync(ctsLog, 'utf8').includes(`${path.join(reposRoot, 'airflow')} -b main`),
    'the named cts launcher ran in place (jumpable named tmux session)');
});

test('no backend + the no-repo row -> execs ct ~/dev in place', { skip }, () => {
  const { env, ctLog, tmuxLog, spawnLog } = makeEnv();
  const r = run(env, { FZF_REPO: HOST_ROW });
  assert.strictEqual(r.code, 0, `in-place spawn exits clean; stderr: ${r.err}`);
  assert.ok(fs.readFileSync(ctLog, 'utf8').includes(`${process.env.HOME}/dev`), 'ct ran on ~/dev');
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'no direct tmux from agentview');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm involved');
});

// ---- ctrl-n dismiss: a real spawn tells the picker to abort (close its popup/tab) ----
test('ctrl-n bind passes the fzf portfile to --spawn', () => {
  assert.match(SRC, /ctrl-n:'"\$AV_EXEC"'\(.*--spawn '"\$portfile"'\)/,
    'the ctrl-n handoff forwards the live picker portfile to --spawn');
});

test('a successful spawn POSTs abort to the picker portfile', { skip }, () => {
  const { env, curlLog } = makeEnv();
  const pf = path.join(scratch('avs-pf-'), 'port'); fs.writeFileSync(pf, '4321');
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'airflow', FZF_BRANCH: 'main' }, [pf]);
  assert.ok(waitFor(() => /abort/.test(fs.readFileSync(curlLog, 'utf8'))),
    'the picker is told to abort after the session spawns');
});

test('cancelling the repo pick does NOT dismiss the picker', { skip }, () => {
  const { env, curlLog } = makeEnv();
  const pf = path.join(scratch('avs-pf-'), 'port'); fs.writeFileSync(pf, '4321');
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: '', FZF_BRANCH: 'x' }, [pf]);
  // give any (erroneous) detached POST time to fire, then assert none did
  execFileSync('sleep', ['0.3']);
  assert.strictEqual(fs.readFileSync(curlLog, 'utf8'), '', 'no abort POST when nothing spawned');
});

test('an empty portfile is a silent no-op (standalone --spawn unaffected)', { skip }, () => {
  const { env, curlLog, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: 'airflow', FZF_BRANCH: 'main' });
  execFileSync('sleep', ['0.3']);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window/, 'the session still spawns');
  assert.strictEqual(fs.readFileSync(curlLog, 'utf8'), '', 'no POST without a portfile');
});

// ---- host pick (step 0) ----
test('the host pick routes this machine to the repo pick', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'Linux', FZF_REPO: 'airflow', FZF_BRANCH: '' });
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window -n airflow/, 'the local path still spawns the repo');
});

test('cancelling the host pick is a clean no-op', { skip }, () => {
  const { env, tmuxLog, spawnLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: '', FZF_REPO: 'airflow' });
  assert.ok(!fs.readFileSync(tmuxLog, 'utf8').includes('new-window'), 'nothing spawned when the host pick is empty');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn either');
});

// ---- local native mode (ct) ----
test('native mode spawns plain claude in a tmux window, no sandbox, no branch', { skip }, () => {
  const { env, tmuxLog, sandboxBin, reposRoot } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'Linux', FZF_REPO: 'airflow', FZF_MODE: 'native' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /new-window -n airflow/, 'opens a titled window');
  assert.ok(log.includes(`cd ${path.join(reposRoot, 'airflow')} 2>/dev/null || cd; claude`),
    `runs plain claude in the repo; got: ${log}`);
  assert.ok(!log.includes(sandboxBin) && !log.includes(' -b '), 'no sandbox, no -b');
});

test('native mode in a bare shell execs ct <repo>', { skip }, () => {
  const { env, ctLog, reposRoot } = makeEnv();
  run(env, { FZF_HOST: 'Linux', FZF_REPO: 'airflow', FZF_MODE: 'native' });   // no mux
  assert.ok(fs.readFileSync(ctLog, 'utf8').includes(path.join(reposRoot, 'airflow')),
    'ct ran on the repo dir');
});

test('cancelling the mode pick is a clean no-op', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'Linux', FZF_REPO: 'airflow', FZF_MODE: '' });
  assert.ok(!fs.readFileSync(tmuxLog, 'utf8').includes('new-window'), 'nothing spawned when the mode pick is empty');
});

// ---- homelab (remote) spawn ----
test('homelab repo+branch spawns cts --ssh=<alias> <repo> -b <branch> in a tmux window', { skip }, () => {
  const { env, tmuxLog, ctsLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'Homelab', FZF_REPO: 'infra', FZF_BRANCH: 'dev' });
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window -n infra .*cts --ssh=daniel-server infra -b dev/,
    `wraps the remote launcher in a window; got: ${fs.readFileSync(tmuxLog, 'utf8')}`);
  const cts = fs.readFileSync(ctsLog, 'utf8');
  assert.match(cts, /--complete-repos daniel-server/, 'repo list came from cts over ssh');
  assert.match(cts, /--complete-branches daniel-server infra/, 'branch list came from cts over ssh');
});

test('homelab no-repo spawns plain remote claude (cts --ssh=<alias>)', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'Homelab', FZF_REPO: HOST_ROW });
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window -n Homelab .*cts --ssh=daniel-server/,
    'no-repo remote session runs bare cts --ssh');
});

test('homelab spawn in a bare shell execs cts --ssh=<alias> <repo>', { skip }, () => {
  const { env, ctsLog } = makeEnv();
  run(env, { FZF_HOST: 'Homelab', FZF_REPO: 'infra', FZF_BRANCH: '' });   // no mux
  assert.match(fs.readFileSync(ctsLog, 'utf8'), /--ssh=daniel-server infra/, 'remote launcher exec\'d in place');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
