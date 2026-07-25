// Wires the vault-tooling/claude-audit-portable package's own test files into
// `node --test`. They live under a dot-directory (pkg/.claude/...), which
// `node --test`'s default discovery skips, so they'd otherwise never run as
// part of the suite even though they're tracked and pass standalone. Each
// file is a self-contained script (custom test() harness, not node:test)
// that exits non-zero on any failure.
// Offline and deterministic.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const PKG = path.join(__dirname, '..', 'home', 'private_dot_claude', 'vault-tooling', 'claude-audit-portable', 'pkg', '.claude');

const SUITES = [
  path.join(PKG, 'hooks', 'log-permission.test.js'),
  path.join(PKG, 'scripts', 'audit-permissions.test.js'),
];

for (const file of SUITES) {
  test(`vault-audit-portable: ${path.relative(PKG, file)}`, () => {
    execFileSync('node', [file], { stdio: 'pipe' });
  });
}
