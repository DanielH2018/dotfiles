// Regression guard for executable_auto-format.sh (PostToolUse Edit|Write): every
// formatter runs through run_bounded (#581). Drives the ACTUAL hook with a STUB `shfmt`
// on PATH, so no real formatter is needed. Skips without bash/jq/timeout: run_bounded is
// built on timeout(1), and without one it reports every formatter as not evaluated.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_auto-format.sh');

const skip = skipUnless('bash', 'jq', 'timeout');

const DIR = scratch(os.tmpdir(), 'autofmt-');
const BIN = path.join(DIR, 'bin');
fs.mkdirSync(BIN);
// The stub formats by appending a marker, or hangs when AUTOFMT_STUB_SLOW is set.
fs.writeFileSync(path.join(BIN, 'shfmt'), `#!/bin/bash
[ -n "\${AUTOFMT_STUB_SLOW:-}" ] && sleep 30
for a in "$@"; do f=$a; done
echo '# formatted' >> "$f"
`, { mode: 0o755 });

function run(env = {}) {
  const file = path.join(DIR, 'x.sh');
  fs.writeFileSync(file, 'echo hi\n');
  const started = Date.now();
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { file_path: file } }),
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${BIN}:${process.env.PATH}`, HOME: DIR,
      XDG_STATE_HOME: path.join(DIR, 'state'), ...env,
    },
  });
  return {
    status: r.status, stderr: r.stderr, body: fs.readFileSync(file, 'utf8'),
    seconds: (Date.now() - started) / 1000,
  };
}

test('a formatter that finishes formats the file and says nothing', { skip }, () => {
  const r = run();
  assert.strictEqual(r.status, 0);
  assert.match(r.body, /# formatted/);
  assert.strictEqual(r.stderr, '');
});

test('a formatter that hangs is cut off at its bound and named', { skip }, () => {
  const r = run({ AUTOFMT_STUB_SLOW: '1', AUTO_FORMAT_TIMEOUT_S: '1' });
  assert.ok(r.seconds < 10, `took ${r.seconds}s`);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /shfmt did not finish on x\.sh within 1s \(timeout\)/);
});

test('a missing run-bounded.sh runs no formatter and exits 1', { skip }, () => {
  const r = run({ RUN_BOUNDED_LIB: path.join(DIR, 'no-such-lib.sh') });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /cannot load .*x\.sh left unformatted/);
  assert.doesNotMatch(r.body, /# formatted/);
});
