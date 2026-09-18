// check-before-stop.sh blocks a session from stopping with the repo in a state that
// loses work. It had no test until the untracked check was added, which is the wrong way
// round for a hook whose only output is a block: every false positive interrupts a
// working session, and every miss is lost work.
//
// Two axes matter and they are independent. WHICH repo (the dotfiles exemption is the
// only one left; the homelab one was removed 2026-08-21 because master there is a deploy
// trigger reachable only through a PR) and WHICH state (staged, unstaged, untracked,
// mid-rebase, mid-merge). The rebase and merge blocks apply on any branch; the three
// dirty-tree blocks only on a protected one.

const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_check-before-stop.sh');

// Scrub git's own environment. These tests build real repos in a temp dir and drive them
// with cwd, but GIT_DIR and GIT_WORK_TREE outrank cwd — and git exports both to every
// hook it runs, so under a pre-commit or pre-push hook an unscrubbed run aims `git init`
// and `git commit` at the REAL repository the hook fired in.
const GIT_ENV = { ...process.env };
for (const k of Object.keys(GIT_ENV)) if (k.startsWith('GIT_')) delete GIT_ENV[k];
GIT_ENV.GIT_CONFIG_GLOBAL = '/dev/null';
GIT_ENV.GIT_CONFIG_SYSTEM = '/dev/null';

function sh(cmd, cwd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, `${cmd} (stderr: ${r.stderr})`);
  return (r.stdout || '').trim();
}

function repo({ remote = 'https://github.com/DanielH2018/server.git', branch = 'master' } = {}) {
  const work = scratch(os.tmpdir(), 'cbs-');
  sh(`git init -q -b ${branch} .`, work);
  sh('git config user.email t@t && git config user.name t', work);
  sh(`git remote add origin ${remote}`, work);
  fs.writeFileSync(path.join(work, 'tracked'), 'one\n');
  sh('git add tracked && git commit -qm one', work);
  return work;
}

// Returns the hook's decision, or null when it stayed silent (the common, correct case).
function run(cwd, { stopHookActive = false } = {}) {
  const r = spawnSync('bash', [HOOK], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    input: JSON.stringify({ session_id: 'test', stop_hook_active: stopHookActive }),
  });
  assert.strictEqual(r.status, 0, `hook exited ${r.status} (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

test('a clean protected branch stops without comment', () => {
  assert.strictEqual(run(repo()), null);
});

test('an untracked file on master blocks the stop', () => {
  const work = repo();
  fs.writeFileSync(path.join(work, 'docs-draft.md'), 'a finished thing nobody committed\n');
  const d = run(work);
  assert.ok(d, 'expected a block');
  assert.strictEqual(d.decision, 'block');
  assert.match(d.reason, /untracked/i);
  assert.match(d.reason, /docs-draft\.md/, 'the reason must name the file');
});

test('the untracked block offers all four exits, including leaving it', () => {
  const work = repo();
  fs.writeFileSync(path.join(work, 'scratch.txt'), 'x\n');
  const { reason } = run(work);
  // An untracked file has no history, so "leave it" is a real answer — a message that
  // only says "commit it" makes the session guess, and guessing commits scratch files.
  for (const word of [/commit it/i, /\.gitignore/, /delete it/i, /deliberate/i]) {
    assert.match(reason, word);
  }
});

test('a gitignored file is not untracked work', () => {
  const work = repo();
  fs.writeFileSync(path.join(work, '.gitignore'), 'build/\n');
  sh('git add .gitignore && git commit -qm ignore', work);
  fs.mkdirSync(path.join(work, 'build'));
  fs.writeFileSync(path.join(work, 'build', 'out.o'), 'x\n');
  assert.strictEqual(run(work), null, '--exclude-standard must honour .gitignore');
});

test('an untracked file on a feature branch is fine', () => {
  const work = repo();
  sh('git switch -qc feature', work);
  fs.writeFileSync(path.join(work, 'draft.md'), 'x\n');
  assert.strictEqual(run(work), null, 'only protected branches are guarded');
});

test('staged changes outrank untracked ones in the reason', () => {
  const work = repo();
  fs.writeFileSync(path.join(work, 'tracked'), 'two\n');
  sh('git add tracked', work);
  fs.writeFileSync(path.join(work, 'stray.md'), 'x\n');
  const { reason } = run(work);
  assert.match(reason, /staged/i, 'the most urgent state is the one reported');
});

test('unstaged changes outrank untracked ones in the reason', () => {
  const work = repo();
  fs.writeFileSync(path.join(work, 'tracked'), 'two\n');
  fs.writeFileSync(path.join(work, 'stray.md'), 'x\n');
  const { reason } = run(work);
  assert.match(reason, /unstaged/i);
});

test('stop_hook_active lets a second pass through', () => {
  const work = repo();
  fs.writeFileSync(path.join(work, 'stray.md'), 'x\n');
  assert.strictEqual(run(work, { stopHookActive: true }), null, 'must not loop');
});

test('the dotfiles repo is still exempt', () => {
  const work = repo({ remote: 'https://github.com/DanielH2018/dotfiles.git', branch: 'main' });
  fs.writeFileSync(path.join(work, 'stray.md'), 'x\n');
  assert.strictEqual(run(work), null, 'dotfiles commits to main by convention');
});

test('the homelab repo is NOT exempt any more', () => {
  const work = repo();
  fs.writeFileSync(path.join(work, 'stray.md'), 'x\n');
  assert.ok(run(work), 'master here is a deploy trigger reachable only through a PR');
});

test('an in-progress rebase blocks on any branch', () => {
  const work = repo();
  sh('git switch -qc feature', work);
  fs.mkdirSync(path.join(work, '.git', 'rebase-merge'));
  const d = run(work);
  assert.ok(d, 'expected a block');
  assert.match(d.reason, /rebase/i);
});

test('outside a git repo it says nothing', () => {
  const bare = scratch(os.tmpdir(), 'cbs-nogit-');
  assert.strictEqual(run(bare), null);
});

