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

// A child that exits without reading its stdin makes node's write of `input` fail with
// EPIPE, while spawnSync still reports the child's real exit (#668). The child ran, so its
// status is the answer. 1 MiB is far past the pipe buffer, so the write is still in flight
// when the child exits.
const MIB = 'x'.repeat(1024 * 1024);

test('a child that exits without reading a large input returns its status', () => {
  const r = run('sh', ['-c', 'exit 7'], { input: MIB });
  assert.strictEqual(r.code, 7);
  assert.strictEqual(r.signal, null);
});

test('a command that cannot start still throws when it is handed input', () => {
  assert.throws(() => run('no-such-command-668-zz', [], { input: MIB }), /ENOENT/);
});
