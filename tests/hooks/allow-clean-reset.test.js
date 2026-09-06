// Regression guard for executable_allow-clean-reset.sh (PermissionRequest/Bash).
// Drives the ACTUAL hook against real temp git repos and asserts it auto-allows ONLY a
// `git reset --hard origin/master|origin/main` run against a clean tree outside a
// rebase/merge/cherry-pick, and defers (no decision) for everything else. Offline and
// deterministic. Skips cleanly without bash/jq/git.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_allow-clean-reset.sh');

let toolsOk = true;
try {
  execFileSync('bash', ['-c', 'command -v jq && command -v git'], { stdio: 'ignore' });
} catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq/git unavailable';

function sh(cwd, cmd) {
  execFileSync('bash', ['-c', cmd], { cwd, stdio: 'ignore' });
}

const dirs = [];
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function behavior(command, cwd) {
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify({ tool_input: { command }, cwd }),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { out = e.stdout || ''; }
  if (!out.trim()) return null; // hook deferred to normal handling
  try { return JSON.parse(out).hookSpecificOutput.decision.behavior; } catch { return null; }
}

// Builds a repo with an `origin` remote whose named branch has moved ahead of the local
// checkout and carries one tracked file, so `git reset --hard origin/<branch>` is a real,
// meaningful fast-forward and a "dirty tracked file" case has something to dirty.
function makeRepo(branch = 'master') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-reset-'));
  dirs.push(root);
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  sh(root, `git init -q --bare "${bare}"`);
  sh(root, `git clone -q "${bare}" "${work}"`);
  sh(work, 'git config user.email a@b.c && git config user.name a');
  fs.writeFileSync(path.join(work, 'README.md'), 'first\n');
  sh(work, `git add README.md && git commit -q -m one && git push -q origin HEAD:refs/heads/${branch}`);
  sh(work, `git commit -q --allow-empty -m two && git push -q origin HEAD:refs/heads/${branch}`);
  // Local checkout falls one commit behind origin/<branch>.
  sh(work, 'git reset -q --hard HEAD~1');
  sh(work, 'git fetch -q origin');
  return work;
}

test('clean tree reset to origin/master is allowed', { skip }, () => {
  const work = makeRepo();
  assert.strictEqual(behavior('git reset --hard origin/master', work), 'allow');
});

test('clean tree reset to origin/main is allowed', { skip }, () => {
  const work = makeRepo('main');
  assert.strictEqual(behavior('git reset --hard origin/main', work), 'allow');
});

test('quiet flag and trailing tail are still allowed', { skip }, () => {
  const work = makeRepo();
  assert.strictEqual(behavior('git reset --hard -q origin/master', work), 'allow');
  assert.strictEqual(behavior('git reset --hard --quiet origin/master', work), 'allow');
  assert.strictEqual(behavior('git reset --hard origin/master 2>&1 | tail -n 20', work), 'allow');
  assert.strictEqual(behavior('git reset --hard origin/master | tail -20', work), 'allow');
});

test('a worktree (not the primary checkout) is allowed when clean', { skip }, () => {
  const work = makeRepo();
  const wtDir = path.join(path.dirname(work), 'wt');
  sh(work, `git worktree add -q -b wt-branch "${wtDir}" origin/master`);
  sh(wtDir, 'git fetch -q origin');
  assert.strictEqual(behavior('git reset --hard origin/master', wtDir), 'allow');
});

test('a dirty tracked file is refused', { skip }, () => {
  const work = makeRepo();
  // README.md is tracked and committed by makeRepo(); overwriting it without
  // committing is a genuine modification `git status --porcelain` reports.
  fs.writeFileSync(path.join(work, 'README.md'), 'local edit\n');
  assert.strictEqual(behavior('git reset --hard origin/master', work), null);
});

test('an untracked file does not block the reset', { skip }, () => {
  const work = makeRepo();
  fs.writeFileSync(path.join(work, 'scratch.txt'), 'not tracked\n');
  assert.strictEqual(behavior('git reset --hard origin/master', work), 'allow');
});

test('a ref other than origin/master or origin/main is refused', { skip }, () => {
  const work = makeRepo();
  sh(work, 'git branch -f origin/feature origin/master');
  assert.strictEqual(behavior('git reset --hard origin/feature', work), null);
});

test('a bare SHA is refused', { skip }, () => {
  const work = makeRepo();
  const sha = execFileSync('bash', ['-c', 'git rev-parse origin/master'], { cwd: work, encoding: 'utf8' }).trim();
  assert.strictEqual(behavior(`git reset --hard ${sha}`, work), null);
});

test('a chained command riding in on the reset is refused', { skip }, () => {
  const work = makeRepo();
  assert.strictEqual(behavior('git reset --hard origin/master && rm -rf x', work), null);
});

test('mid-rebase is refused even on a clean tree', { skip }, () => {
  const work = makeRepo();
  fs.mkdirSync(path.join(work, '.git', 'rebase-merge'));
  assert.strictEqual(behavior('git reset --hard origin/master', work), null);
});

test('a reflog ref is refused', { skip }, () => {
  const work = makeRepo();
  assert.strictEqual(behavior('git reset --hard origin/master@{1}', work), null);
});

test('a command substitution smuggled into the command is refused', { skip }, () => {
  const work = makeRepo();
  assert.strictEqual(behavior('git reset --hard origin/master && echo $(rm -rf /)', work), null);
});
