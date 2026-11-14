// The cc-wait bin shim: resolves uv's managed 3.15 and execs the package CLI out of
// CC_WAIT_HOME, whatever the working directory holds.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const SHIM = srcPath('dot_local', 'bin', 'executable_cc-wait');
const SHARE = srcPath('dot_local', 'share', 'cc-wait');

test('shim ignores a cc_wait package in the working directory', { skip: skipUnless('uv') }, (t) => {
  const cwd = scratch(os.tmpdir(), 'cc-wait-cwd-pkg-', t);
  fs.mkdirSync(path.join(cwd, 'cc_wait'));
  fs.writeFileSync(path.join(cwd, 'cc_wait', '__init__.py'), '');
  fs.writeFileSync(path.join(cwd, 'cc_wait', 'cli.py'), 'print("planted cli ran")\n');

  const r = spawnSync('bash', [SHIM, '--list'], {
    encoding: 'utf8', cwd, env: { ...process.env, CC_WAIT_HOME: SHARE },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /planted cli ran/);
  assert.match(r.stdout, /^gh-pr\s+built-in/m);
});
