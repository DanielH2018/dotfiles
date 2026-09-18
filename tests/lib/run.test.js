// tests/lib/run.js: a failing script's exit code and stderr come back as they are, and a
// script that cannot start does not read as one that ran.
const { test } = require('node:test');
const assert = require('node:assert');
const { run } = require('./run');

test('a failing script returns its non-zero code and its stderr, untouched', () => {
  const r = run('sh', ['-c', 'printf out; printf "bad thing\\n" >&2; exit 3']);
  assert.strictEqual(r.code, 3);
  assert.strictEqual(r.stdout, 'out');
  assert.strictEqual(r.stderr, 'bad thing\n');
  assert.strictEqual(r.signal, null);
});

test('a passing script keeps its stderr too', () => {
  const r = run('sh', ['-c', 'echo warn >&2; echo ok']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'ok\n');
  assert.strictEqual(r.stderr, 'warn\n');
});

test('input, cwd and env reach the child', () => {
  const r = run('sh', ['-c', 'read -r line; printf "%s|%s|%s" "$line" "$PWD" "$MARK"'],
    { input: 'fed\n', cwd: '/', env: { MARK: 'm', PATH: process.env.PATH } });
  assert.strictEqual(r.stdout, 'fed|/|m');
});

test('a command that cannot start throws instead of returning a code', () => {
  assert.throws(() => run('no-such-command-526-zz', []), /ENOENT/);
});
