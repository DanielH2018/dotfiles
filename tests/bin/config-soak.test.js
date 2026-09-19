'use strict';
// End-to-end pair for the config-soak scan. The lib tests beside this file are pure; this
// one runs the real binary against a staged git repo, because the property under test is
// the boundary between git and the working tree: a file on disk under a tracked directory
// that git does not track must not be fingerprinted (#547 — the python suites' __pycache__
// got landed into the ledger and every other checkout read it as REMOVED), while a tracked
// sibling still is. Staged in a temp dir rather than planted in this checkout, for the
// reason tests/lib/sandbox-escape.js gives.
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../lib/paths');

const HOOKS = 'home/private_dot_claude/hooks';

function stageRepo() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'config-soak-'));
  // Strip git's hook environment: under the pre-push hook GIT_DIR/GIT_INDEX_FILE point at
  // THIS repo, and a `git add` in the stage would otherwise land in the real index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd: stage, env, stdio: 'pipe' });
  git('init', '-q');
  fs.mkdirSync(path.join(stage, 'bin'));
  for (const f of ['config-soak', 'config-soak-lib.js']) {
    fs.copyFileSync(repoPath('bin', f), path.join(stage, 'bin', f));
  }
  fs.mkdirSync(path.join(stage, HOOKS, '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(stage, HOOKS, 'executable_tracked.sh'), '#!/bin/sh\n');
  git('add', '.');
  // Planted AFTER the add: on disk under a tracked directory, unknown to git.
  fs.writeFileSync(path.join(stage, HOOKS, '__pycache__', 'x.pyc'), 'not config\n');
  const list = spawnSync('node', [path.join(stage, 'bin', 'config-soak'), 'list'], { encoding: 'utf8', env });
  fs.rmSync(stage, { recursive: true, force: true });
  assert.strictEqual(list.status, 0, list.stdout + list.stderr);
  return list.stdout.split('\n').filter(Boolean);
}

test('list prints a tracked file under a tracked directory', () => {
  assert.ok(stageRepo().includes(`${HOOKS}/executable_tracked.sh`));
});

test('list omits an untracked file under a tracked directory', () => {
  assert.deepStrictEqual(stageRepo().filter((p) => p.includes('__pycache__')), []);
});
