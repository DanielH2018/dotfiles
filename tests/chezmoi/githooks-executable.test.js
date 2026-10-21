// A git hook that is not executable is skipped, and git says so only as a `hint:` line.
//
// chezmoi sets a deployed file's mode from its source name alone: `executable_` gives
// 0755, anything else 0644, whatever mode git stores for the source file. The vault's
// pre-commit and pre-push hooks were committed as 100755 but without the prefix, so they
// deployed to ~/.claude/vault-tooling/githooks/ as 0644. From 2026-07-13 to 2026-10-21
// the vault's core.hooksPath pointed at hooks git never ran, and no vault commit was
// scanned for secrets.
//
// Every file in a githooks/ source directory is a hook git executes by name, except the
// .js helpers a hook runs through `node` and their tests. Those carry no prefix.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { srcPath } = require('../lib/paths');

// The git index, not a directory walk, so an untracked scratch file cannot fail the test.
const tracked = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: srcPath(), encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const hookFiles = tracked.filter((f) => path.basename(path.dirname(f)) === 'githooks');

test('the tree has a githooks/ source directory to check', () => {
  assert.ok(hookFiles.length > 0, 'no githooks/ directory under home/; this test checks nothing');
});

test('every hook in a githooks/ source directory deploys executable', () => {
  const missing = hookFiles.filter((f) => {
    const name = path.basename(f);
    return !name.endsWith('.js') && !name.startsWith('executable_');
  });
  assert.deepStrictEqual(missing, [], 'add the executable_ prefix, or git skips the deployed hook');
});
