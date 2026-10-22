// lib/guard-python.sh: the one interpreter lookup the claude_guard shims share, and its cache.
// The cache sits in a directory the Bash sandbox can write, while the deny hook execs what it
// names outside the sandbox, so the tests that matter are the ones where the cache is NOT
// believed. A stub `uv` counts its calls, and a scratch UV_PYTHON_INSTALL_DIR holds a fake
// managed 3.14, so no real uv or Python is needed.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnless } = require('../lib/probe');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const LIB = srcPath('private_dot_claude', 'hooks', 'lib', 'guard-python.sh');
const RB = srcPath('private_dot_claude', 'hooks', 'lib', 'run-bounded.sh');
const skip = skipUnless('bash', 'timeout');

const ROOT = scratch(os.tmpdir(), 'guard-python-');
const MANAGED = path.join(ROOT, 'uv-python');
const PY = path.join(MANAGED, 'cpython-3.14-macos-aarch64-none', 'bin', 'python3.14');
fs.mkdirSync(path.dirname(PY), { recursive: true });
fs.writeFileSync(PY, '#!/bin/sh\n', { mode: 0o755 });
const BIN = path.join(ROOT, 'bin');
fs.mkdirSync(BIN);
const CALLS = path.join(ROOT, 'uv-calls');
// The stub answers with whatever UV_ANSWER names, so a test can make uv point off-tree.
fs.writeFileSync(path.join(BIN, 'uv'), `#!/bin/bash
echo x >> ${JSON.stringify(CALLS)}
printf '%s\\n' "\${UV_ANSWER}"
`, { mode: 0o755 });
const CACHE_HOME = path.join(ROOT, 'cache');
const CACHE = path.join(CACHE_HOME, 'claude-hooks', 'guard-python');

function lookup(env = {}) {
  const r = spawnSync('bash', ['-c', `. "${RB}"; . "${LIB}"; guard_python 2; echo "$?|$GUARD_PY|$GUARD_PY_STATUS"`], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${BIN}:${process.env.PATH}`, UV_PYTHON_INSTALL_DIR: MANAGED,
      XDG_CACHE_HOME: CACHE_HOME, UV_ANSWER: PY, ...env,
    },
  });
  const calls = fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).length : 0;
  const [rc, py, status] = r.stdout.trim().split('|');
  return { rc: Number(rc), py, status, calls };
}

function reset() {
  fs.rmSync(CALLS, { force: true });
  fs.rmSync(CACHE_HOME, { recursive: true, force: true });
}

test('a managed 3.14 is looked up once, then read from the cache', { skip }, () => {
  reset();
  assert.deepStrictEqual(lookup(), { rc: 0, py: PY, status: 'ok', calls: 1 });
  assert.deepStrictEqual(lookup(), { rc: 0, py: PY, status: 'ok', calls: 1 });
});

test('a cache naming anything outside the managed install is ignored and replaced', { skip }, () => {
  const forged = path.join(ROOT, 'evil', 'cpython-3.14-x', 'bin', 'python3.14');
  fs.mkdirSync(path.dirname(forged), { recursive: true });
  fs.writeFileSync(forged, '#!/bin/sh\n', { mode: 0o755 });
  const nested = path.join(MANAGED, 'cpython-3.14-x', 'extra', 'bin', 'python3.14');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, '#!/bin/sh\n', { mode: 0o755 });
  for (const bad of [forged, `${MANAGED}/cpython-3.14-x/../../evil/cpython-3.14-x/bin/python3.14`, nested]) {
    reset();
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, `${bad}\n`);
    assert.deepStrictEqual(lookup(), { rc: 0, py: PY, status: 'ok', calls: 1 }, bad);
    assert.strictEqual(fs.readFileSync(CACHE, 'utf8'), `${PY}\n`);
  }
});

test('an interpreter uv finds off the managed tree is used but never cached', { skip }, () => {
  reset();
  assert.deepStrictEqual(lookup({ UV_ANSWER: '/bin/sh' }), { rc: 0, py: '/bin/sh', status: 'ok', calls: 1 });
  assert.ok(!fs.existsSync(CACHE));
});

test('uv answering with nothing usable is `none`, not a lookup that failed to finish', { skip }, () => {
  reset();
  assert.deepStrictEqual(lookup({ UV_ANSWER: '' }), { rc: 1, py: '', status: 'none', calls: 1 });
});
