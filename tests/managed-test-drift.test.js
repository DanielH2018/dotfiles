// A13-16: nothing stops a new test file or fixture from deploying into ~/.claude.
//
// `home/.chezmoiignore` excludes .venv and .pytest_cache, but has no rule for
// `**/test_*`, `**/*.test.js` or `**/fixtures`. Thirty-eight such paths are managed
// today and every one of them is deliberate — self-contained tool packages that run
// their own tests from the deployed location. The risk is not those thirty-eight. It is
// the thirty-ninth: add a test file anywhere under `home/` and it silently ships.
//
// The audit's remedy was an ignore block plus `!`-re-includes plus this assertion. The
// assertion comes first on purpose, because it is the half with no downside. An
// over-broad ignore rule silently STOPS deploying something real, which is a worse
// failure than the drift it prevents — whereas this test can only ever fail loudly, and
// it catches movement in both directions.
//
// Deliberately uses `--source <this tree>/home` rather than bare `chezmoi managed`:
// `.chezmoi.sourceDir` always resolves to the primary checkout, so a bare invocation in
// a worktree would assert against a different tree's files and report the result as this
// one's — the skew that already caught out tests/modify_settings.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SOURCE = path.join(REPO, 'home');
const ALLOWLIST = path.join(__dirname, 'managed-test-paths.txt');
const PATTERN = /test|fixture|conftest/i;

let have = true;
try { execFileSync('bash', ['-c', 'command -v chezmoi'], { stdio: 'ignore' }); } catch { have = false; }
const skip = have ? false : 'chezmoi unavailable';

const readAllowlist = () => fs.readFileSync(ALLOWLIST, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .sort();

function managedMatches() {
  const r = spawnSync('chezmoi', ['managed', '--source', SOURCE], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `chezmoi managed failed: ${r.stderr}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && PATTERN.test(l)).sort();
}

test('no test file or fixture deploys into the home tree without being on the allowlist', { skip }, () => {
  const actual = managedMatches();
  const allowed = readAllowlist();

  const added = actual.filter((p) => !allowed.includes(p));
  const removed = allowed.filter((p) => !actual.includes(p));

  const advice = added.length ? [
    '',
    'A path matching /test|fixture|conftest/ is now deployed but is not on the allowlist.',
    'Two ways to resolve, and the choice is the point of this test:',
    '  1. It should NOT ship — exclude it in home/.chezmoiignore. Use the CONTENTS form',
    '     (`**/tests/*`, not `**/tests`): excluding a directory outright makes any',
    '     `!`-re-include inside it impossible, exactly as in gitignore.',
    '  2. It SHOULD ship — add it to tests/managed-test-paths.txt, which records that as',
    '     a decision someone made rather than something that drifted in.',
  ].join('\n') : '';

  assert.deepStrictEqual(
    { added, removed }, { added: [], removed: [] },
    `managed test/fixture paths drifted from the allowlist:\n`
    + `  added (deploying but unlisted): ${added.length ? added.join(', ') : 'none'}\n`
    + `  removed (listed but no longer deploying): ${removed.length ? removed.join(', ') : 'none'}`
    + advice,
  );
});

// A guard nobody has seen fail is a guard nobody knows works. This creates a file that
// would ship, proves the check rejects it, and removes it again.
test('the guard actually catches a newly-added test file', { skip }, () => {
  const intruder = path.join(SOURCE, 'private_dot_claude', 'test_a13_16_probe.sh');
  assert.ok(!fs.existsSync(intruder), 'probe path already exists; refusing to clobber it');
  fs.writeFileSync(intruder, '#!/bin/sh\n# transient fixture for tests/managed-test-drift.test.js\n');
  try {
    const withIntruder = managedMatches();
    const allowed = readAllowlist();
    const added = withIntruder.filter((p) => !allowed.includes(p));
    assert.ok(
      added.some((p) => p.endsWith('test_a13_16_probe.sh')),
      `the drift check did not notice a new deploying test file. added=${JSON.stringify(added)}`,
    );
  } finally {
    fs.rmSync(intruder, { force: true });
  }
  assert.ok(!fs.existsSync(intruder), 'probe file was not cleaned up');
});
