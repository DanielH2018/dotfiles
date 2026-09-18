// The JavaScript gate has three ways to become a no-op without anyone noticing, and each one
// is a silent pass rather than a visible break. This file pins all three:
//
//   1. oxlint reports the default correctness rules at WARNING severity and exits 0 on
//      warnings, so without --deny-warnings the hook prints findings and passes.
//   2. oxlint selects files by extension and refuses anything else, so the five
//      `#!/usr/bin/env node` scripts with no extension — including bin/config-soak, itself a
//      push gate — are only reached through the temp-copy path in bin/lint-js.
//   3. prek types those same scripts by shebang ONLY if they are executable in git. Four of
//      them sat at 100644, which is easy to reintroduce because chezmoi's `executable_`
//      prefix sets the DEPLOYED mode and a 100644 source still deploys 0755.
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

test('every extensionless script the hook names is executable in git', { skip: false }, () => {
  // The +x bit is what lets prek type these by shebang. Losing it silently drops the file
  // from the gate while everything still looks wired.
  const named = [...hookConfig.matchAll(/\^\(?(bin\/config-soak|home\/dot_local\/bin\/executable_[a-z-]+)/g)]
    .map((m) => m[1]);
  const entry = hookConfig.match(/files: \(\\\.\(js\|mjs\)\$\|(.+)\)$/m);
  assert.ok(entry, 'could not find the oxlint hook files: pattern');

  const scripts = execFileSync('git', ['ls-files', '-s', 'bin/config-soak', 'home/dot_local/bin/'], { cwd: repoPath() })
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      return { mode: meta.split(' ')[0], file };
    })
    .filter((e) => !path.basename(e.file).includes('.'))
    .filter((e) => fs.readFileSync(repoPath(e.file), 'utf8').startsWith('#!/usr/bin/env node'));

  assert.ok(scripts.length >= 5, `expected the extensionless node scripts, saw ${scripts.length}`);
  for (const { mode, file } of scripts) {
    assert.strictEqual(mode, '100755',
      `${file} is a node script with no extension, so prek can only type it by shebang — that needs the +x bit in git (git update-index --chmod=+x ${file})`);
  }
  assert.ok(named.length > 0, 'the hook should name the extensionless scripts explicitly');
});

test('the hook runs through bin/lint-js, not oxlint directly', { skip: false }, () => {
  assert.match(hookConfig, /entry: bin\/lint-js/,
    'a bare `entry: oxlint` cannot reach extensionless scripts and does not fail on warnings');
});
