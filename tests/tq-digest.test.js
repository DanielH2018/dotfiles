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
const { scratch } = require('./lib/tmp');

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

function staged(files) {
  const dir = scratch(os.tmpdir(), 'tq-e2e-');
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('python: tq adapters + digest unit tests', { skip }, () => {
  // Exit code alone cannot tell a green suite from an empty one: unittest exits 0 whether
  // it discovered every test or none. Same reasoning python-suites.test.js applies to the
  // sandbox suites — the guard just never reached the largest one. Capture rather than
  // pipe, because unittest writes its summary to stderr, which is why execFileSync (it
  // returns stdout) could not see the count.
  //
  // What this catches, both verified by mutation: a class that stops being collected —
  // drop the `unittest.TestCase` base off one and this reports "ran 215 of 219" — and a
  // whole module that stops being discovered, which since the suite was split per subject
  // is the same silent shortfall, only bigger (206 of 219 when one is renamed off the
  // glob). What it does NOT catch, also verified: renaming a method off its `test_`
  // prefix, which lowers the ran count and the declared count together. Guarding that
  // needs a floor, and a floor is a ratchet someone has to maintain.
  //
  // Not named `dir`: staged() below binds that to a mkdtemp path, and
  // sandbox-escape.test.js reads the two as one variable and calls the repo path a write
  // target.
  const suiteDir = path.join(__dirname, 'tq');
  const r = spawnSync('python3', [path.join(suiteDir, 'run.py')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `tq unit tests failed:\n${r.stderr}`);

  const ran = /^Ran (\d+) tests?/m.exec(r.stderr);
  assert.ok(ran, `no "Ran N tests" line in unittest output:\n${r.stderr}`);

  const discovered = fs.readdirSync(suiteDir).filter((f) => /^test_.*\.py$/.test(f));
  assert.ok(discovered.length > 1, `expected several test modules, found ${discovered.length}`);

  // Declared is counted over every .py here, not just the ones run.py's `test_*.py` glob
  // discovers. Counting only the glob would let a module renamed off it drop out of both
  // numbers at once and stay silent — the split's own version of the collection bug this
  // guard exists to catch. helpers.py and run.py contribute nothing, and a test that ends
  // up in one of them is a real shortfall worth failing on.
  //
  // Every test here is a method on a TestCase, so an indented `def test_` is exactly what
  // unittest collects; there are no module-level ones to confuse it (verified: 0).
  const declared = fs.readdirSync(suiteDir).filter((f) => f.endsWith('.py')).reduce((n, f) =>
    n + (fs.readFileSync(path.join(suiteDir, f), 'utf8').match(/^\s+def test_/gm) || []).length, 0);
  assert.strictEqual(Number(ran[1]), declared,
    `unittest ran ${ran[1]} of ${declared} declared tests — the suite is being collected incompletely`);
});

test('passing run digests to a single line and exit 0', { skip }, () => {
  const dir = staged({
    'ok.test.js': "const {test}=require('node:test');test('a',()=>{});test('b',()=>{});\n",
  });
  const r = runTq(dir, ['node', '--test', 'ok.test.js']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout.trim(), /^PASS 2\/2 {2}\d+\.\d+s$/);
});

test('failing run keeps exit 1 and names the failing assertion', { skip }, () => {
  const dir = staged({
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
  const dir = staged({});
  const r = runTq(dir, ['node', '--test', '--no-such-flag']);
  assert.notStrictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /^PASS/);
  assert.match(r.stdout + r.stderr, /no-such-flag/);
});

test('the structured result lands on disk with the documented shape', { skip }, () => {
  const dir = staged({
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
  const dir = staged({
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
  const dir = staged({
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
  const dir = staged({ 'bad.py': 'import os\n' });
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
  const dir = staged({ 'ok.py': 'x = 1\nprint(x)\n' });
  const r = runTq(dir, ['ruff', 'check', 'ok.py']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), r.stdout.trim().match(/^CLEAN {2}\d+\.\d+s$/)?.[0]);
});

test('ruff over a tree holding no python says so instead of passing', { skip: skipRuff }, () => {
  // exit 0 and an empty report, identical to a clean run by exit code alone —
  // the whole reason a lint digest cannot just print PASS.
  const dir = staged({ 'notes.txt': 'nothing to lint\n' });
  const r = runTq(dir, ['ruff', 'check', '.']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^CLEAN {2}\d+\.\d+s$/m);
  assert.match(r.stdout, /^note: .*No Python files found/m);
});

test('shellcheck findings carry severity, code and line', { skip: skipShellcheck }, () => {
  const dir = staged({ 'bad.sh': '#!/bin/bash\necho $undefined\n' });
  const r = runTq(dir, ['shellcheck', 'bad.sh']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^FAIL \d+ findings in 1 file {2}\d+\.\d+s$/m);
  // Column and severity come from json1 and used to be thrown away: the
  // location was line-only and the level was glued onto the message text.
  assert.match(r.stdout, /^bad\.sh:2:\d+ {2}SC\d+ {2}(warning|info)$/m);
});

test('a linter that cannot read its input never reads as clean', { skip: skipShellcheck }, () => {
  const dir = staged({});
  const r = runTq(dir, ['shellcheck', 'no-such-file.sh']);
  assert.notStrictEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /CLEAN/);
  assert.match(r.stdout, /^NO FINDINGS PARSED/m);
});

test('a command that merely names a runner is left alone', { skip }, () => {
  // `grep pytest ...` is not a test run; treating it as one would splice
  // reporter flags into the grep.
  const dir = staged({ 'notes.txt': 'remember to run pytest\n' });
  const r = runTq(dir, ['grep', '-c', 'pytest', 'notes.txt']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '1\n');
});

test('an unrecognised command runs untouched', { skip }, () => {
  const r = spawnSync('python3', [TQ, 'bash', '-c', 'echo hello; exit 7'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 7);
  assert.strictEqual(r.stdout, 'hello\n');
});

