// Regression guard for home/dot_local/bin/executable_redproof.
// redproof's promise is a red proof that never touches the checkout: the copy carries the
// checkout's uncommitted and untracked changes, puts the named paths back at REF, and is gone
// afterwards. Each test builds a real repo where `mod.py` changed after the first commit and
// an untracked `check.py` asserts the new behaviour.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const TOOL = srcPath('dot_local', 'bin', 'executable_redproof');
const skip = skipUnless('git', 'python3');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function repo(t) {
  const dir = scratch(os.tmpdir(), 'redproof-', t);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c');
  git(dir, 'config', 'user.name', 'a');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'mod.py'), 'def f():\n    return 1\n');
  fs.writeFileSync(path.join(dir, 'README'), 'readme\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'mod.py'), 'def f():\n    return 2\n');
  fs.writeFileSync(path.join(dir, 'check.py'), 'import sys\nsys.path.insert(0, ".")\nfrom mod import f\nassert f() == 2\n');
  return { dir, base };
}

const run = (cwd, args) => spawnSync('python3', ['-I', TOOL, ...args], { cwd, encoding: 'utf8' });
const state = (dir) => [git(dir, 'status', '--porcelain'), fs.readFileSync(path.join(dir, 'mod.py'), 'utf8')];

test('a check that fails at the base is RED, and the checkout is left exactly as it was', { skip }, (t) => {
  const { dir, base } = repo(t);
  const before = state(dir);
  const r = run(dir, [base, 'mod.py', '--', 'python3', 'check.py']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /redproof: RED: the command exited 1 with mod\.py at /);
  assert.deepStrictEqual(state(dir), before);
  assert.strictEqual(git(dir, 'worktree', 'list').trim().split('\n').length, 1);
});

test('a check that still passes at the base is NOT RED', { skip }, (t) => {
  const { dir, base } = repo(t);
  const r = run(dir, [base, 'README', '--', 'python3', 'check.py']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /redproof: NOT RED: the command passed with README at /);
});

test('a path the base lacks is deleted in the copy, and a subdirectory cwd is kept', { skip }, (t) => {
  const { dir, base } = repo(t);
  fs.writeFileSync(path.join(dir, 'sub', 'new.py'), 'X = 1\n');
  const probe = 'import os; print(os.path.basename(os.getcwd())); assert not os.path.exists("new.py")';
  const r = run(path.join(dir, 'sub'), [base, 'new.py', '--', 'python3', '-c', probe]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^sub$/m);
  assert.ok(fs.existsSync(path.join(dir, 'sub', 'new.py')));
});

test('a usage error or a ref that is no commit runs nothing', { skip }, (t) => {
  const { dir, base } = repo(t);
  for (const args of [[base, 'mod.py', 'python3'], [base, '--', 'true'], [base, 'mod.py', '--'],
    [base, '-x', 'mod.py', '--', 'true'], [base, 'mod.py', '--', 'redproof', base, 'x', '--', 'true']]) {
    assert.strictEqual(run(dir, args).status, 2, JSON.stringify(args));
  }
  assert.strictEqual(run(dir, ['no-such-ref', 'mod.py', '--', 'true']).status, 3);
  assert.strictEqual(git(dir, 'worktree', 'list').trim().split('\n').length, 1);
});
