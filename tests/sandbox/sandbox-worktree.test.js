// sandbox-worktree.sh holds the worktree/session helpers claude-sandbox used to
// carry inline. That region — including the three rm -rf paths in delete_worktree
// that these functions feed — had no coverage at all, because the launcher's
// worktree code calls `exit` and so can only be reached by awk-ing function bodies
// out of the script (see claude-sandbox-launcher.test.js). Nothing here exits, so
// these tests just source the lib, the way sandbox-lib.test.js does.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox', 'executable_sandbox-worktree.sh');

let toolsOk = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = process.platform === 'win32' ? 'sandbox-worktree is Unix-only'
  : toolsOk ? false : 'git unavailable';

const dirs = [];
process.on('exit', () => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
// realpath'd, the way check-push-signatures.test.js does it: on macOS os.tmpdir() is
// /var/folders/..., a symlink to /private/var/folders/..., and git's porcelain always reports
// the physical path. Three assertions here compare a path git printed against one built from
// this directory, so without resolving it first they diff two spellings of the same place.
function scratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbwt-'));
  dirs.push(d);
  return fs.realpathSync(d);
}

// A session directory as the launcher leaves it: the instance dir, the cwd-derived
// project slug under it, and a transcript in that. list_orphan_sessions probes at
// mindepth 2 for exactly this shape.
function transcript(sessions, instance, slug = '-workspace') {
  const dir = path.join(sessions, instance, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c0ffee.jsonl'), '{}\n');
  return dir;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore', env: GIT_ENV });

// Source the lib and run one command against it. HOME is redirected so
// fzf_preview_worktree's session-dir probe can't see the real ~/.claude.
function sh(script, { home } = {}) {
  const r = spawnSync('bash', ['-c', `set -uo pipefail; . "$1"; ${script}`, 'bash', LIB], {
    encoding: 'utf8',
    env: { ...GIT_ENV, HOME: home || scratch() },
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// A repo with `main` plus one tool worktree per entry of `worktrees`, each named
// {name, branch}. The worktree dir is <repo_name>-wt-<name>, matching what
// claude-sandbox creates.
function repoWithWorktrees(worktrees = [], repoName = 'demo') {
  const root = scratch();
  const repo = path.join(root, repoName);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'root');
  for (const { name, branch } of worktrees) {
    git(repo, 'worktree', 'add', '-q', '-b', branch, path.join(root, `${repoName}-wt-${name}`));
  }
  return { root, repo, repoName };
}

test('sanitize_repo_name collapses unsafe characters and trims the edges', { skip }, () => {
  const out = sh(`
    sanitize_repo_name /home/u/my-repo
    sanitize_repo_name "/home/u/feature+branch repo"
    sanitize_repo_name /home/u/-leading
    sanitize_repo_name /home/u/keep.dots_and-dashes
  `);
  assert.deepStrictEqual(out.trim().split('\n'), [
    'my-repo',
    'feature-branch-repo',
    'leading',
    'keep.dots_and-dashes',
  ]);
});

// Pins the launcher's original pipeline, quirk included. `tr` turns basename's
// trailing newline into a '-', so `s/-$//` only ever consumes that one: exactly
// one LEADING dash comes off and a trailing dash always survives. Worth pinning
// because these names index worktree directories that already exist on disk.
test('sanitize_repo_name strips one leading dash and keeps trailing ones', { skip }, () => {
  const out = sh(`
    sanitize_repo_name /home/u/--double--
    sanitize_repo_name /home/u/trailing-
  `).trim().split('\n');
  assert.deepStrictEqual(out, ['-double--', 'trailing-']);
});

test('repo_hash is 8 chars, deterministic, and distinguishes same-named repos', { skip }, () => {
  const out = sh(`
    repo_hash /home/u/work/api
    repo_hash /home/u/work/api
    repo_hash /home/u/personal/api
  `);
  const [a, b, c] = out.trim().split('\n');
  assert.strictEqual(a.length, 8, 'hash is 8 characters');
  assert.match(a, /^[0-9a-f]{8}$/, 'hash is lowercase hex');
  assert.strictEqual(a, b, 'same path -> same hash');
  assert.notStrictEqual(a, c, 'same basename, different path -> different hash');
});

test('list_tool_worktrees emits name/branch/path for tool worktrees only', { skip }, () => {
  const { root, repo, repoName } = repoWithWorktrees([
    { name: 'alpha', branch: 'claude/alpha' },
    { name: 'feature-x', branch: 'feature/x' },
  ]);
  // A worktree that is NOT named <repo>-wt-*: must not be listed.
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/elsewhere', path.join(root, 'somewhere-else'));

  const rows = sh(`list_tool_worktrees "$2" "$3"`.replace('$2', repo).replace('$3', repoName))
    .trim().split('\n').map((l) => l.split('\t'));

  assert.strictEqual(rows.length, 2, 'only the two <repo>-wt-* worktrees');
  const byName = Object.fromEntries(rows.map((r) => [r[0], r]));
  assert.deepStrictEqual(byName.alpha.slice(0, 2), ['alpha', 'claude/alpha']);
  // -b puts a tool worktree on an arbitrary branch; the name still comes from the dir.
  assert.deepStrictEqual(byName['feature-x'].slice(0, 2), ['feature-x', 'feature/x']);
  assert.strictEqual(byName.alpha[2], path.join(root, `${repoName}-wt-alpha`), 'third field is the path');
});

test('list_tool_worktrees skips a detached worktree (git emits no branch line)', { skip }, () => {
  const { root, repo, repoName } = repoWithWorktrees([{ name: 'alpha', branch: 'claude/alpha' }]);
  git(repo, 'worktree', 'add', '-q', '--detach', path.join(root, `${repoName}-wt-loose`));

  const names = sh(`list_tool_worktrees ${repo} ${repoName} | cut -f1`).trim().split('\n');
  assert.deepStrictEqual(names, ['alpha'], 'the detached tool worktree is not listed');
});

test('list_tool_worktrees on a repo with no tool worktrees prints nothing', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees();
  assert.strictEqual(sh(`list_tool_worktrees ${repo} ${repoName}`), '');
});

test('list_orphan_sessions lists session dirs whose worktree is gone', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees([{ name: 'alive', branch: 'claude/alive' }]);
  const sessions = scratch();
  const base = `${repoName}-abcd1234`;
  // One live, one orphaned, plus the base instance (the no-worktree main session).
  // Each carries a transcript: an instance directory with none is an aborted
  // launch, not a session, and is skipped (see the next test).
  for (const d of [base, `${base}-alive`, `${base}-ghost`]) transcript(sessions, d);

  const out = sh(`list_orphan_sessions ${repo} ${repoName} ${sessions} ${base}`).trim();
  assert.deepStrictEqual(out.split('\n').filter(Boolean), ['ghost'],
    'only the session with no matching worktree, and never the base instance');
});

test('list_orphan_sessions skips an instance dir holding no transcript', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees();
  const sessions = scratch();
  const base = `${repoName}-abcd1234`;
  // resolve_session_context creates the instance dir before the container starts,
  // so every aborted launch leaves an empty one. Offering it as a resumable
  // session sends --list and --prune chasing a conversation that never happened.
  fs.mkdirSync(path.join(sessions, `${base}-aborted`), { recursive: true });
  transcript(sessions, `${base}-real`);

  const out = sh(`list_orphan_sessions ${repo} ${repoName} ${sessions} ${base}`).trim();
  assert.deepStrictEqual(out.split('\n').filter(Boolean), ['real']);
});

test('list_orphan_sessions prints nothing when no session data exists', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees();
  const sessions = scratch();
  assert.strictEqual(sh(`list_orphan_sessions ${repo} ${repoName} ${sessions} ${repoName}-abcd1234`), '');
});

test('resolve_worktree_branch reads the real branch of a live worktree', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees([
    { name: 'alpha', branch: 'claude/alpha' },
    { name: 'feature-x', branch: 'feature/x' },
  ]);
  assert.strictEqual(sh(`resolve_worktree_branch alpha ${repo} ${repoName}`).trim(), 'claude/alpha');
  // The -b case: the branch is NOT claude/<name>, so it has to come from git.
  assert.strictEqual(sh(`resolve_worktree_branch feature-x ${repo} ${repoName}`).trim(), 'feature/x');
});

test('resolve_worktree_branch falls back to claude/<name> then <name> for an orphan', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees();
  git(repo, 'branch', 'claude/gone');
  git(repo, 'branch', 'bare-name');

  assert.strictEqual(sh(`resolve_worktree_branch gone ${repo} ${repoName}`).trim(), 'claude/gone',
    'claude/<name> is probed first');
  assert.strictEqual(sh(`resolve_worktree_branch bare-name ${repo} ${repoName}`).trim(), 'bare-name',
    'a plain <name> branch is the second probe');
  assert.strictEqual(sh(`resolve_worktree_branch nothing-here ${repo} ${repoName}`), '',
    'no worktree and no branch -> empty, so delete_worktree deletes no branch');
});

test('fzf_preview_worktree renders the detail pane for a live worktree', { skip }, () => {
  const { root, repo, repoName } = repoWithWorktrees([{ name: 'alpha', branch: 'claude/alpha' }]);
  const wt = path.join(root, `${repoName}-wt-alpha`);
  fs.writeFileSync(path.join(wt, 'untracked.txt'), 'x\n');

  const out = sh(`fzf_preview_worktree alpha ${repo} ${repoName} abcd1234`);
  assert.match(out, /^=== alpha ===/, 'header names the worktree');
  assert.match(out, /Branch: +claude\/alpha/);
  assert.match(out, new RegExp(`Path: +${wt}`));
  assert.match(out, /Changes: +0 staged, 0 unstaged, 1 untracked/);
  assert.match(out, /Unpushed: +1 commit\(s\)/);
  assert.match(out, /Session: +no data/, 'no session dir under the redirected HOME');
});

test('fzf_preview_worktree reports an orphaned session instead of a path', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees();
  git(repo, 'branch', 'claude/ghost');

  const out = sh(`fzf_preview_worktree ghost ${repo} ${repoName} abcd1234`);
  assert.match(out, /Branch: +claude\/ghost/);
  assert.match(out, /Path: +\(no worktree — orphaned session\)/);
});

test('fzf_preview_worktree reports an unknown branch rather than failing', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees();
  const out = sh(`fzf_preview_worktree nothing-here ${repo} ${repoName} abcd1234`);
  assert.match(out, /Branch: +\(unknown\)/);
});

test('fzf_preview_worktree finds session data under $HOME/.claude/sandbox/sessions', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees([{ name: 'alpha', branch: 'claude/alpha' }]);
  const home = scratch();
  const sessionDir = path.join(home, '.claude', 'sandbox', 'sessions', `${repoName}-abcd1234-alpha`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'x.jsonl'), 'data\n');

  const out = sh(`fzf_preview_worktree alpha ${repo} ${repoName} abcd1234`, { home });
  assert.doesNotMatch(out, /Session: +no data/, 'the instance-id session dir is found');
  assert.match(out, /Session: +\S+/);
});

// The launcher composes these into the ids that name every on-disk artefact and,
// in delete_worktree, the three directories it rm -rf's. Pin the composition.
test('sanitize_repo_name + repo_hash compose into the instance id the launcher uses', { skip }, () => {
  const out = sh(`
    p=/home/u/work/my.repo
    printf '%s-%s\\n' "$(sanitize_repo_name "$p")" "$(repo_hash "$p")"
  `).trim();
  assert.match(out, /^my\.repo-[0-9a-f]{8}$/);
});

test('resolve_worktree_target derives claude/<name> for -w and takes -b as given', { skip }, () => {
  const out = sh(`
    resolve_worktree_target /r/demo demo feat false ""
    resolve_worktree_target /r/demo demo feat true release/1.2
  `);
  assert.deepStrictEqual(out.trim().split('\n'), [
    'claude/feat\t/r/demo/../demo-wt-feat',
    'release/1.2\t/r/demo/../demo-wt-feat',
  ]);
});

test('resolve_worktree_target composes the path from repo name, not the branch', { skip }, () => {
  // -b release/1.2 must still land in demo-wt-feat: a branch with a slash in it
  // would otherwise create a nested directory outside the sibling layout.
  const out = sh(`resolve_worktree_target /r/demo demo feat true release/1.2 | cut -f2`);
  assert.strictEqual(out.trim(), '/r/demo/../demo-wt-feat');
});

test('find_worktree_for_branch locates the worktree holding a branch', { skip }, () => {
  const { repo } = repoWithWorktrees([{ name: 'alpha', branch: 'claude/alpha' }]);
  const out = sh(`find_worktree_for_branch "${repo}" claude/alpha`);
  assert.strictEqual(path.basename(out.trim()), 'demo-wt-alpha');
});

test('find_worktree_for_branch reports the main checkout for its own branch', { skip }, () => {
  const { repo } = repoWithWorktrees([]);
  // This is the case setup_worktree refuses with guidance rather than reusing.
  const out = sh(`find_worktree_for_branch "${repo}" main`);
  assert.strictEqual(fs.realpathSync(out.trim()), fs.realpathSync(repo));
});

test('find_worktree_for_branch fails, silently, for a branch nobody has out', { skip }, () => {
  const { repo } = repoWithWorktrees([{ name: 'alpha', branch: 'claude/alpha' }]);
  const out = sh(`find_worktree_for_branch "${repo}" claude/nope && echo UNEXPECTED || echo none`);
  assert.strictEqual(out.trim(), 'none');
});

test('worktree_exists_at resolves a /../ path before matching git porcelain', { skip }, () => {
  const { repo, repoName } = repoWithWorktrees([{ name: 'alpha', branch: 'claude/alpha' }]);
  // The launcher composes exactly this shape; it never matches porcelain literally.
  const composed = `${repo}/../${repoName}-wt-alpha`;
  const out = sh(`worktree_exists_at "${repo}" "${composed}" && echo yes || echo no`);
  assert.strictEqual(out.trim(), 'yes');
});

test('worktree_exists_at is false for a path that is not a worktree', { skip }, () => {
  const { repo, root } = repoWithWorktrees([]);
  fs.mkdirSync(path.join(root, 'demo-wt-ghost'));
  const out = sh(`
    worktree_exists_at "${repo}" "${repo}/../demo-wt-ghost" && echo yes || echo no
    worktree_exists_at "${repo}" "${repo}/../demo-wt-absent" && echo yes || echo no
  `);
  assert.deepStrictEqual(out.trim().split('\n'), ['no', 'no'],
    'an existing non-worktree dir and a missing one must both be false');
});

// --- repair_container_worktrees ---------------------------------------------

// Lives in sandbox-worktree-ops.sh rather than this lib, but it is pure enough to
// source the same way: it exits nothing and touches only git.
const OPS_LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox', 'executable_sandbox-worktree-ops.sh');

function ops(script, env = {}) {
  const r = spawnSync('bash', ['-c', `set -uo pipefail; . "$1"; ${script}`, 'bash', OPS_LIB], {
    encoding: 'utf8',
    env: { ...GIT_ENV, HOME: scratch(), ...env },
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}

test('repair_container_worktrees fixes a worktree git recorded at container paths', { skip }, () => {
  const repo = scratch();
  git(repo, 'init', '-q', '.');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '.claude/worktrees/alpha', '-b', 'alpha');

  // What a session inside the container leaves behind: both absolute paths point
  // at /workspace, which exists only in the container.
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'alpha', 'gitdir'),
    '/workspace/.claude/worktrees/alpha/.git\n');
  fs.writeFileSync(path.join(repo, '.claude', 'worktrees', 'alpha', '.git'),
    'gitdir: /workspace/.git/worktrees/alpha\n');
  const before = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8', env: GIT_ENV });
  assert.match(before, /prunable/, 'precondition: the host cannot resolve the container-spelled path');

  ops('repair_container_worktrees', { REPO_PATH: repo });

  const after = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8', env: GIT_ENV });
  assert.doesNotMatch(after, /prunable/, 'a prunable entry is one `git gc` away from being dropped');
  assert.ok(after.includes(path.join(repo, '.claude', 'worktrees', 'alpha')),
    'the worktree must list at its real host path');
});

test('repair_container_worktrees is a no-op when there is nothing to repair', { skip }, () => {
  // It runs from the EXIT trap, so it fires on paths where the container never
  // started. An unexpanded glob or a missing repo must not fail the trap.
  const repo = scratch();
  git(repo, 'init', '-q', '.');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
  ops('repair_container_worktrees; echo SURVIVED', { REPO_PATH: repo });
  ops('repair_container_worktrees; echo SURVIVED', { REPO_PATH: path.join(repo, 'nope') });
  assert.strictEqual(ops('repair_container_worktrees; echo SURVIVED').trim(), 'SURVIVED',
    'REPO_PATH unset must return cleanly, not trip set -u');
});
