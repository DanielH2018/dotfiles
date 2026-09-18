// Where the source tree is, from a test.
//
// A test reads the script it covers out of the chezmoi source under home/, and 111 of them
// derived that location themselves as `path.join(__dirname, '..', 'home', ...)` -- with as many
// '..' as the file is deep, so a test that moved a directory broke on the path before it ran
// anything. Twenty-five more bound a local REPO or ROOT first and joined 'home' onto that.
// This is the one place that knows where the tree is.
//
// srcPath(...segments)  -> a path under home/, in the SOURCE spelling: 'dot_local', 'bin',
//          'executable_tq', not the deployed '.local/bin/tq'. A test reads what is committed.
//          With no segments it is home/ itself.
// repoPath(...segments) -> a path under the checkout (the worktree, not the primary checkout):
//          bin/, .githooks/, config-soak.json.
// REPO, SOURCE  the same two roots as values, for the other tests/lib modules. A test file
//          calls the functions instead, and the reason is the guard below.
//
// tests/lib/sandbox-escape.js treats a `srcPath(` or `repoPath(` call as a root: a write whose
// destination is built from one is a write into the checkout, reported exactly as one built
// from `__dirname`. It seeds by token because string literals are blanked before it scans, so
// it cannot see what a require() names -- which is also why a test must not bind the bare
// REPO or SOURCE values: `const { SOURCE } = require('./lib/paths')` carries no taint, and a
// name like SOURCE is too common (a fixture string, a file's contents) to seed on.
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const SOURCE = path.join(REPO, 'home');

function srcPath(...segments) {
  return path.join(SOURCE, ...segments);
}

function repoPath(...segments) {
  return path.join(REPO, ...segments);
}

module.exports = { REPO, SOURCE, srcPath, repoPath };
