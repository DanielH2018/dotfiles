// Regression guard for bin/install-hook-shim.
// The shim it installs is what stops git's GIT_DIR leaking into the test suite and
// letting fixture repos commit onto this repo's branch. It lives in .git/, so no
// checkout restores it — these tests pin the "re-assert it" behaviour that replaces
// the checkout: repair from missing, from a stale body, from a redirected
// core.hooksPath, and — the case the whole arrangement exists for — from a linked
// worktree, where the shim must land in the shared .git and not the worktree's own.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { repoPath } = require('../lib/paths');
const { run } = require('../lib/run');

const INSTALLER = repoPath('bin', 'install-hook-shim');

const skip = skipUnless('bash', 'git');

// Strip every GIT_* var: inheriting GIT_DIR here would point the fixture repos at
// whatever repo is running the suite, which is precisely the bug under test. The two put
// back cut the fixtures off from the machine's git config for the same kind of reason —
// a global core.hooksPath or commit signing would decide what these tests observe.
const CLEAN_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

const install = (cwd, ...args) => run('bash', [INSTALLER, ...args], { cwd, env: CLEAN_ENV });

// A repo that ships the gate the shim delegates to, so the installed shim is
// exercisable rather than inert.
function makeRepo() {
  const dir = scratch(os.tmpdir(), 'shim-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, '.githooks'));
  fs.writeFileSync(path.join(dir, '.githooks', 'pre-push'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const shimPath = (repo) => path.join(repo, '.git', 'hooks-safe', 'pre-push');

test('installs the shim and points core.hooksPath at it', { skip }, () => {
  const repo = makeRepo();
  const r = install(repo);

  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /repaired/);
  assert.ok(fs.existsSync(shimPath(repo)), 'shim written');
  assert.strictEqual(git(repo, 'config', '--get', 'core.hooksPath'),
    path.join(fs.realpathSync(repo), '.git', 'hooks-safe'));
  assert.ok(fs.statSync(shimPath(repo)).mode & 0o111, 'shim executable');
  assert.match(fs.readFileSync(shimPath(repo), 'utf8'), /unset GIT_DIR/);
});

test('second run is a silent no-op', { skip }, () => {
  const repo = makeRepo();
  install(repo);

  const again = install(repo, '--quiet');
  assert.strictEqual(again.code, 0);
  assert.strictEqual(again.stdout, '', 'nothing printed when already correct');

  const loud = install(repo);
  assert.match(loud.stdout, /already installed/);
});

test('--check reports without writing, and exits 1 only when repair is needed', { skip }, () => {
  const repo = makeRepo();

  const before = install(repo, '--check');
  assert.strictEqual(before.code, 1, 'unconfigured repo needs repair');
  assert.ok(!fs.existsSync(shimPath(repo)), '--check must not write');

  install(repo);
  assert.strictEqual(install(repo, '--check').code, 0);
});

test('repairs a redirected core.hooksPath', { skip }, () => {
  const repo = makeRepo();
  install(repo);

  // The documented undo, and the exact way the guard silently came off before.
  git(repo, 'config', 'core.hooksPath', '.githooks');
  assert.strictEqual(install(repo, '--check').code, 1);

  const r = install(repo);
  assert.match(r.stdout, /core\.hooksPath=\.githooks/);
  assert.strictEqual(git(repo, 'config', '--get', 'core.hooksPath'),
    path.join(fs.realpathSync(repo), '.git', 'hooks-safe'));
});

test('repairs a deleted shim and a tampered body', { skip }, () => {
  const repo = makeRepo();
  install(repo);

  fs.rmSync(shimPath(repo));
  assert.match(install(repo).stdout, /shim missing/);
  assert.ok(fs.existsSync(shimPath(repo)));

  fs.writeFileSync(shimPath(repo), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  assert.match(install(repo).stdout, /shim body stale/);
  assert.match(fs.readFileSync(shimPath(repo), 'utf8'), /unset GIT_DIR/);
});

test('replaces the shim by rename, leaving a push already reading it intact', { skip }, () => {
  const repo = makeRepo();
  install(repo);
  const shim = shimPath(repo);

  // Drift, so the next run actually rewrites.
  const stale = '#!/usr/bin/env bash\nexit 0\n';
  fs.writeFileSync(shim, stale, { mode: 0o755 });
  const staleIno = fs.statSync(shim).ino;

  // Stand in for a push mid-flight: bash reads a hook script incrementally as it
  // executes, so truncating the path in place would hand that shell the new
  // bytes partway through. Holding the descriptor is what a running push has.
  const fd = fs.openSync(shim, 'r');
  try {
    assert.match(install(repo).stdout, /repaired/);

    assert.strictEqual(fs.readFileSync(fd, 'utf8'), stale,
      'the open descriptor still sees the file it opened, not the replacement');
    assert.notStrictEqual(fs.statSync(shim).ino, staleIno,
      'the path points at a new inode — a rename, not a truncate');
  } finally {
    fs.closeSync(fd);
  }

  assert.match(fs.readFileSync(shim, 'utf8'), /unset GIT_DIR/);
  assert.ok(fs.statSync(shim).mode & 0o111, 'replacement is executable');
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(shim)).filter((f) => f !== 'pre-push'), [],
    'no temp file left behind',
  );
});

test('from a linked worktree, installs into the shared .git', { skip }, () => {
  const repo = makeRepo();
  const wtRoot = scratch(os.tmpdir(), 'shim-wt-');
  const wt = path.join(wtRoot, 'w');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);

  const r = install(wt);
  assert.strictEqual(r.code, 0);

  // The point of the whole arrangement: one shim, in the common dir, covering
  // every worktree regardless of which commit it holds.
  assert.ok(fs.existsSync(shimPath(repo)), 'shim in the main .git');
  assert.ok(!fs.existsSync(path.join(wt, '.git', 'hooks-safe', 'pre-push')),
    'not in the worktree private dir');
  assert.strictEqual(git(wt, 'config', '--get', 'core.hooksPath'),
    path.join(fs.realpathSync(repo), '.git', 'hooks-safe'));
});

test('outside a repo it exits quietly, so it can never fail a session', { skip }, () => {
  const notRepo = scratch(os.tmpdir(), 'shim-bare-');
  const r = install(notRepo);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
});

test('rejects an unknown flag rather than guessing', { skip }, () => {
  const repo = makeRepo();
  const r = install(repo, '--force');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /usage/);
});

