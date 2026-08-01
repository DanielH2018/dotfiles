// Coverage for the remaining launcher helpers that had none. Each is driven
// against real git repos and real temp dirs where it talks to git or the
// filesystem, so these exercise the actual behaviour rather than a stub of it:
//
//   detect_uv_need      - decides whether uv is installed into the image
//   resolve_main_ref    - picks the ref sibling repos are snapshotted at
//   build_repo_snapshot - archives that ref into the SHA cache (rm -rf + rename)
//   check_gc_nudge      - the passive startup nudge, and its 7-day throttle
//   cleanup_worktree    - decides whether a session's worktree survives exit
//
// Same extraction technique as claude-sandbox-launcher.test.js: awk the real
// function body out of the script and drive it in bash. Skips cleanly without
// bash/awk/git.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'executable_claude-sandbox');

let toolsOk = true;
try {
  execFileSync('bash', ['-c', 'command -v awk'], { stdio: 'ignore' });
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch { toolsOk = false; }
const skip = process.platform === 'win32' ? 'launcher is Unix-only'
  : toolsOk ? false : 'bash/awk/git unavailable';

function extractFunction(name) {
  const src = execFileSync('awk', [
    `/^${name}\\(\\) \\{/ { started=1 }\n` +
    'started {\n' +
    '  print\n' +
    '  depth += gsub(/{/,"{") - gsub(/}/,"}")\n' +
    '  if (started && depth==0) exit\n' +
    '}',
    SANDBOX,
  ], { encoding: 'utf8' });
  assert.ok(new RegExp(`^${name}\\(\\) \\{`).test(src), `extracted the ${name} definition`);
  assert.strictEqual(src.trimEnd().split('\n').pop(), '}', `extracted ${name} body ends at its matching closing brace`);
  return src;
}

const SRC = skip ? {} : Object.fromEntries(
  ['detect_uv_need', 'resolve_main_ref', 'build_repo_snapshot', 'check_gc_nudge', 'cleanup_worktree']
    .map((n) => [n, extractFunction(n)]),
);

const dirs = [];
process.on('exit', () => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function scratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbhelp-'));
  dirs.push(d);
  return d;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore', env: GIT_ENV });

function run(script) {
  const r = spawnSync('bash', ['-c', `set -uo pipefail\n${script}`], {
    encoding: 'utf8', env: { ...GIT_ENV, HOME: scratch() },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// A repo with one commit on `main` containing `files`.
function repoWith(files, { branch = 'main' } = {}) {
  const repo = path.join(scratch(), 'demo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', branch);
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'root');
  return repo;
}

// --- detect_uv_need ----------------------------------------------------------

function uvNeeded(files) {
  const repo = scratch();
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), body);
  return run(`REPO_PATH=${JSON.stringify(repo)}\n${SRC.detect_uv_need}\ndetect_uv_need`).code === 0;
}

test('detect_uv_need spots a uv lockfile', { skip }, () => {
  assert.strictEqual(uvNeeded({ 'uv.lock': '' }), true);
});

test('detect_uv_need reads uv usage out of CLAUDE.md and the Makefile', { skip }, () => {
  assert.strictEqual(uvNeeded({ 'CLAUDE.md': 'Run tests with `uv run pytest`.' }), true);
  assert.strictEqual(uvNeeded({ Makefile: 'test:\n\tuv sync\n' }), true);
});

test('detect_uv_need says no for a project that never mentions uv', { skip }, () => {
  assert.strictEqual(uvNeeded({ 'CLAUDE.md': 'Run tests with pytest.', Makefile: 'test:\n\tpytest\n' }), false);
  assert.strictEqual(uvNeeded({}), false);
});

test('detect_uv_need does not fire on uv inside a longer word', { skip }, () => {
  // Two separate guards, both of which pull the whole uv toolchain into every
  // image built from the repo if they regress. The trailing space in `uv `
  // rules out uvicorn; the leading \b rules out a word merely ending in uv.
  assert.strictEqual(uvNeeded({ 'CLAUDE.md': 'Serve it with uvicorn behind nginx.' }), false);
  assert.strictEqual(uvNeeded({ 'CLAUDE.md': 'Deployed from the Louv staging host.' }), false);
});

// --- resolve_main_ref --------------------------------------------------------

const mainRef = (repo) => run(`${SRC.resolve_main_ref}\nresolve_main_ref ${JSON.stringify(repo)}`);

test('resolve_main_ref prefers origin/HEAD when it is set', { skip }, () => {
  const origin = repoWith({ 'a.txt': 'a' });
  const clone = path.join(scratch(), 'clone');
  execFileSync('git', ['clone', '-q', origin, clone], { env: GIT_ENV });
  const r = mainRef(clone);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'origin/main');
});

test('resolve_main_ref falls back to a local main or master', { skip }, () => {
  assert.strictEqual(mainRef(repoWith({ 'a.txt': 'a' })).stdout.trim(), 'main');
  assert.strictEqual(mainRef(repoWith({ 'a.txt': 'a' }, { branch: 'master' })).stdout.trim(), 'master');
});

test('resolve_main_ref fails rather than guessing when there is no commit', { skip }, () => {
  const empty = path.join(scratch(), 'empty');
  fs.mkdirSync(empty);
  git(empty, 'init', '-q', '-b', 'main');
  const r = mainRef(empty);
  assert.strictEqual(r.code, 1, 'an unresolvable repo must return non-zero, not print a bad ref');
  assert.strictEqual(r.stdout.trim(), '');
});

// --- build_repo_snapshot -----------------------------------------------------

function snapshot(repo, { name = 'demo', ref = 'main', root } = {}) {
  const snapRoot = root || scratch();
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8', env: GIT_ENV }).trim();
  const r = run(`REPO_SNAPSHOT_ROOT=${JSON.stringify(snapRoot)}
${SRC.build_repo_snapshot}
build_repo_snapshot ${JSON.stringify(repo)} ${name} ${ref} ${sha}`);
  return { ...r, dest: path.join(snapRoot, name, sha), snapRoot };
}

test('build_repo_snapshot archives the ref and marks it complete', { skip }, () => {
  const repo = repoWith({ 'a.txt': 'hello', 'src/b.txt': 'world' });
  const { code, dest } = snapshot(repo);
  assert.strictEqual(code, 0);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hello');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'src', 'b.txt'), 'utf8'), 'world');
  assert.ok(fs.existsSync(path.join(dest, '.ok')), '.ok marks the snapshot as fully extracted');
});

test('build_repo_snapshot leaves untracked and ignored files behind', { skip }, () => {
  // The snapshot is mounted read-only into other sandboxes; picking up
  // untracked files would leak local scratch work across sessions.
  const repo = repoWith({ 'a.txt': 'hello', '.gitignore': 'secret.env\n' });
  fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=abc');
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'wip');
  const { dest } = snapshot(repo);
  assert.ok(!fs.existsSync(path.join(dest, 'secret.env')), 'ignored file must not be snapshotted');
  assert.ok(!fs.existsSync(path.join(dest, 'scratch.txt')), 'untracked file must not be snapshotted');
});

test('build_repo_snapshot is a no-op once the snapshot exists', { skip }, () => {
  const repo = repoWith({ 'a.txt': 'hello' });
  const first = snapshot(repo);
  fs.writeFileSync(path.join(first.dest, 'a.txt'), 'edited in place');
  const second = snapshot(repo, { root: first.snapRoot });
  assert.strictEqual(second.code, 0);
  assert.strictEqual(fs.readFileSync(path.join(first.dest, 'a.txt'), 'utf8'), 'edited in place',
    'an existing .ok snapshot must be reused, not re-extracted on every launch');
});

test('build_repo_snapshot cleans up after an unusable ref', { skip }, () => {
  const repo = repoWith({ 'a.txt': 'hello' });
  const snapRoot = scratch();
  const r = run(`REPO_SNAPSHOT_ROOT=${JSON.stringify(snapRoot)}
${SRC.build_repo_snapshot}
build_repo_snapshot ${JSON.stringify(repo)} demo refs/heads/nope deadbeef`);
  assert.strictEqual(r.code, 0, 'a bad ref must not abort the launch');
  assert.ok(!fs.existsSync(path.join(snapRoot, 'demo', 'deadbeef')), 'no half-built snapshot');
  const leftovers = fs.existsSync(path.join(snapRoot, 'demo'))
    ? fs.readdirSync(path.join(snapRoot, 'demo')).filter((f) => f.startsWith('.tmp-'))
    : [];
  assert.deepStrictEqual(leftovers, [], 'the temp extraction dir must not be left behind');
});

// --- check_gc_nudge ----------------------------------------------------------

// Stubs list_tool_worktrees and git so the nudge's own throttle is what's
// under test, not the worktree scan it shares with gc_worktrees.
function gcNudge({ stampAgeDays = null, gone = 1 } = {}) {
  const stateDir = scratch();
  if (stampAgeDays !== null) {
    const stamp = path.join(stateDir, '.last-gc');
    fs.writeFileSync(stamp, '2026-01-01T00:00:00Z');
    const when = new Date(Date.now() - stampAgeDays * 86400 * 1000);
    fs.utimesSync(stamp, when, when);
  }
  return run(`STATE_DIR=${JSON.stringify(stateDir)}
REPO_PATH=/repo
REPO_NAME=demo
list_tool_worktrees() { echo "SCANNED" >&2; printf 'alpha\\tclaude/alpha\\t/wt\\n'; }
git() { ${gone ? 'echo "[gone]"' : 'echo "[ahead 1]"'}; }
${SRC.check_gc_nudge}
check_gc_nudge`);
}

test('check_gc_nudge reports worktrees whose remote branch is gone', { skip }, () => {
  const r = gcNudge({ stampAgeDays: null });
  assert.match(r.stdout, /1 worktree\(s\) have deleted remote branches/);
  assert.match(r.stdout, /--gc/, 'the nudge must name the command that fixes it');
});

test('check_gc_nudge stays quiet when nothing is collectable', { skip }, () => {
  assert.strictEqual(gcNudge({ stampAgeDays: null, gone: 0 }).stdout.trim(), '');
});

test('check_gc_nudge skips the scan entirely for a week after the last gc', { skip }, () => {
  // The scan runs on every launch, so the throttle is what keeps a per-worktree
  // git call off the startup path.
  const r = gcNudge({ stampAgeDays: 1 });
  assert.strictEqual(r.stdout.trim(), '');
  assert.doesNotMatch(r.stderr, /SCANNED/, 'a fresh stamp must short-circuit before scanning');
});

test('check_gc_nudge resumes scanning once the stamp is older than 7 days', { skip }, () => {
  const r = gcNudge({ stampAgeDays: 9 });
  assert.match(r.stderr, /SCANNED/);
  assert.match(r.stdout, /deleted remote branches/);
});

// --- cleanup_worktree --------------------------------------------------------

// The repo gets a real remote with main already pushed. Without one,
// `rev-list HEAD --not --remotes` counts every commit as unpushed and the
// worktree always looks dirty — so a remote-less fixture would silently test
// only the "keep" branch of this function.
function cleanup({ dirty = false, unpushed = false, created = true, branchMode = false, branchCreated = true } = {}) {
  const root = scratch();
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const repo = path.join(root, 'demo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const wt = path.join(root, 'demo-wt-alpha');
  git(repo, 'worktree', 'add', '-q', '-b', 'claude/alpha', wt);
  if (dirty) fs.writeFileSync(path.join(wt, 'scratch.txt'), 'wip');
  if (unpushed) git(wt, 'commit', '-q', '--allow-empty', '-m', 'work');

  const r = run(`WT_CREATED=${created}
WT_PATH=${JSON.stringify(wt)}
WT_BRANCH=claude/alpha
REPO_PATH=${JSON.stringify(repo)}
BRANCH_MODE=${branchMode}
WT_BRANCH_CREATED=${branchCreated}
${SRC.cleanup_worktree}
cleanup_worktree`);
  const branches = execFileSync('git', ['-C', repo, 'branch', '--format=%(refname:short)'],
    { encoding: 'utf8', env: GIT_ENV }).split('\n').filter(Boolean);
  return { ...r, wtExists: fs.existsSync(wt), branches };
}

test('cleanup_worktree removes a clean worktree and its branch', { skip }, () => {
  const r = cleanup();
  assert.match(r.stdout, /Worktree clean — removing/);
  assert.strictEqual(r.wtExists, false);
  assert.ok(!r.branches.includes('claude/alpha'), 'the branch it created goes with it');
});

test('cleanup_worktree keeps a worktree with uncommitted changes', { skip }, () => {
  const r = cleanup({ dirty: true });
  assert.match(r.stdout, /Worktree kept \(has changes\)/);
  assert.strictEqual(r.wtExists, true, 'uncommitted work must survive the session');
  assert.ok(r.branches.includes('claude/alpha'));
});

test('cleanup_worktree keeps a worktree holding unpushed commits', { skip }, () => {
  const r = cleanup({ unpushed: true });
  assert.match(r.stdout, /Worktree kept \(has changes\)/);
  assert.strictEqual(r.wtExists, true, 'commits with no remote copy must survive the session');
});

test('cleanup_worktree tells you how to push and how to remove what it kept', { skip }, () => {
  const r = cleanup({ dirty: true });
  assert.match(r.stdout, /git push -u origin claude\/alpha/);
  assert.match(r.stdout, /worktree remove/);
});

test('cleanup_worktree leaves worktrees it did not create alone', { skip }, () => {
  const r = cleanup({ created: false });
  assert.strictEqual(r.stdout.trim(), '');
  assert.strictEqual(r.wtExists, true);
});

test('cleanup_worktree never deletes a branch that existed before the session', { skip }, () => {
  // -b runs on a branch the user already had; removing the worktree is fine,
  // deleting their branch is not.
  const r = cleanup({ branchMode: true, branchCreated: false });
  assert.match(r.stdout, /Keeping pre-existing branch: claude\/alpha/);
  assert.strictEqual(r.wtExists, false, 'the worktree still goes away');
  assert.ok(r.branches.includes('claude/alpha'), 'the pre-existing branch must survive');
});
