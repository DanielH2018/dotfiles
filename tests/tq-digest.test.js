// Wires the tq adapter/digest unit tests into `node --test`, then exercises the
// CLI end to end: the digest is only worth anything if the exit code it hands
// back still matches what the runner actually said.
//
// The unit tests are stdlib unittest, not pytest — this repo stays
// dependency-free, and pytest only exists inside ~/dev/server's venv.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let python3Ok = true;
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch { python3Ok = false; }
const skip = python3Ok ? false : 'python3 unavailable';

function needs(binary) {
  if (!python3Ok) return skip;
  try { execFileSync(binary, ['--version'], { stdio: 'ignore' }); } catch { return `${binary} unavailable`; }
  return false;
}
const skipRuff = needs('ruff');
const skipShellcheck = needs('shellcheck');

const TQ = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_tq');

function runTq(dir, args) {
  return spawnSync('python3', [TQ, ...args], { cwd: dir, encoding: 'utf8' });
}

const dirs = [];
function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-e2e-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('python: tq adapters + digest unit tests', { skip }, () => {
  execFileSync('python3', [path.join(__dirname, 'tq', 'test_tq.py')], { stdio: 'pipe' });
});

test('passing run digests to a single line and exit 0', { skip }, () => {
  const dir = scratch({
    'ok.test.js': "const {test}=require('node:test');test('a',()=>{});test('b',()=>{});\n",
  });
  const r = runTq(dir, ['node', '--test', 'ok.test.js']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout.trim(), /^PASS 2\/2 {2}\d+\.\d+s$/);
});

test('failing run keeps exit 1 and names the failing assertion', { skip }, () => {
  const dir = scratch({
    'bad.test.js':
      "const {test}=require('node:test');const assert=require('node:assert');\n" +
      "test('compares',()=>{assert.strictEqual('a','b','boom mismatch');});\n",
  });
  const r = runTq(dir, ['node', '--test', 'bad.test.js']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^FAIL 1\/1 /);
  assert.match(r.stdout, /bad\.test\.js:2 {2}compares/);
  assert.match(r.stdout, /boom mismatch/);
  assert.match(r.stdout, /^json: \S+\.json$/m);
});

test('a runner that crashes before reporting never reads as a pass', { skip }, () => {
  // The failure mode that would make tq actively dangerous: exit 1 with a
  // digest claiming everything passed.
  const dir = scratch({});
  const r = runTq(dir, ['node', '--test', '--no-such-flag']);
  assert.notStrictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /^PASS/);
  assert.match(r.stdout + r.stderr, /no-such-flag/);
});

test('the structured result lands on disk with the documented shape', { skip }, () => {
  const dir = scratch({
    'bad.test.js':
      "const {test}=require('node:test');const assert=require('node:assert');\n" +
      "test('compares',()=>{assert.strictEqual(1,2);});\n",
  });
  const target = path.join(dir, 'result.json');
  const r = spawnSync('python3', [TQ, 'node', '--test', 'bad.test.js'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, TQ_JSON: target },
  });
  assert.strictEqual(r.status, 1);
  const payload = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(payload.runner, 'node');
  assert.strictEqual(payload.exit, 1);
  assert.strictEqual(payload.totals.tests, 1);
  assert.strictEqual(payload.totals.fail, 1);
  assert.strictEqual(payload.failures.length, 1);
  assert.match(payload.failures[0].file, /bad\.test\.js$/);
});

test('a leaked node test context cannot fake a clean run', { skip }, () => {
  // Inherited from an outer `node --test`, NODE_TEST_CONTEXT makes the nested
  // runner collect nothing and exit 0 — a false pass with no failure to notice.
  const dir = scratch({
    'bad.test.js':
      "const {test}=require('node:test');const assert=require('node:assert');\n" +
      "test('compares',()=>{assert.strictEqual(1,2);});\n",
  });
  const r = spawnSync('python3', [TQ, 'node', '--test', 'bad.test.js'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^FAIL 1\/1 /);
});

test('TQ_JSON does not follow tq into the runner it spawns', { skip }, () => {
  // tq has consumed TQ_JSON before the runner starts, so a child inheriting it
  // can only do harm: a nested tq — which this very suite spawns — would write
  // its own record over the outer run's. The pre-push gate pins TQ_JSON to a
  // `git rev-parse --git-path` value, relative in the main checkout, and the
  // nested run resolved it against its own cwd and died on the missing
  // directory, printing a traceback where the digest should have been.
  const dir = scratch({
    'env.test.js':
      "const {test}=require('node:test');const fs=require('node:fs');\n" +
      "test('records what it inherited',()=>{\n" +
      "  fs.writeFileSync('seen.txt', String(process.env.TQ_JSON));\n" +
      '});\n',
  });
  const target = path.join(dir, 'outer.json');
  const r = spawnSync('python3', [TQ, 'node', '--test', 'env.test.js'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, TQ_JSON: target },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'seen.txt'), 'utf8'), 'undefined');
  // The outer run still honours its own TQ_JSON — dropping it for the child
  // must not mean dropping it for tq itself.
  assert.ok(fs.existsSync(target));
});

test('ruff findings digest to a rule code at a real location', { skip: skipRuff }, () => {
  const dir = scratch({ 'bad.py': 'import os\n' });
  const r = runTq(dir, ['ruff', 'check', 'bad.py']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^FAIL 1 finding in 1 file {2}\d+\.\d+s$/m);
  // The location has to survive: ruff states it in attributes, and its
  // @classname has the .py stripped off.
  // The rule code now arrives as itself rather than as "org.ruff.F401" dug
  // out of a JUnit classname, and the column survives with it.
  assert.match(r.stdout, /^bad\.py:1:\d+ {2}F401$/m);
  assert.doesNotMatch(r.stdout, /org\.ruff/);
});

test('a clean ruff run is one line', { skip: skipRuff }, () => {
  const dir = scratch({ 'ok.py': 'x = 1\nprint(x)\n' });
  const r = runTq(dir, ['ruff', 'check', 'ok.py']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), r.stdout.trim().match(/^CLEAN {2}\d+\.\d+s$/)?.[0]);
});

test('ruff over a tree holding no python says so instead of passing', { skip: skipRuff }, () => {
  // exit 0 and an empty report, identical to a clean run by exit code alone —
  // the whole reason a lint digest cannot just print PASS.
  const dir = scratch({ 'notes.txt': 'nothing to lint\n' });
  const r = runTq(dir, ['ruff', 'check', '.']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^CLEAN {2}\d+\.\d+s$/m);
  assert.match(r.stdout, /^note: .*No Python files found/m);
});

test('shellcheck findings carry severity, code and line', { skip: skipShellcheck }, () => {
  const dir = scratch({ 'bad.sh': '#!/bin/bash\necho $undefined\n' });
  const r = runTq(dir, ['shellcheck', 'bad.sh']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^FAIL \d+ findings in 1 file {2}\d+\.\d+s$/m);
  // Column and severity come from json1 and used to be thrown away: the
  // location was line-only and the level was glued onto the message text.
  assert.match(r.stdout, /^bad\.sh:2:\d+ {2}SC\d+ {2}(warning|info)$/m);
});

test('a linter that cannot read its input never reads as clean', { skip: skipShellcheck }, () => {
  const dir = scratch({});
  const r = runTq(dir, ['shellcheck', 'no-such-file.sh']);
  assert.notStrictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /CLEAN/);
  assert.match(r.stdout, /^NO FINDINGS PARSED/m);
});

test('a command that merely names a runner is left alone', { skip }, () => {
  // `grep pytest ...` is not a test run; treating it as one would splice
  // reporter flags into the grep.
  const dir = scratch({ 'notes.txt': 'remember to run pytest\n' });
  const r = runTq(dir, ['grep', '-c', 'pytest', 'notes.txt']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '1\n');
});

test('an unrecognised command runs untouched', { skip }, () => {
  const r = spawnSync('python3', [TQ, 'bash', '-c', 'echo hello; exit 7'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 7);
  assert.strictEqual(r.stdout, 'hello\n');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
