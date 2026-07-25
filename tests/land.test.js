// Regression guard for bin/land.
// Only the refusals and --dry-run are exercised: everything past the lock
// force-pushes and merges, which a test has no business doing. That is the half
// worth pinning anyway — land is the one tool here allowed to rewrite a remote
// branch, so each guard that stops it doing so on the wrong branch, a dirty tree,
// or a half-finished rebase is the safety property. Skips without bash/git.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LAND = path.join(__dirname, '..', 'bin', 'land');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v git'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/git unavailable';

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

// Stub gh: reports an open PR only when STUB_PR is set, and records any call
// that would change something so the tests can prove --dry-run made none.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'land-bin-'));
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' "\${STUB_PR:-}"; exit 0; fi
echo "gh $*" >> "$STUB_GH_CALLS"
exit 0
`, { mode: 0o755 });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'f'), 'y\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  return dir;
}

function land(cwd, args = [], { pr = '7' } = {}) {
  const calls = path.join(cwd, '.gh-calls');
  try {
    const stdout = execFileSync('bash', [LAND, ...args], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...CLEAN_ENV, PATH: `${BIN}:${CLEAN_ENV.PATH}`, STUB_PR: pr, STUB_GH_CALLS: calls },
    });
    return { code: 0, stdout, stderr: '', calls };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '', calls };
  }
}

test('refuses to land the integration branch', { skip }, () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', 'main');
  const r = land(repo);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /refusing to land main/);
});

test('refuses a branch that is not checked out here', { skip }, () => {
  const repo = makeRepo();
  const r = land(repo, ['other']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /not checked out here/);
});

test('refuses a dirty worktree, because the rebase needs it clean', { skip }, () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'f'), 'dirty\n');
  const r = land(repo);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /dirty/);
});

test('refuses when there is no open PR to be the record', { skip }, () => {
  const repo = makeRepo();
  const r = land(repo, [], { pr: '' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no open PR/);
});

test('refuses mid-rebase rather than guessing', { skip }, () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.git', 'rebase-merge'), { recursive: true });
  const r = land(repo);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /rebase is in progress/);
});

test('--dry-run prints the plan and changes nothing', { skip }, () => {
  const repo = makeRepo();
  const before = git(repo, 'rev-parse', 'HEAD');

  const r = land(repo, ['--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /PR #7/);
  assert.match(r.stdout, /force-with-lease/);
  assert.match(r.stdout, /gh pr merge 7 --rebase --delete-branch/);

  assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), before, 'HEAD moved');
  assert.ok(!fs.existsSync(r.calls), 'no state-changing gh call was made');
});

test('rejects an unknown flag rather than guessing', { skip }, () => {
  const repo = makeRepo();
  const r = land(repo, ['--force']);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /unknown flag/);
});

test('the plan names a lock shared by every worktree of the repo', { skip }, () => {
  const repo = makeRepo();
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'land-wt-')), 'w');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  fs.writeFileSync(path.join(wt, 'g'), 'z\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'side work');

  const fromMain = land(repo, ['--dry-run']);
  const fromWt = land(wt, ['--dry-run']);
  const lockOf = (out) => out.split('\n').find((l) => l.includes('land.lock')).trim();

  // Same lock from both, or two sessions would land concurrently anyway.
  assert.strictEqual(lockOf(fromWt.stdout), lockOf(fromMain.stdout));
});
