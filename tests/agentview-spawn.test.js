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
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash
echo host
`, { mode: 0o755 });

  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    SANDBOX_REPOS_ROOT: reposRoot,
    CLAUDE_SANDBOX_BIN: path.join(bin, 'claude-sandbox'),
    TMUX_LOG: tmuxLog, WEZ_SPAWN_LOG: spawnLog, REPO_CAPTURE: repoListFile,
    SANDBOX_LOG: sandboxLog, CLAUDE_LOG: claudeLog,
  };
  delete env.TMUX; delete env.WEZTERM_PANE;
  return { bin, reposRoot, env, tmuxLog, spawnLog, repoListFile, sandboxLog, claudeLog,
    sandboxBin: path.join(bin, 'claude-sandbox') };
}
function run(env, extraEnv = {}) {
  try {
    return { out: execFileSync('bash', [VIEW, '--spawn'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv },
    }), code: 0, err: '' };
  } catch (e) { return { out: e.stdout || '', code: e.status, err: e.stderr || '' }; }
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

test('no tmux/wezterm backend -> runs the launcher in place', { skip }, () => {
  const { env, sandboxLog, reposRoot } = makeEnv();
  const r = run(env, { FZF_REPO: 'airflow', FZF_BRANCH: 'main' });   // neither TMUX nor WEZTERM_PANE
  assert.strictEqual(r.code, 0, `in-place spawn exits clean; stderr: ${r.err}`);
  assert.ok(fs.readFileSync(sandboxLog, 'utf8').includes(`${path.join(reposRoot, 'airflow')} -b main`),
    'the launcher itself ran (exec\'d in place, not printed as advice)');
});

test('no backend + the no-repo row -> plain claude runs in place', { skip }, () => {
  const { env, claudeLog, tmuxLog, spawnLog } = makeEnv();
  const r = run(env, { FZF_REPO: HOST_ROW });
  assert.strictEqual(r.code, 0, `in-place spawn exits clean; stderr: ${r.err}`);
  assert.match(fs.readFileSync(claudeLog, 'utf8'), /run/, 'host claude ran in place');
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'no tmux involved');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm involved');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
