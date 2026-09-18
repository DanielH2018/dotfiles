// tests/lib/tmp.js: the directory exists for the caller and is gone afterwards, on both paths.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scratch } = require('./tmp');

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
