// lib/run-python.sh: every Python hook starts under the managed 3.14 the claude_guard shims
// resolve, with -S -P, and under python3 only when there is none. Stub `uv` and stub
// interpreters print how they were started, so no real uv or Python is needed.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnless } = require('../lib/probe');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const LAUNCHER = srcPath('private_dot_claude', 'hooks', 'lib', 'run-python.sh');
const skip = skipUnless('bash', 'timeout');

const ROOT = scratch(os.tmpdir(), 'run-python-');
const MANAGED = path.join(ROOT, 'uv-python');
const PY = path.join(MANAGED, 'cpython-3.14-macos-aarch64-none', 'bin', 'python3.14');
fs.mkdirSync(path.dirname(PY), { recursive: true });
fs.writeFileSync(PY, '#!/bin/sh\necho "managed $*"\n', { mode: 0o755 });
const BIN = path.join(ROOT, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'uv'), '#!/bin/sh\n[ -n "$UV_ANSWER" ] && echo "$UV_ANSWER"\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'python3'), '#!/bin/sh\necho "python3 $*"\n', { mode: 0o755 });

function launch(env) {
  return spawnSync('bash', [LAUNCHER, '/hooks/stop-checks.py', '--prune'], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${BIN}:${process.env.PATH}`, UV_PYTHON_INSTALL_DIR: MANAGED,
      GUARD_PYTHON_CACHE: '0', ...env,
    },
  });
}

test('a hook runs under the managed 3.14 with -S -P and its own arguments', { skip }, () => {
  const r = launch({ UV_ANSWER: PY });
  assert.strictEqual(r.stdout.trim(), 'managed -S -P /hooks/stop-checks.py --prune');
  assert.strictEqual(r.stderr, '');
});

test('a hook named without a path resolves in the hooks directory', { skip }, () => {
  const r = spawnSync('bash', [LAUNCHER, 'stop-checks.py'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, UV_PYTHON_INSTALL_DIR: MANAGED, GUARD_PYTHON_CACHE: '0', UV_ANSWER: PY },
  });
  assert.strictEqual(r.stdout.trim(), `managed -S -P ${path.dirname(LAUNCHER)}/../stop-checks.py`);
});

test('with no managed 3.14 the hook still runs, under python3, and says so', { skip }, () => {
  const r = launch({ UV_ANSWER: '' });
  assert.strictEqual(r.stdout.trim(), 'python3 /hooks/stop-checks.py --prune');
  assert.match(r.stderr, /no uv-managed Python 3\.14, so \/hooks\/stop-checks\.py runs under python3/);
});

test('every registered Python hook starts through run-python.sh', () => {
  // The launcher only helps a hook that names it. #941 switched the four Python hooks it
  // knew about by hand, and skill-usage-log.py, which landed beside it, kept the bare
  // `#!/usr/bin/env python3` registration. That runs under whatever python3 the session's
  // PATH resolves, a project venv included. A census catches the next one.
  const dir = path.dirname(path.dirname(LAUNCHER));
  const hooks = fs.readdirSync(dir).filter((f) => /^executable_.*\.py$/.test(f));
  const registered = hooks.filter((f) => /^# gen-hooks: register$/m.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(registered.length >= 5, `expected the repo's Python hooks, found ${registered.length}`);
  const missing = registered.filter((f) => {
    const name = f.replace(/^executable_/, '');
    const header = fs.readFileSync(path.join(dir, f), 'utf8');
    return !new RegExp(`^#   command: bash ~/\\.claude/hooks/lib/run-python\\.sh ${name.replace('.', '\\.')}( |$)`, 'm').test(header);
  });
  assert.deepStrictEqual(missing, [], 'these Python hooks do not declare `command: bash ~/.claude/hooks/lib/run-python.sh <hook>`');
});
