// bin/gen-lint-files renders the lint hooks' extensionless-script lists from the tree's
// shebangs. Before it, those were three hand lists in .pre-commit-config.yaml and a fourth
// in pyproject.toml that had drifted to 1 name of 11 (#525). The lib tests below pin the
// two properties that matter — the rendered `files:` stays a WIDENER, and a stale list fails
// --check — and the end-to-end pair runs the real binary green against the committed tree
// and red against a staged tree with one script more.
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../bin/gen-lint-files-lib.js');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'gen-lint-files');

// --- lib.census ---------------------------------------------------------------------------

test('census tags an extensionless script by its shebang and ignores a dotted basename', () => {
  const found = lib.census([
    { mode: '100755', file: 'bin/tool', firstLine: '#!/usr/bin/env python3' },
    { mode: '100644', file: 'bin/other', firstLine: '#!/bin/sh' },
    { mode: '100755', file: 'bin/js-tool', firstLine: '#!/usr/bin/env node' },
    { mode: '100755', file: 'bin/tool.py', firstLine: '#!/usr/bin/env python3' },
    { mode: '100644', file: 'README', firstLine: '# prose' },
  ]);
  assert.deepStrictEqual(found, [
    { mode: '100755', file: 'bin/js-tool', kind: 'node' },
    { mode: '100644', file: 'bin/other', kind: 'shell' },
    { mode: '100755', file: 'bin/tool', kind: 'python' },
  ]);
});

// --- lib.renderPatterns: the widener property ---------------------------------------------

const SCRIPTS = [
  { mode: '100755', file: 'bin/py-tool', kind: 'python' },
  { mode: '100755', file: 'bin/js-tool', kind: 'node' },
  { mode: '100755', file: 'home/dot_local/bin/executable_sh-tool', kind: 'shell' },
];

test('renderPatterns admits the named script AND every file the extension types', () => {
  const p = lib.renderPatterns(SCRIPTS);
  const ruff = new RegExp(p['ruff-check']);
  assert.ok(ruff.test('bin/py-tool'));
  assert.ok(ruff.test('quality/never_listed.py'), 'the pattern must stay a widener, not an allowlist');
  assert.ok(!ruff.test('bin/js-tool'), 'a node script is not ruff\'s');
  const ox = new RegExp(p.oxlint);
  assert.ok(ox.test('bin/js-tool'));
  assert.ok(ox.test('tests/never_listed.test.js'));
  assert.ok(!ox.test('bin/py-tool'));
  const bsd = new RegExp(p['bsd-portability']);
  assert.ok(bsd.test('home/dot_local/bin/executable_sh-tool'));
  assert.ok(bsd.test('bin/js-tool'), 'bsd-portability scans node scripts too');
  assert.ok(bsd.test('home/dot_bashrc'), 'the sourced rc files carry no shebang and are named by constant');
  assert.ok(!bsd.test('bin/py-tool'));
});

test('renderPatterns drops a BACKLOG entry and rejects a stale one', () => {
  lib.BACKLOG['ruff-check'].push('bin/py-tool');
  try {
    const p = lib.renderPatterns(SCRIPTS);
    assert.ok(!new RegExp(p['ruff-check']).test('bin/py-tool'));
    assert.doesNotMatch(lib.renderRuffToml(SCRIPTS), /py-tool/);
  } finally {
    lib.BACKLOG['ruff-check'].pop();
  }
  lib.BACKLOG['ruff-check'].push('bin/renamed-away');
  try {
    assert.throws(() => lib.renderPatterns(SCRIPTS), /renamed-away.*not an extensionless/);
  } finally {
    lib.BACKLOG['ruff-check'].pop();
  }
});

test('renderRuffToml lists the python scripts and extends pyproject.toml', () => {
  const toml = lib.renderRuffToml(SCRIPTS);
  assert.match(toml, /^extend = "pyproject.toml"$/m);
  assert.match(toml, /"bin\/py-tool",/);
  assert.doesNotMatch(toml, /js-tool|sh-tool/);
});

// --- lib.injectFilesPatterns ---------------------------------------------------------------

test('injectFilesPatterns rewrites only the files: line under each marker', () => {
  const cfg = '  - id: ruff-check\n    # gen-lint-files: ruff-check\n    files: stale\n  - id: other\n    files: keep\n';
  const out = lib.injectFilesPatterns(cfg, { 'ruff-check': '(fresh)' });
  assert.strictEqual(out, '  - id: ruff-check\n    # gen-lint-files: ruff-check\n    files: (fresh)\n  - id: other\n    files: keep\n');
});

test('injectFilesPatterns throws when a hook has no marker', () => {
  assert.throws(() => lib.injectFilesPatterns('  - id: ruff-check\n    files: x\n', { 'ruff-check': '(y)' }),
    /no '# gen-lint-files: <id>' marker for hook\(s\) ruff-check/);
});

// --- End-to-end: the real tree, then a staged tree one script ahead of its lists ---------

test('gen-lint-files --check passes against the committed tree right now', () => {
  const out = execFileSync('node', [BIN, '--check'], { encoding: 'utf8' });
  assert.match(out, /\.pre-commit-config\.yaml is up to date/);
  assert.match(out, /ruff\.toml is up to date/);
});

test('gen-lint-files --check fails when the tree gains a script the lists do not name', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-lint-files-'));
  // Strip git's hook environment: under the pre-push hook GIT_DIR/GIT_INDEX_FILE point at
  // THIS repo, and a `git add` in the stage would otherwise land in the real index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd: stage, env, stdio: 'pipe' });
  git('init', '-q');
  fs.mkdirSync(path.join(stage, 'bin'));
  for (const f of ['gen-lint-files', 'gen-lint-files-lib.js']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'bin', f), path.join(stage, 'bin', f));
  }
  fs.copyFileSync(path.join(REPO_ROOT, '.pre-commit-config.yaml'), path.join(stage, '.pre-commit-config.yaml'));
  fs.copyFileSync(path.join(REPO_ROOT, 'ruff.toml'), path.join(stage, 'ruff.toml'));
  fs.writeFileSync(path.join(stage, 'bin', 'brand-new'), '#!/usr/bin/env python3\nprint(1)\n');
  git('add', '.');
  git('update-index', '--chmod=+x', 'bin/brand-new', 'bin/gen-lint-files');

  const r = spawnSync('node', [path.join(stage, 'bin', 'gen-lint-files'), '--check'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /\.pre-commit-config\.yaml is out of date/);
  assert.match(r.stderr, /brand-new/);

  fs.rmSync(stage, { recursive: true, force: true });
});
