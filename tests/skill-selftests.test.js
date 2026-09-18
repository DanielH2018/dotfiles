// Wires the skills' bash self-test suites into `node --test`. Each script is
// runnable directly (`bash test_x.sh`) and exits non-zero on failure. Offline
// and deterministic. Skips cleanly if bash is unavailable.
//
// (home/private_dot_claude/skills/config-lint/scripts/config-lint.test.js is
// already auto-discovered by `node --test` — not wired here.)
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { skipUnless } = require('./lib/probe');

const skip = skipUnless('bash');

const SUITES = [
  path.join(__dirname, '..', 'home', 'private_dot_claude', 'skills', 'pr-feedback', 'scripts', 'executable_test_fetch.sh'),
  path.join(__dirname, '..', 'home', 'private_dot_claude', 'skills', 'pr-feedback', 'scripts', 'executable_test_render.sh'),
  path.join(__dirname, '..', 'home', 'private_dot_claude', 'skills', 'pr-review-prep', 'references', 'test_triage.sh'),
];

for (const script of SUITES) {
  test(`skill self-test: ${path.basename(script)}`, { skip }, () => {
    execFileSync('bash', [script], { stdio: 'pipe' });
  });
}
