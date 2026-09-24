// tests/lib/tmp.js: the directory exists for the caller and is gone afterwards, on both paths.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratch, hardenedCopy } = require('./tmp');

const LIB = path.join(__dirname, 'tmp.js');

// node runs a file's tests in order, so a later test can look for what an earlier one made.
let perTest;

test('makes a fresh directory under the root, carrying the prefix', (t) => {
  perTest = scratch(os.tmpdir(), 'tmp-lib-', t);
  assert.ok(fs.statSync(perTest).isDirectory());
  assert.strictEqual(path.dirname(perTest), os.tmpdir());
  assert.ok(path.basename(perTest).startsWith('tmp-lib-'));
  assert.notStrictEqual(scratch(os.tmpdir(), 'tmp-lib-', t), perTest, 'two calls, two directories');
});

test('with a test context, the directory is removed when that test ends', () => {
  assert.ok(!fs.existsSync(perTest), `${perTest} should have been removed by t.after()`);
});

test('without a test context, the directory lives until the process exits', () => {
  // The child proves the dir was there right up to exit, so its absence afterwards is the
  // exit hook's doing and not a mkdtemp that never happened.
  const out = execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs'); const os = require('node:os');
    const { scratch } = require(${JSON.stringify(LIB)});
    // Registered before the helper installs its own hook, so it reports from before removal.
    let d;
    process.on('exit', () => process.stdout.write(d + ' ' + fs.existsSync(d) + '\\n'));
    d = scratch(os.tmpdir(), 'tmp-lib-exit-');
  `], { encoding: 'utf8' });
  const [dir, existedAtExit] = out.trim().split(' ');
  assert.strictEqual(existedAtExit, 'true');
  assert.ok(!fs.existsSync(dir), `${dir} should have been removed at exit`);
});

test('a directory rooted in another scratch dir goes with its parent', (t) => {
  const parent = scratch(os.tmpdir(), 'tmp-lib-parent-', t);
  const child = scratch(parent, 'child-');
  assert.strictEqual(path.dirname(child), parent);
});

// hardenedCopy: #637. A .venv's bin/python links OUT of the tree to the shared uv
// interpreter, and chmod through that link set the interpreter to 644 for the whole host.
test('hardenedCopy hardens the copy and leaves what a symlink points at alone', (t) => {
  const root = scratch(os.tmpdir(), 'tmp-lib-harden-', t);
  const outside = path.join(root, 'interpreter');
  fs.writeFileSync(outside, '#!/bin/sh\n');
  fs.chmodSync(outside, 0o755);
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(src, 'pkg', 'mod.py'), '');
  fs.chmodSync(path.join(src, 'pkg', 'mod.py'), 0o664);
  fs.symlinkSync(outside, path.join(src, 'python'));
  fs.mkdirSync(path.join(src, '.venv', 'bin'), { recursive: true });
  fs.symlinkSync(outside, path.join(src, '.venv', 'bin', 'python3'));

  const dir = hardenedCopy(scratch(root, 'copy-'), src);

  assert.strictEqual(fs.statSync(outside).mode & 0o777, 0o755, 'the link target kept its mode');
  assert.strictEqual(fs.statSync(path.join(dir, 'pkg', 'mod.py')).mode & 0o777, 0o644);
  assert.ok(fs.lstatSync(path.join(dir, 'python')).isSymbolicLink(), 'a link is copied as a link');
  assert.ok(!fs.existsSync(path.join(dir, '.venv')), '.venv is not copied');
});
