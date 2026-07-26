// Regression guard for bin/land.
// The refusals are the safety property — land is the one tool here allowed to
// rewrite a remote branch, so each guard that stops it doing so on the wrong
// branch, a dirty tree, or a half-finished rebase is worth pinning. The landing
// itself is covered too, against a bare repo on disk standing in for origin and
// a stub gh: real fetch/rebase/push/delete, no network, no GitHub. Skips without
// bash/git.
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

const dirs = [];

// Stub gh: reports an open PR only when STUB_PR is set, answers the draft check
// from STUB_DRAFT, and records every call that would change something — reads
// stay unrecorded, so the tests can still prove --dry-run made no changes.
// STUB_OPEN_FOR makes the state check answer OPEN that many times before settling
// on STUB_PR_STATE, standing in for GitHub taking a moment to mark a PR merged.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'land-bin-'));
dirs.push(BIN);
fs.writeFileSync(path.join(BIN, 'gh'), `#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s' "\${STUB_PR:-}"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$*" in
    *state*)
      seen=0
      [ -f "$STUB_STATE_SEEN" ] && seen=\$(cat "$STUB_STATE_SEEN")
      seen=\$((seen + 1))
      printf '%s' "\$seen" > "$STUB_STATE_SEEN"
      if [ "\$seen" -le "\${STUB_OPEN_FOR:-0}" ]; then
        printf 'OPEN\\n'
      else
        printf '%s\\n' "\${STUB_PR_STATE:-MERGED}"
      fi
      ;;
    *) printf '%s\\n' "\${STUB_DRAFT:-false}" ;;
  esac
  exit 0
fi
echo "gh $*" >> "$STUB_GH_CALLS"
exit 0
`, { mode: 0o755 });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-repo-'));
  dirs.push(dir);
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

// A bare repo on disk plays origin, so a whole landing — fetch, rebase, push,
// delete — runs for real with nothing stubbed but gh.
function makeRepoWithOrigin() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'land-remote-'));
  dirs.push(base);
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: CLEAN_ENV });
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'f'), 'y\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'work');
  git(dir, 'push', '-q', '-u', 'origin', 'feature');
  return { base, dir, origin };
}

const ghCalls = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const remoteHas = (dir, branch) => git(dir, 'ls-remote', '--heads', 'origin', branch) !== '';

function land(cwd, args = [], { pr = '7', draft = 'false', state = 'MERGED', openFor = '0' } = {}) {
  const calls = path.join(cwd, '.gh-calls');
  try {
    const stdout = execFileSync('bash', [LAND, ...args], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...CLEAN_ENV, PATH: `${BIN}:${CLEAN_ENV.PATH}`,
        STUB_PR: pr, STUB_DRAFT: draft, STUB_PR_STATE: state, STUB_GH_CALLS: calls,
        STUB_OPEN_FOR: openFor, STUB_STATE_SEEN: path.join(cwd, '.gh-state-seen'),
      },
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
  assert.match(r.stdout, /gh pr ready 7/);
  assert.match(r.stdout, /git push origin feature:main/);
  assert.match(r.stdout, /git push origin --delete feature/);
  assert.doesNotMatch(r.stdout, /gh pr merge/, 'the merge no longer goes through gh');

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
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'land-wt-'));
  dirs.push(wtRoot);
  const wt = path.join(wtRoot, 'w');
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

test('still takes the PR out of draft', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);

  // The original reason was that GitHub refuses to merge a draft, which no longer
  // applies now that main is fast-forwarded by git rather than merged by GitHub.
  // Kept anyway: background jobs open drafts by convention, and a PR that landed
  // should not still read as one.
  assert.match(ghCalls(r.calls), /gh pr ready 7/);
});

test('leaves a PR that is already out of draft alone', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'false' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.doesNotMatch(ghCalls(r.calls), /pr ready/);
});

test('deletes the remote branch with git, not gh --delete-branch', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  assert.ok(remoteHas(dir, 'feature'), 'setup: origin should start with the branch');

  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);

  // gh's --delete-branch checks out the default branch locally, which cannot
  // work when another worktree holds main — and it fails there *after* the
  // merge, so a landing that worked reports as failed and the branch survives.
  assert.doesNotMatch(ghCalls(r.calls), /--delete-branch/);
  assert.ok(!remoteHas(dir, 'feature'), 'origin still holds the landed branch');
});

// The point of the fast-forward. `gh pr merge --rebase` replayed commits into new
// objects with no signature, so main collected unsigned commits on every landing.
// Moving main onto the branch's own ref keeps the objects, and with them the
// signatures — the SHA being identical is what proves nothing was replayed.
test('main lands on the branch tip itself, not a replayed copy', { skip }, () => {
  const { dir, origin } = makeRepoWithOrigin();
  const tip = git(dir, 'rev-parse', 'feature');

  const r = land(dir, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);

  const landed = execFileSync('git', ['rev-parse', 'main'], { cwd: origin, encoding: 'utf8', env: CLEAN_ENV }).trim();
  assert.strictEqual(landed, tip, 'origin/main is the exact commit that was pushed');
  assert.doesNotMatch(ghCalls(r.calls), /pr merge/, 'GitHub never re-created the commits');
});

test('closes the PR itself when GitHub has not marked it merged', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true', state: 'OPEN' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(ghCalls(r.calls), /pr close 7/);
});

// The bug this replaced: one check straight after the push read OPEN, so land closed
// a PR GitHub marked MERGED a moment later — the fallback racing what it backs up.
test('waits for GitHub to catch up before closing anything', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true', openFor: '2' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /waiting for GitHub/);
  assert.doesNotMatch(ghCalls(r.calls), /pr close/, 'GitHub got there on its own');
});

test('leaves the PR alone when GitHub already marked it merged', { skip }, () => {
  const { dir } = makeRepoWithOrigin();
  const r = land(dir, [], { draft: 'true', state: 'MERGED' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.doesNotMatch(ghCalls(r.calls), /pr close/);
});

test('lands from a linked worktree while the primary holds main', { skip }, () => {
  const { base, dir } = makeRepoWithOrigin();
  git(dir, 'checkout', '-q', 'main');
  const wt = path.join(base, 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'feature');

  const r = land(wt, [], { draft: 'true' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /landed feature/);
  assert.ok(!remoteHas(dir, 'feature'), 'origin still holds the landed branch');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
