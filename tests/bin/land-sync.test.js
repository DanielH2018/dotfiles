// Regression guard for bin/land-sync.
//
// The routing is the whole script: which branch the PRIMARY checkout is on decides
// whether main can be merged at all, and getting it wrong pulls origin/main into
// another session's in-flight branch. So the fixture is the real shape — a bare repo
// on disk playing origin, a primary checkout, and a linked worktree that land-sync is
// invoked from — and nothing about the primary is stubbed. It runs for real against
// throwaway repos; $HOME is never touched, because land-sync deploys nothing.
//
// The CLEAN_ENV below is load-bearing, not hygiene. prek's pre-push runs with GIT_DIR
// exported, and `git worktree list` honours it: without the strip, land-sync would
// resolve the primary as the OPERATOR'S checkout and this suite would move it.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { repoPath } = require('../lib/paths');
const { run } = require('../lib/run');

const LAND_SYNC = repoPath('bin', 'land-sync');

const skip = skipUnless('bash', 'git');

const CLEAN_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

// origin holds a commit on main that the primary has not got: exactly the state a
// landing leaves behind, since land pushes <branch>:main and moves nothing local.
function makeFixture() {
  const base = scratch(os.tmpdir(), 'land-sync-');
  const origin = path.join(base, 'origin.git');
  const primary = path.join(base, 'primary');
  const wt = path.join(base, 'wt');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: CLEAN_ENV });
  execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: CLEAN_ENV });
  git(primary, 'config', 'user.email', 't@example.test');
  git(primary, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(primary, 'home'));
  fs.writeFileSync(path.join(primary, 'home', 'dot_file'), 'before\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-qm', 'init');
  git(primary, 'remote', 'add', 'origin', origin);
  git(primary, 'push', '-q', '-u', 'origin', 'main');

  // The landing: a commit pushed to origin/main that local main has never seen.
  git(primary, 'checkout', '-qb', 'landed');
  fs.writeFileSync(path.join(primary, 'home', 'dot_file'), 'after\n');
  git(primary, 'add', '-A');
  git(primary, 'commit', '-qm', 'landed work');
  git(primary, 'push', '-q', 'origin', 'landed:main');
  const landedTip = git(primary, 'rev-parse', 'HEAD');
  git(primary, 'checkout', '-q', 'main');
  git(primary, 'branch', '-qD', 'landed');

  // A session's worktree, which is where land-sync is normally run from.
  git(primary, 'worktree', 'add', '-q', '-b', 'session', wt);
  return { base, origin, primary, wt, landedTip };
}

const landSync = (cwd, args = []) => run('bash', [LAND_SYNC, ...args], { cwd, env: CLEAN_ENV });

test('fast-forwards the primary onto origin/main when it is on main', { skip }, () => {
  const f = makeFixture();
  const r = landSync(f.wt);
  assert.strictEqual(r.code, 0, r.stderr);

  assert.strictEqual(git(f.primary, 'rev-parse', 'main'), f.landedTip,
    'the primary checkout is still on the pre-landing commit');
  assert.strictEqual(fs.readFileSync(path.join(f.primary, 'home', 'dot_file'), 'utf8'), 'after\n',
    'the working tree chezmoi reads as its source was not updated');
});

// The reject half. A main that has diverged cannot be fast-forwarded, and the answer
// is to reconcile it by hand — not to build a merge commit in a repo whose history is
// linear, and not to report success over a sync that did not happen.
test('refuses loudly when main has diverged instead of merging it', { skip }, () => {
  const f = makeFixture();
  fs.writeFileSync(path.join(f.primary, 'home', 'dot_other'), 'local\n');
  git(f.primary, 'add', '-A');
  git(f.primary, 'commit', '-qm', 'local-only commit');
  const before = git(f.primary, 'rev-parse', 'main');

  const r = landSync(f.wt);
  assert.strictEqual(r.code, 1, `land-sync reported success on a diverged main:\n${r.stdout}`);
  assert.match(r.stderr, /will not fast-forward/);
  assert.strictEqual(git(f.primary, 'rev-parse', 'main'), before, 'main moved anyway');
});

// The case the skill routes on, and the reason it routes at all: `merge --ff-only
// origin/main` here would pull the landing into whoever's branch the primary is
// parked on. Updating the ref leaves that branch, its HEAD and its tree alone.
test('advances main without disturbing a primary parked on another branch', { skip }, () => {
  const f = makeFixture();
  git(f.primary, 'checkout', '-qb', 'parked');
  fs.writeFileSync(path.join(f.primary, 'home', 'dot_file'), 'parked\n');
  git(f.primary, 'add', '-A');
  git(f.primary, 'commit', '-qm', 'parked work');
  const parkedTip = git(f.primary, 'rev-parse', 'HEAD');

  const r = landSync(f.wt);
  assert.strictEqual(r.code, 0, r.stderr);

  assert.strictEqual(git(f.primary, 'rev-parse', 'main'), f.landedTip, 'main was not advanced');
  assert.strictEqual(git(f.primary, 'rev-parse', 'HEAD'), parkedTip, 'the parked branch was moved');
  assert.strictEqual(git(f.primary, 'rev-parse', '--abbrev-ref', 'HEAD'), 'parked',
    'land-sync left the bench');
  assert.strictEqual(fs.readFileSync(path.join(f.primary, 'home', 'dot_file'), 'utf8'), 'parked\n',
    "the parked branch's working tree was overwritten");
  assert.match(r.stdout, /try --back/, 'the parked case must name the step it deliberately leaves out');
});

test('--dry-run prints the plan and moves nothing', { skip }, () => {
  const f = makeFixture();
  const before = git(f.primary, 'rev-parse', 'main');

  const r = landSync(f.wt, ['--dry-run']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /merge --ff-only origin\/main/);
  assert.strictEqual(git(f.primary, 'rev-parse', 'main'), before, 'main moved on a dry run');
});
