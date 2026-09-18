const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');

const LIB = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox', 'executable_sandbox-lib.sh');

// sandbox-lib is sourced by the Unix-only sandbox scripts; it relies on POSIX bash.
const skip = process.platform === 'win32' ? 'sandbox-lib is Unix-only' : false;

// Source the lib and echo the result of resolve_repo_path "$1" under a given HOME.
function resolve(arg, home) {
  const r = spawnSync('bash', ['-c', `. "$1"; resolve_repo_path "$2"`, 'bash', LIB, arg],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return (r.stdout || '').trim();
}

const home = scratch(os.tmpdir(), 'sblib-');
fs.mkdirSync(path.join(home, 'Repositories', 'airflow'), { recursive: true });

test('bare name with a matching ~/Repositories dir -> expanded', { skip }, () => {
  assert.strictEqual(resolve('airflow', home), path.join(home, 'Repositories', 'airflow'));
});

test('bare name with no matching dir -> unchanged', { skip }, () => {
  assert.strictEqual(resolve('nope', home), 'nope');
});

test('absolute path -> unchanged (even if a same-named repo exists)', { skip }, () => {
  assert.strictEqual(resolve('/etc/airflow', home), '/etc/airflow');
});

test('relative paths -> unchanged', { skip }, () => {
  assert.strictEqual(resolve('./airflow', home), './airflow');
  assert.strictEqual(resolve('../airflow', home), '../airflow');
});
