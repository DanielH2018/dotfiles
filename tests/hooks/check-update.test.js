// Regression guard for executable_check-update.sh (SessionStart): `claude --version` runs
// through run_bounded (#581, #657). Drives the ACTUAL hook with a STUB `claude` on PATH.
// Skips without bash/timeout: run_bounded is built on timeout(1).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_check-update.sh');

const skip = skipUnless('bash', 'timeout');

const DIR = scratch(os.tmpdir(), 'check-update-');
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/bash
[ -n "\${STUB_CLAUDE_SLOW:-}" ] && sleep 30
echo "\${STUB_CLAUDE_VERSION:-2.0.0} (Claude Code)"
`, { mode: 0o755 });

function run(env = {}) {
  const started = Date.now();
  const r = spawnSync('bash', [HOOK], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, HOME: DIR, CHECK_UPDATE_TIMEOUT_S: '1', ...env },
  });
  return { ...r, seconds: (Date.now() - started) / 1000 };
}

test('a version change since the last session is announced', { skip }, () => {
  fs.rmSync(path.join(DIR, '.claude'), { recursive: true, force: true });
  assert.strictEqual(run({ STUB_CLAUDE_VERSION: '2.0.0' }).stdout, '');
  assert.match(run({ STUB_CLAUDE_VERSION: '2.0.1' }).stdout, /updated from v2\.0\.0 to v2\.0\.1/);
});

test('a hung claude --version is cut off and named', { skip }, () => {
  const r = run({ STUB_CLAUDE_SLOW: '1' });
  assert.ok(r.seconds < 4, `took ${r.seconds}s`);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /claude --version did not finish within 1s \(timeout\)/);
});

test('a missing run-bounded.sh runs nothing and exits 1', { skip }, () => {
  const r = run({ RUN_BOUNDED_LIB: path.join(DIR, 'no-such-lib.sh') });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /cannot load /);
});
