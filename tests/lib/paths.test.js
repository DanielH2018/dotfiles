// tests/lib/paths.js: the values point at this checkout's source tree, not at wherever the
// process happens to run from.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SOURCE, srcPath, repoPath } = require('./paths');

test('REPO is this checkout: it holds .chezmoiroot and this file', () => {
  assert.strictEqual(fs.readFileSync(path.join(REPO, '.chezmoiroot'), 'utf8').trim(), 'home');
  assert.strictEqual(fs.realpathSync(path.join(REPO, 'tests', 'lib', 'paths.test.js')), fs.realpathSync(__filename));
});

test('SOURCE is the chezmoi source root under it', () => {
  assert.strictEqual(SOURCE, path.join(REPO, 'home'));
  assert.ok(fs.existsSync(path.join(SOURCE, '.chezmoiscripts')));
});

test('repoPath joins onto REPO', () => {
  assert.strictEqual(repoPath('bin', 'land'), path.join(REPO, 'bin', 'land'));
  assert.ok(fs.existsSync(repoPath('bin', 'land')));
  assert.strictEqual(repoPath(), REPO);
});

test('srcPath joins onto SOURCE and does not resolve against cwd', () => {
  assert.strictEqual(srcPath('dot_local', 'bin', 'executable_tq'), path.join(SOURCE, 'dot_local', 'bin', 'executable_tq'));
  assert.ok(fs.existsSync(srcPath('dot_local', 'bin', 'executable_tq')), 'a committed script is where srcPath says');
  assert.strictEqual(srcPath(), SOURCE);
});
