// Regression guard for bin/try.
// Two properties matter here. The refusals — linked worktree, dirty tree, wrong
// branch, non-fast-forward — are what keep the bench from being deployed out of
// somebody else's half-finished state. And the move itself: try exists because git
// lets the primary checkout detach onto a branch a worktree already holds, so that
// is pinned against a real second worktree rather than asserted. chezmoi is stubbed
// to record its calls, so nothing here touches $HOME. Skips without bash/git.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TRY = path.join(__dirname, '..', 'bin', 'try');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v git'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/git unavailable';

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

const dirs = [];

// Stub chezmoi: records every call, so a test can prove apply was reached — or
// prove it was not, which is the whole point of --diff and --dry-run.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'try-bin-'));
dirs.push(BIN);
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
echo "chezmoi $*" >> "$STUB_CHEZMOI_CALLS"
exit 0
`, { mode: 0o755 });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();
}

// A repo whose feature branch is held by a linked worktree — the situation try is
// for. `origin` is a bare repo on disk so the ahead-of-origin notice has a remote
// to compare against.
function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'try-repo-'));
  dirs.push(base);
  const origin = path.join(base, 'origin.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: CLEAN_ENV });
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'branch', 'feature');
  const wt = path.join(base, 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'feature');
  fs.writeFileSync(path.join(wt, 'f'), 'y\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'work');
  return { dir, wt };
}

const calls = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const branchOf = (dir) => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

// The calls file lives outside the repo on purpose: dropped inside it, it would
// itself make the tree dirty and trip try's own guard on the next invocation.
function run(cwd, args = []) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'try-calls-'));
  dirs.push(box);
  const file = path.join(box, 'calls');
  try {
    const stdout = execFileSync('bash', [TRY, ...args], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...CLEAN_ENV, PATH: `${BIN}:${CLEAN_ENV.PATH}`, STUB_CHEZMOI_CALLS: file },
    });
    return { code: 0, stdout, stderr: '', file };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '', file };
  }
}

test('refuses to run from a linked worktree', { skip }, () => {
  const { wt } = makeRepo();
  const r = run(wt, ['feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /linked worktree — run try from the primary checkout/);
});

test('refuses a dirty primary checkout, which is usually another session', { skip }, () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'README'), 'dirty\n');
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /primary checkout is dirty/);
  assert.strictEqual(branchOf(dir), 'main');
});

test('refuses an unknown branch', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['nope']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /no such branch: nope/);
});

test('refuses to try the bench itself', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['main']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /main is the bench/);
});

test('refuses a branch with no branch named', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, []);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /which branch\?/);
});

test('refuses two branches at once', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature', 'other']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /one branch at a time/);
});

test('rejects an unknown flag', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['--nope']);
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /unknown flag --nope/);
});

test('--dry-run moves nothing and deploys nothing', { skip }, () => {
  const { dir } = makeRepo();
  const before = head(dir);
  const r = run(dir, ['feature', '--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /git checkout --detach feature/);
  assert.strictEqual(head(dir), before);
  assert.strictEqual(calls(r.file), '');
});

// The property try is built on: the primary checkout can reach a branch that is
// checked out in another worktree, as long as it detaches to do it.
test('detaches onto a branch a worktree already holds, then deploys', { skip }, () => {
  const { dir, wt } = makeRepo();
  const target = git(dir, 'rev-parse', 'feature');
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(head(dir), target);
  assert.strictEqual(branchOf(dir), 'HEAD'); // detached, so main is untouched
  assert.strictEqual(git(dir, 'rev-parse', 'main'), git(dir, 'rev-parse', 'origin/main'));
  assert.match(calls(r.file), /chezmoi diff/);
  assert.match(calls(r.file), /chezmoi apply/);
  // The worktree that owns the branch is left exactly as it was.
  assert.strictEqual(branchOf(wt), 'feature');
  assert.strictEqual(git(wt, 'status', '--porcelain'), '');
});

test('--diff moves HEAD but stops before apply', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['feature', '--diff']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(head(dir), git(dir, 'rev-parse', 'feature'));
  assert.match(calls(r.file), /chezmoi diff/);
  assert.doesNotMatch(calls(r.file), /chezmoi apply/);
});

test('--merge fast-forwards main and warns it is ahead of origin', { skip }, () => {
  const { dir } = makeRepo();
  const target = git(dir, 'rev-parse', 'feature');
  const r = run(dir, ['--merge', 'feature']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(branchOf(dir), 'main');
  assert.strictEqual(head(dir), target);
  assert.match(r.stdout, /main is 1 commit\(s\) ahead of origin\/main/);
  assert.match(calls(r.file), /chezmoi apply/);
});

test('--merge refuses when main is not checked out here', { skip }, () => {
  const { dir } = makeRepo();
  git(dir, 'checkout', '-q', '--detach', 'feature');
  const r = run(dir, ['--merge', 'feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /--merge needs main checked out here/);
});

test('--merge refuses a branch that has diverged from main', { skip }, () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'README'), 'moved on\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'main moves');
  const r = run(dir, ['--merge', 'feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /not a fast-forward from main — land it through its PR/);
});

test('--back returns the bench to main and redeploys', { skip }, () => {
  const { dir } = makeRepo();
  assert.strictEqual(run(dir, ['feature']).code, 0);
  assert.strictEqual(branchOf(dir), 'HEAD');
  const r = run(dir, ['--back']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(branchOf(dir), 'main');
  assert.match(calls(r.file), /chezmoi apply/);
});

test('--back takes no branch', { skip }, () => {
  const { dir } = makeRepo();
  const r = run(dir, ['--back', 'feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /--back takes no branch/);
});

test('notes when the bench is parked on some other branch', { skip }, () => {
  const { dir } = makeRepo();
  git(dir, 'checkout', '-qb', 'parked');
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /primary checkout is on parked, not main/);
});

test('refuses while a merge is in progress', { skip }, () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), `${git(dir, 'rev-parse', 'feature')}\n`);
  const r = run(dir, ['feature']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /a merge is in progress here/);
});

test('-h prints usage without touching the repo', { skip }, () => {
  const { dir } = makeRepo();
  const before = head(dir);
  const r = run(dir, ['-h']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /try <branch>\s+detach onto <branch>/);
  assert.match(r.stdout, /try --back/);
  assert.strictEqual(head(dir), before);
  assert.strictEqual(calls(r.file), '');
});

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
