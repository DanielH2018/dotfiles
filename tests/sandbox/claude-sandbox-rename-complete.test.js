// The three worktree CLI paths that end in an early exit — `--complete-worktrees`,
// `--complete-branches` and `--rename` — none of which had any behavioural coverage.
// claude-sandbox-flag-drift.test.js checks the completion script offers the same FLAG
// NAMES the launcher accepts; nothing checked what the completions actually print, or
// that a rename moves the four things it claims to move.
//
// Driven end-to-end rather than by extracting function bodies: these are top-level
// dispatch blocks, so a subprocess is the only thing that exercises the guard, the
// repo-path resolution and the body together. That also makes the tests indifferent to
// whether the bodies later become functions in a lib.
//
// The launcher resolves everything from $HOME/.claude/sandbox, so each test gets a
// throwaway HOME with the source tree's sandbox files copied in under their deployed
// names. Offline, and docker is stubbed so the "is a session running" probe is
// deterministic on a machine that has a real docker.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');

const SANDBOX_DIR = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox');

let toolsOk = true;
try {
  execFileSync('bash', ['-c', 'command -v awk'], { stdio: 'ignore' });
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch { toolsOk = false; }
const skip = process.platform === 'win32' ? 'launcher is Unix-only'
  : toolsOk ? false : 'bash/awk/git unavailable';

// A HOME holding the sandbox tree under its deployed names (chezmoi's executable_
// prefix sets the deployed mode, so it is stripped here the way an apply would).
function sandboxHome() {
  const home = scratch(os.tmpdir(), 'sbwt-');
  const sd = path.join(home, '.claude', 'sandbox');
  fs.mkdirSync(sd, { recursive: true });
  for (const f of fs.readdirSync(SANDBOX_DIR)) {
    const from = path.join(SANDBOX_DIR, f);
    if (!fs.statSync(from).isFile()) continue;
    const to = path.join(sd, f.replace(/^executable_/, ''));
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o755);
  }
  return home;
}

// PATH shim whose `docker` reports no running containers, so the rename guard is
// deterministic regardless of what the host has installed.
function stubBin() {
  const bin = scratch(os.tmpdir(), 'sbwt-');
  fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return bin;
}

function gitRepo(name = 'demo') {
  const root = scratch(os.tmpdir(), 'sbwt-');
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
  });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init', '--no-gpg-sign');
  return { root, repo, g };
}

function run(home, args, extraEnv = {}) {
  const launcher = path.join(home, '.claude', 'sandbox', 'claude-sandbox');
  return spawnSync('bash', [launcher, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home, PATH: `${stubBin()}:${process.env.PATH}`,
      CLAUDE_SANDBOX_NO_OVERRIDE_SCAN: '1', ...extraEnv,
    },
  });
}

// A tool worktree is the pair the completion looks for: a directory at
// <repo>-wt-<name> whose checked-out branch is claude/<name>.
function addToolWorktree({ repo, g }, name) {
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-wt-${name}`);
  g('worktree', 'add', '-q', '-b', `claude/${name}`, wt);
  return wt;
}

test('--complete-worktrees prints tool worktrees, not every claude/ branch', { skip }, () => {
  const home = sandboxHome();
  const r = gitRepo();
  addToolWorktree(r, 'alpha');
  // A claude/ branch with no matching tool worktree must NOT be offered: `-w` on it
  // would make a second worktree rather than the round trip the completion implies.
  r.g('branch', 'claude/loose');

  const out = run(home, ['--complete-worktrees', r.repo]);
  assert.strictEqual(out.status, 0, out.stderr);
  const names = out.stdout.split('\n').filter(Boolean);
  assert.ok(names.includes('alpha'), `expected alpha in ${JSON.stringify(names)}`);
  assert.ok(!names.includes('loose'), `claude/loose has no tool worktree: ${JSON.stringify(names)}`);
});

// Characterises what actually happens, which is not what the completion block's own
// `[[ -z "$REPO_PATH" ]] && exit 0` guard suggests: arg parsing calls usage() and exits
// 1 long before that guard is reached, so a completion invoked without a resolvable repo
// emits the whole usage block on stderr rather than an empty list. Pinned as-is — the
// behaviour predates this file and changing it is a separate decision.
test('--complete-worktrees falls into usage when given no repo', { skip }, () => {
  const out = run(sandboxHome(), ['--complete-worktrees']);
  assert.strictEqual(out.status, 1, 'usage() exits non-zero');
  assert.match(out.stdout + out.stderr, /Usage: claude-sandbox/,
    'the whole usage block is emitted where completion candidates would go');
});

test('--complete-branches lists local branches only', { skip }, () => {
  const home = sandboxHome();
  const r = gitRepo();
  r.g('branch', 'feature-x');

  const out = run(home, ['--complete-branches', r.repo]);
  assert.strictEqual(out.status, 0, out.stderr);
  const branches = out.stdout.split('\n').filter(Boolean);
  assert.deepStrictEqual(branches.sort(), ['feature-x', 'main']);
});

test('--rename moves the branch, the worktree and the session data together', { skip }, () => {
  const home = sandboxHome();
  const r = gitRepo();
  const oldWt = addToolWorktree(r, 'old');

  // Session/audit/artifact dirs are keyed by <repo>-<hash>-<name>; ask the launcher
  // itself for the instance id rather than recomputing the hash here.
  const sd = path.join(home, '.claude', 'sandbox');
  const inst = execFileSync('bash', ['-c',
    `. '${path.join(sd, 'sandbox-lib.sh')}'; . '${path.join(sd, 'sandbox-worktree.sh')}';`
    + `echo "$(sanitize_repo_name '${r.repo}')-$(repo_hash '${r.repo}')"`], { encoding: 'utf8' }).trim();
  for (const base of ['sessions', 'audit', 'artifacts']) {
    fs.mkdirSync(path.join(sd, base, `${inst}-old`), { recursive: true });
    fs.writeFileSync(path.join(sd, base, `${inst}-old`, 'marker'), base);
  }

  const out = run(home, ['--rename', 'old', 'new', r.repo]);
  assert.strictEqual(out.status, 0, out.stderr);

  const branches = execFileSync('git', ['-C', r.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(branches.includes('claude/new'), 'branch renamed');
  assert.ok(!branches.includes('claude/old'), 'old branch gone');

  assert.ok(fs.existsSync(path.join(path.dirname(r.repo), 'demo-wt-new')), 'worktree dir moved');
  assert.ok(!fs.existsSync(oldWt), 'old worktree dir gone');

  for (const base of ['sessions', 'audit', 'artifacts']) {
    assert.strictEqual(fs.readFileSync(path.join(sd, base, `${inst}-new`, 'marker'), 'utf8'), base,
      `${base} data moved with the rename`);
    assert.ok(!fs.existsSync(path.join(sd, base, `${inst}-old`)), `${base} old dir gone`);
  }
});

test('--rename refuses a name that is not alphanumeric', { skip }, () => {
  const home = sandboxHome();
  const r = gitRepo();
  addToolWorktree(r, 'old');
  const out = run(home, ['--rename', 'old', 'bad name!', r.repo]);
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /must be alphanumeric/);
});

test('--rename refuses when nothing exists under the old name', { skip }, () => {
  const home = sandboxHome();
  const r = gitRepo();
  const out = run(home, ['--rename', 'ghost', 'new', r.repo]);
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /nothing found for 'ghost'/);
});

test('--rename refuses when the new branch already exists', { skip }, () => {
  const home = sandboxHome();
  const r = gitRepo();
  addToolWorktree(r, 'old');
  r.g('branch', 'claude/taken');
  const out = run(home, ['--rename', 'old', 'taken', r.repo]);
  assert.strictEqual(out.status, 1);
  assert.match(out.stderr, /already exists/);
});
