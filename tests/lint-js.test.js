// The JavaScript gate has three ways to become a no-op without anyone noticing, and each one
// is a silent pass rather than a visible break. This file pins all three:
//
//   1. oxlint reports the default correctness rules at WARNING severity and exits 0 on
//      warnings, so without --deny-warnings the hook prints findings and passes.
//   2. oxlint selects files by extension and refuses anything else, so the
//      `#!/usr/bin/env node` scripts with no extension — including bin/config-soak, itself a
//      push gate — are only reached through the temp-copy path in bin/lint-js.
//   3. prek reaches one of those scripts only if the hook's `files:` names it. That list is
//      rendered by bin/gen-lint-files from the tree's shebangs, and the last test asserts
//      the rendered pattern admits every node script that census reports. (The +x bit the
//      shebang typing also needs is tests/lint-gate-coverage.test.js's, over the same census.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { scratch } = require('./lib/tmp');
const { repoPath } = require('./lib/paths');

const SCRIPT = repoPath('bin', 'lint-js');
const CONFIG = repoPath('.oxlintrc.json');
const scriptText = fs.readFileSync(SCRIPT, 'utf8');
const hookConfig = fs.readFileSync(repoPath('.pre-commit-config.yaml'), 'utf8');

const haveOxlint = spawnSync('command', ['-v', 'oxlint'], { shell: true }).status === 0;
const skip = haveOxlint ? false : 'oxlint not installed';

function runLint(args) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: repoPath(), encoding: 'utf8' });
}

function fixture(name, body) {
  const dir = scratch(os.tmpdir(), 'lint-js-');
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test('warnings fail the gate rather than being printed and passed', { skip }, () => {
  const f = fixture('warn.js', 'const neverUsed = 1;\n');
  const r = runLint([f]);
  assert.strictEqual(r.status, 1, `expected a non-zero exit, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /no-unused-vars/);
});

test('--deny-warnings is passed on every oxlint invocation', { skip: false }, () => {
  // Belt and braces for the test above: that one would still pass if only the code path it
  // happens to exercise carried the flag.
  const calls = scriptText.match(/^\s*(out="\$\()?oxlint /gm) || [];
  const denied = scriptText.match(/oxlint --deny-warnings /g) || [];
  assert.ok(calls.length > 0, 'expected bin/lint-js to invoke oxlint');
  assert.strictEqual(denied.length, calls.length,
    'every oxlint invocation in bin/lint-js must pass --deny-warnings');
});

test('an extensionless node script is linted and reported at its real path', { skip }, () => {
  // oxlint on its own answers "No files found to lint" here and exits 1, which would read as
  // a failure that says nothing about the code.
  const f = fixture('some-tool', '#!/usr/bin/env node\nconst neverUsed = 1;\n');
  const r = runLint([f]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /some-tool:2:7/, 'findings must point at the original path, not the temp copy');
  // Assert the temp DIRECTORY is absent rather than that no ".js:" appears anywhere: a mixed
  // batch legitimately prints real .js paths, which is the normal case under --all-files.
  assert.doesNotMatch(r.stdout, /\/tmp\/tmp\./, 'the temp copy path must not survive into the output');
});

test('several mapped files in one batch each map back to their own path', { skip }, () => {
  // The rewrite loop runs once per mapped file over the whole output, so a batch is the case
  // where one substitution could clobber another's path. One-file tests cannot catch that.
  const a = fixture('tool-alpha', '#!/usr/bin/env node\nconst alpha = 1;\n');
  const b = fixture('tool-beta', '#!/usr/bin/env node\nconst beta = 1;\n');
  const r = runLint([a, b]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, new RegExp(`${a}:2:7`));
  assert.match(r.stdout, new RegExp(`${b}:2:7`));
  assert.doesNotMatch(r.stdout, /\/tmp\/tmp\./);
});

test('a clean file passes', { skip }, () => {
  const f = fixture('clean.js', 'module.exports = { ok: true };\n');
  assert.strictEqual(runLint([f]).status, 0);
});

test('the whole tracked JavaScript surface is clean', { skip }, () => {
  // No arguments means bin/lint-js derives the list itself, which is also the only path that
  // reaches files under dot-directories — oxlint's own directory walk skips them, exactly
  // like node --test's, so `oxlint <dir>` under-reports.
  const r = runLint([]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('.oxlintrc.json is valid and loaded by oxlint', { skip }, () => {
  assert.ok(fs.existsSync(CONFIG), 'the gate depends on this config existing');
  // A malformed config makes oxlint fail loudly, so a clean run over a file that only the
  // config's disabled rules would flag proves it parsed and applied.
  const f = fixture('control.js', 'const re = /\\x1b\\[[0-9;]*m/;\nmodule.exports = re;\n');
  assert.strictEqual(runLint([f]).status, 0, 'no-control-regex should be off per .oxlintrc.json');
});

test('the oxlint files: pattern admits every extensionless node script in the tree', { skip: false }, () => {
  // The property, not the spelling: whatever alternation bin/gen-lint-files renders, the
  // RegExp it becomes must accept every path the same census tags `node`. Asserting the
  // line's shape instead (a literal after `^(`) failed on a directory-grouped rendering and
  // pinned the generator to a flat one (#534). The marker is the anchor because
  // injectFilesPatterns() guarantees the files: line sits directly under it.
  const block = hookConfig.match(/# gen-lint-files: oxlint\n\s*files: (\(.*\))$/m);
  assert.ok(block, 'could not find the oxlint hook\'s files: pattern under its generator marker');
  const re = new RegExp(block[1]);

  // The census the generator itself renders from, spawned through node because the pre-push
  // gate's shell has no node on PATH for the shebang to resolve.
  const nodeScripts = execFileSync('node', [repoPath('bin', 'gen-lint-files'), '--list'], { cwd: repoPath(), encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '))
    .filter(([, kind]) => kind === 'node')
    .map(([, , file]) => file);
  // Non-vacuity: an empty census, or a renamed dialect tag, would make the loop below pass
  // over nothing. config-soak is itself a push gate; gen-lint-files renders this very line.
  for (const f of ['bin/config-soak', 'bin/gen-lint-files']) {
    assert.ok(nodeScripts.includes(f), `the census no longer reports ${f} as a node script`);
  }

  const missed = nodeScripts.filter((f) => !re.test(f));
  assert.deepStrictEqual(missed, [],
    'these are extensionless node scripts the oxlint hook\'s files: pattern does not admit, so '
    + 'the gate never sees them. Run bin/gen-lint-files and commit the result.');
});

test('the hook runs through bin/lint-js, not oxlint directly', { skip: false }, () => {
  assert.match(hookConfig, /entry: bin\/lint-js/,
    'a bare `entry: oxlint` cannot reach extensionless scripts and does not fail on warnings');
});
