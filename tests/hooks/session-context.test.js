// Unit tests for executable_session-context.sh — the SessionStart hook that injects repo
// context. The security-relevant part is the install-hook-shim re-assertion: it runs before
// the user types anything and before the permission gates see it, so it must execute only
// for repos on the trust list, not for whatever repo you happened to cd into.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_session-context.sh');
const skip = !have('bash') ? 'bash unavailable' : !have('jq') ? 'jq unavailable' : !have('git') ? 'git unavailable' : false;

// A git repo that ships an executable bin/install-hook-shim. The shim records that it ran
// by creating a marker next to itself, and prints a line the hook would relay.
function repoWithShim() {
  const root = fs.realpathSync(scratch(os.tmpdir(), 'sesctx-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'install-hook-shim'), `#!/bin/bash
touch ${JSON.stringify(path.join(root, 'SHIM_RAN'))}
echo "shim reinstalled"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'README'), 'x\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  return root;
}

function runHook(cwd, { trusted, source = 'startup', pending, extraEnv = {} } = {}) {
  const env = { ...process.env, HOME: fs.realpathSync(scratch(os.tmpdir(), 'sesctx-')), ...extraEnv };
  if (trusted !== undefined) env.CLAUDE_SHIM_TRUSTED_ROOTS = trusted;
  else delete env.CLAUDE_SHIM_TRUSTED_ROOTS;
  // Unset it points at $HOME, which fs.realpathSync(scratch(os.tmpdir(), 'sesctx-')) has already redirected, so the default is
  // hermetic either way; the tests that care name their own file.
  if (pending !== undefined) env.CLAUDE_TRANSCRIPT_LEAK_PENDING = pending;
  const started = Date.now();
  const r = spawnSync('bash', [HOOK], {
    cwd, env, input: JSON.stringify({ source }), encoding: 'utf8', timeout: 20000,
  });
  return { out: r.stdout || '', code: r.status, seconds: (Date.now() - started) / 1000 };
}

test('does not run bin/install-hook-shim from an untrusted repo', { skip }, () => {
  const root = repoWithShim();
  const { out, code } = runHook(root, { trusted: '/nonexistent/trusted/root' });
  assert.strictEqual(code, 0, 'hook still succeeds');
  assert.ok(!fs.existsSync(path.join(root, 'SHIM_RAN')), 'the repo-controlled shim was NOT executed');
  assert.doesNotMatch(out, /shim reinstalled/, 'and its output never reached the transcript');
  assert.match(out, /=== Repo context ===/, 'the rest of the context is still injected');
});

test('runs the shim for a repo on the trust list', { skip }, () => {
  const root = repoWithShim();
  const { out, code } = runHook(root, { trusted: root });
  assert.strictEqual(code, 0);
  assert.ok(fs.existsSync(path.join(root, 'SHIM_RAN')), 'the trusted repo\'s shim ran');
  assert.match(out, /shim reinstalled/, 'its output is relayed');
});

test('honours a multi-entry trust list', { skip }, () => {
  const root = repoWithShim();
  const { code } = runHook(root, { trusted: `/nonexistent/a:${root}:/nonexistent/b` });
  assert.strictEqual(code, 0);
  assert.ok(fs.existsSync(path.join(root, 'SHIM_RAN')), 'matched a non-first entry');
});

test('a linked worktree of a trusted repo is still trusted', { skip }, () => {
  // --git-common-dir, not --show-toplevel: a worktree has its own toplevel, so an
  // identity check on the toplevel would silently stop repairing the shim in worktrees.
  const root = repoWithShim();
  const wt = path.join(root, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: root, stdio: 'ignore' });
  const { code } = runHook(wt, { trusted: root });
  assert.strictEqual(code, 0);
  assert.ok(fs.existsSync(path.join(root, 'SHIM_RAN')), 'the owning repo was resolved from the worktree');
});

test('an untrusted worktree does not get the shim either', { skip }, () => {
  const root = repoWithShim();
  const wt = path.join(root, 'wt2');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side2', wt], { cwd: root, stdio: 'ignore' });
  const { code } = runHook(wt, { trusted: '/nonexistent/trusted/root' });
  assert.strictEqual(code, 0);
  assert.ok(!fs.existsSync(path.join(root, 'SHIM_RAN')));
});

test('injects branch and recent commits for a normal repo', { skip }, () => {
  const root = repoWithShim();
  const { out } = runHook(root, { trusted: '/nonexistent' });
  assert.match(out, /Branch: main/);
  assert.match(out, /Recent commits:/);
  assert.match(out, /init/, 'the commit subject shows up');
});

// `git status --porcelain` walks the whole working tree, so it is the one git call here whose
// cost grows with the repo, and it runs bounded (#661). One that does not finish is named,
// because silence reads as a clean tree. A PATH-stub git hangs on `status` only and hands
// every other verb to the real git.
function hungStatusGit() {
  const bin = fs.realpathSync(scratch(os.tmpdir(), 'sesctx-bin-'));
  const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash
[ "$1" = status ] && sleep 30
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

test('uncommitted changes are listed', { skip }, () => {
  const root = repoWithShim();
  fs.writeFileSync(path.join(root, 'README'), 'changed\n');
  const { out } = runHook(root, { trusted: '/nonexistent' });
  assert.match(out, /Uncommitted changes:\n M README/);
});

test('a hung git status is cut off inside the 5s hook timeout and named', { skip }, () => {
  const root = repoWithShim();
  const { out, code, seconds } = runHook(root, { trusted: '/nonexistent', extraEnv: hungStatusGit() });
  assert.ok(seconds < 5, `took ${seconds}s`);
  assert.strictEqual(code, 0);
  assert.match(out, /Uncommitted changes: not checked \(`git status` did not finish within 2s \(timeout\)\)/);
  assert.match(out, /Recent commits:/, 'the rest of the context is still injected');
});

test('a missing run-bounded.sh names the unchecked tree rather than running status unbounded', { skip }, () => {
  const root = repoWithShim();
  const { out } = runHook(root, {
    trusted: '/nonexistent', extraEnv: { RUN_BOUNDED_LIB: '/nonexistent/run-bounded.sh' },
  });
  assert.match(out, /Uncommitted changes: not checked \(cannot load \/nonexistent\/run-bounded\.sh\)/);
});

test('stays silent on a resumed session', { skip }, () => {
  const root = repoWithShim();
  const { out, code } = runHook(root, { trusted: root, source: 'resume' });
  assert.strictEqual(code, 0);
  assert.strictEqual(out.trim(), '', 'no context injected on resume');
  assert.ok(!fs.existsSync(path.join(root, 'SHIM_RAN')), 'and no shim run either');
});

test('exits quietly outside a git repo', { skip }, () => {
  const { out, code } = runHook(fs.realpathSync(scratch(os.tmpdir(), 'sesctx-')), { trusted: '/nonexistent' });
  assert.strictEqual(code, 0);
  assert.strictEqual(out.trim(), '');
});

// ── The transcript-leak banner ────────────────────────────────────────────────
//
// claude-transcript-scan writes ~/.claude/logs/transcript-leaks-pending because neither of
// its unattended callers keeps a verdict: session-end.sh backgrounds it, and the timer's
// journal line reaches nobody on a headless host. This hook is the reader. The pair below
// is the contract — it must speak when there is something to say, and stay silent otherwise.

function pendingFile(lines) {
  const f = path.join(fs.realpathSync(scratch(os.tmpdir(), 'sesctx-')), 'pending.tsv');
  fs.writeFileSync(f, lines.map((l) => l.join('\t')).join('\n') + '\n');
  return f;
}

test('untriaged credential findings are reported at session start', { skip }, () => {
  const root = repoWithShim();
  const f = pendingFile([
    ['2026-08-29T16:02:09Z', '2', '/home/u/.claude/logs/transcript-leaks.jsonl'],
    ['2026-08-29T16:45:03Z', '3', '/home/u/.claude/logs/transcript-leaks.jsonl'],
  ]);
  const { out, code } = runHook(root, { trusted: '/nonexistent', pending: f });
  assert.strictEqual(code, 0);
  assert.match(out, /SECURITY: 5 untriaged credential finding\(s\)/,
    'counts are summed across runs, not reported as the last run alone');
  assert.match(out, /16:45:03Z/, 'and dated by the most recent run');
  assert.match(out, /--clear-pending/, 'the banner names the way out');
});

test('a could-not-evaluate run is reported as such, not as a finding', { skip }, () => {
  const root = repoWithShim();
  const f = pendingFile([['2026-08-29T04:17:00Z', '0', 'no gitleaks binary']]);
  const { out } = runHook(root, { trusted: '/nonexistent', pending: f });
  // The distinction is the whole point: silence from a detector that never ran is
  // indistinguishable from a clean result, which is why exit 3 is not exit 0.
  assert.match(out, /could not run 1 time\(s\)/);
  assert.match(out, /no gitleaks binary/, 'and says what was missing');
  assert.doesNotMatch(out, /untriaged credential finding/,
    'a scan that did not run has found nothing — reporting it as a finding would be a lie');
});

test('no marker means no banner', { skip }, () => {
  const root = repoWithShim();
  const { out } = runHook(root, { trusted: '/nonexistent', pending: path.join(fs.realpathSync(scratch(os.tmpdir(), 'sesctx-')), 'absent') });
  assert.doesNotMatch(out, /SECURITY:/, 'a banner on every session is a banner nobody reads');
  assert.match(out, /=== Repo context ===/, 'the rest of the context still runs');
});

test('the banner does not depend on being inside a git repo', { skip }, () => {
  // Above the git check on purpose. A leaked credential is a fact about the machine, not
  // about the directory Claude was opened in, and gating it on a repo would hide it exactly
  // when you are not in one.
  const bare = fs.realpathSync(scratch(os.tmpdir(), 'sesctx-'));
  const f = pendingFile([['2026-08-29T16:45:03Z', '1', '/home/u/leaks.jsonl']]);
  const { out } = runHook(bare, { trusted: '/nonexistent', pending: f });
  assert.match(out, /SECURITY: 1 untriaged credential finding\(s\)/);
  assert.doesNotMatch(out, /=== Repo context ===/, 'and the git half still short-circuits');
});
