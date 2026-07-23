const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'executable_sandbox-lib.sh');

// sandbox-lib is sourced by the Unix-only sandbox scripts; it relies on POSIX bash.
if (process.platform === 'win32') { console.log('SKIP: sandbox-lib is Unix-only'); process.exit(0); }

// Source the lib and echo the result of resolve_repo_path "$1" under a given HOME.
function resolve(arg, home) {
  const r = spawnSync('bash', ['-c', `. "$1"; resolve_repo_path "$2"`, 'bash', LIB, arg],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return (r.stdout || '').trim();
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sblib-'));
fs.mkdirSync(path.join(home, 'Repositories', 'airflow'), { recursive: true });

// bare name with a matching ~/Repositories dir -> expanded
assert.strictEqual(resolve('airflow', home), path.join(home, 'Repositories', 'airflow'));
// bare name with no matching dir -> unchanged
assert.strictEqual(resolve('nope', home), 'nope');
// absolute path -> unchanged (even if a same-named repo exists)
assert.strictEqual(resolve('/etc/airflow', home), '/etc/airflow');
// relative paths -> unchanged
assert.strictEqual(resolve('./airflow', home), './airflow');
assert.strictEqual(resolve('../airflow', home), '../airflow');

fs.rmSync(home, { recursive: true, force: true });
console.log('sandbox-lib: all pass');
