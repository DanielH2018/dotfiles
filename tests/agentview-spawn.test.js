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

const VIEW = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_agentview');
const SRC = fs.readFileSync(VIEW, 'utf8');
const HOST_ROW = '[no repo · plain claude]';   // first repo-pick row -> plain host session

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// A stub-bin dir (fzf/tmux/wezterm/claude-sandbox/hostname) + a repos root with fake git
// repos. The fzf stub picks by prompt; tmux/wezterm log their spawn command.
function makeEnv({ repos = ['airflow', 'webapp'], worktrees = [] } = {}) {
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
  const sandboxLog = path.join(bin, 'sandbox.log'); fs.writeFileSync(sandboxLog, '');
  const claudeLog = path.join(bin, 'claude.log'); fs.writeFileSync(claudeLog, '');

  // fzf answers by prompt: repo> -> $FZF_REPO, branch> -> $FZF_BRANCH. The repo> list is
  // captured to $REPO_CAPTURE so a test can assert exactly which repos were offered.
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "--prompt" ] && prompt="$a"; prev="$a"; done
case "$prompt" in
  repo*)
    if [ -n "\${REPO_CAPTURE:-}" ]; then cat > "\$REPO_CAPTURE"; else cat >/dev/null; fi
    printf '%s\\n' "\${FZF_REPO:-}" ;;
  branch*) cat >/dev/null; printf '%s\\n' "\${FZF_BRANCH:-}" ;;
  host*) cat >/dev/null; printf '%s\\n' "\${FZF_HOST-WSL}" ;;
  mode*) cat >/dev/null; printf '%s\\n' "\${FZF_MODE-sandbox}" ;;
  *)       cat >/dev/null ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "$TMUX_LOG"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'wezterm'), `#!/bin/bash
case "$*" in *spawn*) echo "$*" >> "$WEZ_SPAWN_LOG" ;; esac
exit 0
`, { mode: 0o755 });
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
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
prev=""; for a in "$@"; do [ "$prev" = "--data" ] && echo "$a" >> "$CURL_LOG"; prev="$a"; done
exit 0
`, { mode: 0o755 });

  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    SANDBOX_REPOS_ROOT: reposRoot,
    CLAUDE_SANDBOX_BIN: path.join(bin, 'claude-sandbox'),
    // No Windows source in these repo-picker tests: point WEZTERM_WIN at a nonexistent path so
    // the '[Windows · plain claude]' row is suppressed regardless of the real host (a dev machine
    // with a real wezterm.exe would otherwise leak it in). Windows spawn has its own test file.
    AGENT_VIEW_WEZTERM_WIN: path.join(bin, 'no-such-wezterm.exe'),
    TMUX_LOG: tmuxLog, WEZ_SPAWN_LOG: spawnLog, REPO_CAPTURE: repoListFile,
    SANDBOX_LOG: sandboxLog, CLAUDE_LOG: claudeLog, CURL_LOG: curlLog,
    CT_LOG: ctLog, CTS_LOG: ctsLog,
  };
  delete env.TMUX; delete env.WEZTERM_PANE;
  return { bin, reposRoot, env, tmuxLog, spawnLog, repoListFile, sandboxLog, claudeLog, curlLog,
    ctLog, ctsLog,
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
  assert.match(SRC, /ctrl-n:execute\([^)]*--spawn/, 'ctrl-n runs agentview --spawn');
  assert.match(SRC, /⌃n new/, 'footer advertises the new-session action');
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
  run(env, { WEZTERM_PANE: '3', FZF_REPO: HOST_ROW });
  const log = fs.readFileSync(spawnLog, 'utf8');
  assert.match(log, /spawn --/, 'uses wezterm cli spawn');
  assert.ok(log.includes('cd ~/dev 2>/dev/null || cd; claude'), `runs host claude in ~/dev; got: ${log}`);
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

test('cancelling the repo pick is a clean no-op (no spawn)', { skip }, () => {
  const { env, tmuxLog, spawnLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_REPO: '', FZF_BRANCH: 'x' });
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'no window spawned when repo pick is empty');
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
  assert.match(SRC, /ctrl-n:execute\(.*--spawn '"\$portfile"'\)/,
    'the ctrl-n execute() forwards the live picker portfile to --spawn');
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
test('the host pick offers WSL + homelab, and routes WSL to the repo pick', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_BRANCH: '' });
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window -n airflow/, 'WSL path still spawns the repo');
});

test('cancelling the host pick is a clean no-op', { skip }, () => {
  const { env, tmuxLog, spawnLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: '', FZF_REPO: 'airflow' });
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'nothing spawned when the host pick is empty');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn either');
});

// ---- WSL native mode (ct) ----
test('WSL native mode spawns plain claude in a tmux window, no sandbox, no branch', { skip }, () => {
  const { env, tmuxLog, sandboxBin, reposRoot } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_MODE: 'native' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /new-window -n airflow/, 'opens a titled window');
  assert.ok(log.includes(`cd ${path.join(reposRoot, 'airflow')} 2>/dev/null || cd; claude`),
    `runs plain claude in the repo; got: ${log}`);
  assert.ok(!log.includes(sandboxBin) && !log.includes(' -b '), 'no sandbox, no -b');
});

test('WSL native mode in a bare shell execs ct <repo>', { skip }, () => {
  const { env, ctLog, reposRoot } = makeEnv();
  run(env, { FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_MODE: 'native' });   // no mux
  assert.ok(fs.readFileSync(ctLog, 'utf8').includes(path.join(reposRoot, 'airflow')),
    'ct ran on the repo dir');
});

test('cancelling the mode pick is a clean no-op', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_MODE: '' });
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'nothing spawned when the mode pick is empty');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
