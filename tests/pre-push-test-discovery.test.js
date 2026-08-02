// `node --test`'s default discovery skips any directory whose name begins with a dot, at
// any depth (verified on node 24.18.1). Two tracked suites live under
// vault-tooling/claude-audit-portable/pkg/.claude/, so the gate could not find them on its
// own. That was handled by a wrapper file carrying a hand-written list of the two paths —
// correct, but the list had to be remembered: a third suite added under any dot-directory
// would have been skipped in silence, and a skipped suite looks exactly like a passing one
// because the only evidence is a total nobody has a baseline for.
//
// So .githooks/pre-push now derives the file list from `git ls-files` and passes it
// explicitly, making the covered set the tracked set by construction. This file guards that
// property, because the failure it prevents is invisible: if someone restores a bare
// `node --test`, every suite under a dot-directory silently stops running and the push still
// reports green.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const HOOK = path.join(REPO, '.githooks', 'pre-push');
const hookText = fs.readFileSync(HOOK, 'utf8');

const trackedTests = execFileSync('git', ['ls-files', '*.test.js', '*.test.mjs'], { cwd: REPO })
  .toString()
  .split('\n')
  .filter(Boolean);

test('the hook derives its test list from git rather than node discovery', () => {
  assert.match(
    hookText,
    /TEST_FILES=\$\(git ls-files '\*\.test\.js' '\*\.test\.mjs'\)/,
    'pre-push must build the unit-test file list with git ls-files',
  );
});

test('the hook passes that list to the runner instead of letting node discover', () => {
  assert.match(
    hookText,
    /run "unit tests \(node --test\)" tq_node unit \$TEST_FILES/,
    'pre-push must pass $TEST_FILES to the runner; a bare invocation re-enables node discovery',
  );
});

test('an empty list fails the gate rather than falling back to discovery', () => {
  // Without this branch, `node --test` with zero arguments quietly reverts to its own
  // walk — the exact behaviour being replaced — so the guard has to be a failure, not a skip.
  assert.match(hookText, /if \[ -z "\$TEST_FILES" \]/);
});

test('every tracked test file under a dot-directory is still covered', () => {
  // Vacuous if none exist, which is the point: this asserts the derived globs keep reaching
  // the files node cannot see, without pinning where those files happen to live today.
  const hidden = trackedTests.filter((p) => p.split('/').some((seg) => seg.startsWith('.')));
  for (const file of hidden) {
    assert.ok(
      /\.test\.(js|mjs)$/.test(file),
      `${file} sits under a dot-directory but does not match the globs in pre-push, so nothing runs it`,
    );
  }
});

test('the tracked test set is non-trivial', () => {
  // Guards the guard: if `git ls-files` ever returns nothing here (wrong cwd, pathspec
  // change), the assertions above would pass vacuously and prove nothing.
  assert.ok(trackedTests.length > 100, `expected the full suite, saw ${trackedTests.length} files`);
});
