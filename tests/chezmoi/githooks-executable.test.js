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

// chezmoi reads attribute prefixes in a fixed order, and these four come before
// `executable_`, so `private_executable_pre-commit` is executable too.
const EXECUTABLE = /^((encrypted|private|readonly|empty)_)*executable_/;

// A named member, not a count: secrets-check.js alone would make the census non-empty
// while the hooks this test exists for had moved out from under it.
test('the census reaches the vault pre-commit hook', () => {
  assert.ok(hookFiles.includes('private_dot_claude/vault-tooling/githooks/executable_pre-commit'),
    `vault pre-commit hook not among ${JSON.stringify(hookFiles)}; this test checks nothing`);
});

test('every hook in a githooks/ source directory deploys executable', () => {
  const missing = hookFiles.filter((f) => {
    const name = path.basename(f);
    return !name.endsWith('.js') && !EXECUTABLE.test(name);
  });
  assert.deepStrictEqual(missing, [], 'add the executable_ prefix, or git skips the deployed hook');
});
