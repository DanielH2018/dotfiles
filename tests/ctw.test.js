// Unit tests for executable_ctw — the remote companion to `cts --ssh`. It resolves a repo
// NAME under $CTS_REMOTE_ROOTS, optionally into a per-branch git worktree, then hands off
// to `ct` (native claude in a named tmux session). It also answers the --list-repos /
// --list-branches queries that `cts --complete-*` sends over ssh.
//
// Strategy: drive the ACTUAL script with a real `git` against hermetic tmp repos, and a
// `ct` stub on PATH that logs its args (so we see the final dir handed off) instead of
// launching tmux/claude. Skips cleanly when bash or git is unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CTW = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_ctw');
function have(cmd) { try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = !have('bash') ? 'bash unavailable' : !have('git') ? 'git unavailable' : false;

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-')); dirs.push(d); return fs.realpathSync(d); }

// A git repo with one empty commit on `main`, plus any extra branches requested.
function gitRepo(root, name, branches = []) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 't');
  g('commit', '-q', '--allow-empty', '-m', 'init');
  for (const b of branches) g('branch', b);
  return d;
}

// A clone under `root` whose `branch` exists only as origin/<branch> — no local ref. The
// branch carries a commit main does not, so a checkout that forked HEAD instead of tracking
// the remote is visible in the log.
function clonedRepo(root, name, branch) {
  const upstream = gitRepo(scratch(), 'upstream');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  g(upstream, 'checkout', '-q', '-b', branch);
  g(upstream, 'commit', '-q', '--allow-empty', '-m', 'only-on-remote');
  g(upstream, 'checkout', '-q', 'main');
  const d = path.join(root, name);
  g(root, 'clone', '-q', upstream, d);
  g(d, 'config', 'user.email', 't@t.t');
  g(d, 'config', 'user.name', 't');
  return d;
}

// Run ctw with a logging `ct` stub on PATH. Returns { code, out, err, ct } where `ct` is
// the logged args of the final `ct` handoff (empty string if ct was never reached).
function runCtw(args, { roots, wtRoot, env = {} } = {}) {
  const bin = scratch();
  const ctlog = path.join(bin, 'ct.log');
  fs.writeFileSync(path.join(bin, 'ct'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(ctlog)}\nexit 0\n`, { mode: 0o755 });
  const e = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  if (roots !== undefined) e.CTS_REMOTE_ROOTS = roots;
  if (wtRoot !== undefined) e.CTS_WORKTREE_ROOT = wtRoot;
  Object.assign(e, env);
  let code = 0, out = '', err = '';
  try {
    out = execFileSync('bash', [CTW, ...args], { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (ex) { code = ex.status; out = String(ex.stdout || ''); err = String(ex.stderr || ''); }
  const ct = fs.existsSync(ctlog) ? fs.readFileSync(ctlog, 'utf8').trim() : '';
  return { code, out, err, ct };
}

test('--list-repos lists git-repo subdirs of the roots, ignoring non-git dirs', { skip }, () => {
  const root = scratch();
  gitRepo(root, 'alpha');
  gitRepo(root, 'beta');
  fs.mkdirSync(path.join(root, 'not-a-repo'));       // plain dir: must be ignored
  const { out } = runCtw(['--list-repos'], { roots: root });
  const names = out.trim().split('\n').sort();
  assert.deepStrictEqual(names, ['alpha', 'beta']);
});

test('--list-repos scans multiple colon-separated roots; first root wins on name collision', { skip }, () => {
  const r1 = scratch(); const r2 = scratch();
  gitRepo(r1, 'dup'); gitRepo(r1, 'onlyone');
  gitRepo(r2, 'dup'); gitRepo(r2, 'other');
  const { out } = runCtw(['--list-repos'], { roots: `${r1}:${r2}` });
  const names = out.trim().split('\n').sort();
  assert.deepStrictEqual(names, ['dup', 'onlyone', 'other'], 'dup appears once');
});

test('--list-branches lists local branches of a resolved repo', { skip }, () => {
  const root = scratch();
  gitRepo(root, 'proj', ['feature', 'bugfix']);
  const { out } = runCtw(['--list-branches', 'proj'], { roots: root });
  const names = out.trim().split('\n').sort();
  assert.deepStrictEqual(names, ['bugfix', 'feature', 'main']);
});

test('--list-branches on an unknown repo exits non-zero', { skip }, () => {
  const root = scratch();
  const { code, err } = runCtw(['--list-branches', 'ghost'], { roots: root });
  assert.notStrictEqual(code, 0);
  assert.match(err, /not found/i);
});

test('ctw REPO (no branch) hands the repo path to ct, no worktree', { skip }, () => {
  const root = scratch();
  const repo = gitRepo(root, 'proj');
  const wt = scratch();
  const { ct } = runCtw(['proj'], { roots: root, wtRoot: wt });
  assert.strictEqual(ct, repo, 'ct launched on the repo itself');
  assert.deepStrictEqual(fs.readdirSync(wt), [], 'no worktree created');
});

test('ctw REPO BRANCH (existing branch) creates a worktree and launches ct there', { skip }, () => {
  const root = scratch();
  gitRepo(root, 'proj', ['feature']);
  const wt = scratch();
  const { ct, code, err } = runCtw(['proj', 'feature'], { roots: root, wtRoot: wt });
  assert.strictEqual(code, 0, err);
  const expected = path.join(wt, 'proj', 'feature');
  assert.strictEqual(ct, expected, 'ct launched in the per-branch worktree');
  assert.ok(fs.existsSync(path.join(expected, '.git')), 'worktree checked out');
});

test('ctw REPO BRANCH (unknown branch) creates the branch on demand', { skip }, () => {
  const root = scratch();
  const repo = gitRepo(root, 'proj');
  const wt = scratch();
  const { ct, code, err } = runCtw(['proj', 'shiny-new'], { roots: root, wtRoot: wt });
  assert.strictEqual(code, 0, err);
  assert.strictEqual(ct, path.join(wt, 'proj', 'shiny-new'));
  const branches = execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { encoding: 'utf8' });
  assert.match(branches, /(^|\n)shiny-new(\n|$)/, 'branch created in the source repo');
});

test('ctw REPO BRANCH tracks a branch that exists only on origin instead of forking HEAD', { skip }, () => {
  const root = scratch();
  const repo = clonedRepo(root, 'proj', 'remote-only');
  const wt = scratch();
  const { ct, code, err } = runCtw(['proj', 'remote-only'], { roots: root, wtRoot: wt });
  assert.strictEqual(code, 0, err);
  const expected = path.join(wt, 'proj', 'remote-only');
  assert.strictEqual(ct, expected);
  const log = execFileSync('git', ['-C', expected, 'log', '--format=%s'], { encoding: 'utf8' });
  assert.match(log, /only-on-remote/, 'worktree checked out the remote branch, not a fork of main');
  const upstream = execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/remote-only'], { encoding: 'utf8' });
  assert.strictEqual(upstream.trim(), 'origin/remote-only', 'local branch tracks the remote');
});

test('ctw slugifies a slashed branch for the worktree dir but keeps the real branch name', { skip }, () => {
  const root = scratch();
  const repo = gitRepo(root, 'proj');
  const wt = scratch();
  const { ct, code } = runCtw(['proj', 'feat/x'], { roots: root, wtRoot: wt });
  assert.strictEqual(code, 0);
  assert.strictEqual(ct, path.join(wt, 'proj', 'feat-x'), 'slash slugified in the path');
  const branches = execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { encoding: 'utf8' });
  assert.match(branches, /(^|\n)feat\/x(\n|$)/, 'real slashed branch name preserved');
});

test('ctw REPO BRANCH launches the main checkout when it already holds that branch', { skip }, () => {
  const root = scratch();
  const repo = gitRepo(root, 'proj');                // 'main' is checked out in the repo itself
  const wt = scratch();
  const { ct, code, err } = runCtw(['proj', 'main'], { roots: root, wtRoot: wt });
  assert.strictEqual(code, 0, err);
  assert.strictEqual(ct, repo, 'ct launched in the checkout that holds the branch');
  assert.deepStrictEqual(fs.readdirSync(wt), [], 'no worktree created');
});

test('ctw REPO BRANCH launches an existing worktree that already holds that branch', { skip }, () => {
  const root = scratch();
  const repo = gitRepo(root, 'proj', ['feature']);
  const elsewhere = path.join(scratch(), 'feature-wt');   // a worktree the repo owns itself
  execFileSync('git', ['-C', repo, 'worktree', 'add', elsewhere, 'feature'], { stdio: 'ignore' });
  const wt = scratch();
  const { ct, code, err } = runCtw(['proj', 'feature'], { roots: root, wtRoot: wt });
  assert.strictEqual(code, 0, err);
  assert.strictEqual(ct, elsewhere, 'ct launched in the existing worktree');
  assert.deepStrictEqual(fs.readdirSync(wt), [], 'no second worktree created');
});

test('ctw REPO BRANCH twice reuses the worktree without error', { skip }, () => {
  const root = scratch();
  gitRepo(root, 'proj', ['feature']);
  const wt = scratch();
  const first = runCtw(['proj', 'feature'], { roots: root, wtRoot: wt });
  const second = runCtw(['proj', 'feature'], { roots: root, wtRoot: wt });
  assert.strictEqual(first.code, 0, first.err);
  assert.strictEqual(second.code, 0, second.err);
  assert.strictEqual(second.ct, path.join(wt, 'proj', 'feature'), 'second run reuses and launches ct');
});

test('ctw with an absolute path and no branch passes it straight to ct (back-compat)', { skip }, () => {
  const root = scratch();
  const { ct } = runCtw(['/srv/whatever'], { roots: root });
  assert.strictEqual(ct, '/srv/whatever');
});

test('ctw with an unknown repo name exits non-zero and does not launch ct', { skip }, () => {
  const root = scratch();
  const { code, err, ct } = runCtw(['nope'], { roots: root });
  assert.notStrictEqual(code, 0);
  assert.match(err, /not found/i);
  assert.strictEqual(ct, '', 'ct never reached');
});

test('bare ctw hands off to ct with no dir (remote $HOME default)', { skip }, () => {
  const root = scratch();
  const { ct, code } = runCtw([], { roots: root });
  assert.strictEqual(code, 0);
  assert.strictEqual(ct, '', 'ct invoked with no args');
});

test('ctw -h prints usage and exits 0', { skip }, () => {
  const out = execFileSync('bash', [CTW, '-h'], { encoding: 'utf8' });
  assert.match(out, /^usage: ctw /);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
