const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const HOOKS = srcPath('private_dot_claude', 'hooks');
const REFRESH = path.join(HOOKS, 'executable_artifact-refresh.sh');
const LINK = path.join(HOOKS, 'executable_link-artifact.sh');
const SEED = path.join(HOOKS, 'executable_artifact-session-seed.sh');
const TRACK = path.join(HOOKS, 'executable_artifact-commit-track.sh');
// The claude_guard package the tracker re-reads the command with, taken from the
// checkout rather than from whatever is deployed on this machine.
const GUARD = srcPath('dot_local', 'share', 'claude-guard');

// The parsed path needs a uv-MANAGED 3.14, which is not the interpreter
// actions/setup-python provides. Probing for `uv` alone would run the assertions on a
// machine where the hook silently takes its regex fallback.
const skipParsed = (() => {
  try {
    const r = spawnSync('uv',
      ['python', 'find', '--no-project', '--managed-python', '--system', '3.14'],
      { encoding: 'utf8' });
    return r.status === 0 && fs.existsSync((r.stdout || '').trim())
      ? false : 'no uv-managed 3.14';
  } catch { return 'no uv-managed 3.14'; }
})();

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function sh(cmd, cwd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.strictEqual(r.status, 0, `${cmd} (stderr: ${r.stderr})`);
  return (r.stdout || '').trim();
}

// A repo with an `origin` that is a real second repo, so refs/remotes/origin/* exist
// and the hook's upstream lookup behaves as it does on a live checkout.
function repoWithOrigin() {
  const root = scratch(os.tmpdir(), 'ar-');
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  sh(`git init -q --bare -b main ${remote}`);
  sh(`git clone -q ${remote} ${work}`);
  sh('git config user.email t@t && git config user.name t', work);
  sh('echo one > f && git add f && git commit -qm one && git push -q origin main', work);
  return { root, work };
}

// The first bug this file guarded was cross-worktree, so the fixture makes real ones --
// a second clone would not share refs/remotes/origin and could not reproduce it.
function worktree(work, root, name, branch) {
  const p = path.join(root, name);
  sh(`git worktree add -q -b ${branch} ${p}`, work);
  return p;
}

function gitCommit(wt, msg) {
  sh(`echo x >> ${msg}.txt && git add -A && git commit -qm '${msg}'`, wt);
}

// What bin/land does, minus the PR: rebase onto whatever main is now, then
// fast-forward origin's main onto the branch. The rebase is the reason the hook
// records subjects -- every SHA taken before it is dead afterwards.
function land(wt, branch) {
  sh(`git fetch -q origin && git rebase -q origin/main`, wt);
  sh(`git push -q origin ${branch}:main && git fetch -q origin`, wt);
}

function state(root) {
  const d = path.join(root, 'state');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Must match the hook byte for byte. `readlink -f x | sha1sum` is NOT the same --
// readlink emits a trailing newline and the hook hashes with printf '%s'.
function slug(dir, gitDirFlag) {
  return sh(`printf '%s' "$(readlink -f "$(git rev-parse ${gitDirFlag})")" | sha1sum | cut -c1-16`, dir);
}
const wtSlug = (dir) => slug(dir, '--git-dir');
const repoSlug = (dir) => slug(dir, '--git-common-dir');

// The per-session key: worktree slug folded with session_id, as artifact_session_key
// computes it.
function sessionSlug(dir, sessionId) {
  return sh(`printf '%s:%s' '${wtSlug(dir)}' '${sessionId}' | sha1sum | cut -c1-16`, dir);
}

// Seeds the registry the way link-artifact.sh would: the repo entry is the one a
// plan gets, so every worktree of the project inherits it.
function track(dir, stateDir, artifact, key = repoSlug(dir)) {
  fs.writeFileSync(path.join(stateDir, `${key}.current`), artifact);
  return key;
}

function artifactFile(root, name = 'plan.html') {
  const p = path.join(root, name);
  fs.writeFileSync(p, '<html>');
  return p;
}

const SID = 'session-1';

// Runs the Stop hook. `stopActive` mirrors the harness re-invoking it after it blocked.
function runRefresh(cwd, stateDir, { stopActive = false, sessionId = SID } = {}) {
  const input = JSON.stringify({ stop_hook_active: stopActive, session_id: sessionId });
  const r = spawnSync('bash', [REFRESH], {
    input, cwd, encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: stateDir },
  });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

// Runs the SessionStart hook that stamps where HEAD was when a session began. Every
// test starts its sessions through this, because that stamp is the floor the commit
// tracker measures against -- an unseeded session claims nothing at all, by design.
function runSeed(cwd, stateDir, sessionId = SID) {
  const r = spawnSync('bash', [SEED], {
    input: JSON.stringify({ session_id: sessionId }),
    cwd, encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: stateDir },
  });
  assert.strictEqual(r.status, 0, `seed hook exits 0 (stderr: ${r.stderr})`);
}

// One half of the commit tracker. The pair brackets a Bash call: `pre` stamps HEAD
// before it, `post` credits this session with what it added. This is the whole
// attribution mechanism -- a session that never runs it records nothing.
function runTrack(cwd, stateDir, mode,
  { sessionId = SID, cmd = 'git commit -qm x', guardHome = GUARD } = {}) {
  const r = spawnSync('bash', [TRACK, mode], {
    input: JSON.stringify({ session_id: sessionId, tool_input: { command: cmd } }),
    cwd, encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: stateDir, CLAUDE_GUARD_HOME: guardHome },
  });
  assert.strictEqual(r.status, 0, `track hook (${mode}) exits 0 (stderr: ${r.stderr})`);
  assert.strictEqual((r.stdout || '').trim(), '', `track hook (${mode}) says nothing`);
}

// A git-moving command run BY a session, bracketed by the hook pair the way the
// harness brackets a real Bash call.
function tracked(wt, stateDir, sessionId, cmd, run) {
  runTrack(wt, stateDir, 'pre', { sessionId, cmd });
  run();
  runTrack(wt, stateDir, 'post', { sessionId, cmd });
}

// A commit made BY a session.
function commit(wt, msg, stateDir, sessionId = SID) {
  if (!stateDir) return gitCommit(wt, msg);
  tracked(wt, stateDir, sessionId, `git commit -qm '${msg}'`, () => gitCommit(wt, msg));
}

function pendingOf(stateDir, dir, sessionId = SID) {
  const p = path.join(stateDir, `${sessionSlug(dir, sessionId)}.pending`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n') : [];
}

test('no registered artifact -> silent', () => {
  const { root, work } = repoWithOrigin();
  assert.strictEqual(runRefresh(work, state(root)), null, 'nothing tracked, nothing to say');
});

test('tracked artifact but no work of our own -> silent', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  runSeed(work, st);

  assert.strictEqual(runRefresh(work, st), null, 'nothing has landed, so nothing is owed');
  assert.deepStrictEqual(pendingOf(st, work), [], 'and there is nothing to remember');
});

test('our commits still unlanded -> silent, but remembered for when they land', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  commit(a, 'first-slice', st);

  assert.strictEqual(runRefresh(a, st), null, 'work in progress is not work that shipped');
  assert.deepStrictEqual(pendingOf(st, a), ['first-slice'], 'recorded against this session');
});

test('our commits landed -> blocks with a refresh instruction', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const art = artifactFile(root);
  track(work, st, art);
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  commit(a, 'first-slice', st);
  runRefresh(a, st);
  land(a, 'slice-one');

  const out = runRefresh(a, st);
  assert.ok(out, 'a landed slice is a refresh trigger');
  assert.strictEqual(out.decision, 'block', 'Stop hooks steer via decision:block');
  assert.match(out.reason, /AUTO-ARTIFACT REFRESH/);
  assert.match(out.reason, /first-slice/, 'names what landed');
  assert.match(out.reason, /data-status/, 'names the markup to update');
  assert.ok(out.reason.includes(art), 'names the artifact path');
  assert.match(out.reason, /do not invent status/i, 'gives an out when commits are unrelated');
});

// The originally reported bug: with the diff taken against upstream, everything
// another session landed arrived in your nudge as if you had written it.
test('another worktree landing -> silent here, and absent from our nudge', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  const b = worktree(work, root, 'wt-b', 'unrelated');
  runSeed(a, st);
  runSeed(b, st, 'session-b');

  commit(a, 'ours-first', st);
  commit(a, 'ours-second', st);
  commit(b, 'theirs', st, 'session-b');
  runRefresh(a, st);
  runRefresh(b, st, { sessionId: 'session-b' });

  land(b, 'unrelated');
  assert.strictEqual(runRefresh(a, st), null,
    'their landing is not ours, so it owes us no refresh');

  land(a, 'slice-one');
  const out = runRefresh(a, st);
  assert.ok(out, 'our own landing still fires');
  assert.match(out.reason, /ours-first/);
  assert.match(out.reason, /ours-second/);
  assert.doesNotMatch(out.reason, /theirs/, 'and carries none of their work');
});

// bin/land rebases before it fast-forwards main, so a SHA recorded pre-land names a
// commit that no longer exists. The nudge tells Claude to write the short SHA into
// the doc, so it has to be the one upstream actually has.
test('the reported SHA is the post-rebase one, not the pre-land one', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  const b = worktree(work, root, 'wt-b', 'unrelated');
  runSeed(a, st);

  commit(a, 'ours', st);
  const before = sh('git rev-parse --short HEAD', a);
  runRefresh(a, st);

  gitCommit(b, 'theirs');
  land(b, 'unrelated');
  land(a, 'slice-one');
  const after = sh('git rev-parse --short HEAD', a);
  assert.notStrictEqual(after, before, 'the rebase did move it, or this proves nothing');

  const out = runRefresh(a, st);
  assert.match(out.reason, new RegExp(after), 'names the SHA upstream has');
  assert.doesNotMatch(out.reason, new RegExp(before), 'not the one the rebase discarded');
});

// The case the feature exists for: one doc, three slices, each landing in turn. Slice
// two must not re-report slice one, which is already written up and already upstream.
test('successive slices from one worktree each report only themselves', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const artDir = path.join(root, 'home', '.claude', 'artifacts');
  fs.mkdirSync(artDir, { recursive: true });
  const art = path.join(artDir, 'plan.html');
  fs.writeFileSync(art, '<html>');
  const a = worktree(work, root, 'wt-a', 'slices');
  runSeed(a, st);

  const writeUp = () => {
    const r = spawnSync('bash', [LINK], {
      input: JSON.stringify({ tool_input: { file_path: art }, session_id: SID }),
      cwd: a, encoding: 'utf8',
      env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: st, CLAUDE_STATE_HOST_DIR: '' },
    });
    assert.strictEqual(r.status, 0, `link hook exits 0 (stderr: ${r.stderr})`);
  };
  writeUp();

  for (const [n, name] of [['one', 'slice-one'], ['two', 'slice-two'], ['three', 'slice-three']]) {
    commit(a, name, st);
    runRefresh(a, st);
    sh(`git fetch -q origin && git rebase -q origin/main`, a);
    sh(`git push -q origin slices:main && git fetch -q origin`, a);

    const out = runRefresh(a, st);
    assert.ok(out, `slice ${n} fires`);
    assert.match(out.reason, new RegExp(name), `slice ${n} names itself`);
    assert.match(out.reason, /^.*?REFRESH[^:]*: 1 commit/s, `slice ${n} reports one commit, not a running total`);
    writeUp();
    assert.strictEqual(runRefresh(a, st), null, `slice ${n} stops asking once written up`);
  }
});

test('a branch longer than the list cap says how many it left out', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  for (let i = 1; i <= 23; i++) commit(a, `c${i}`, st);
  runRefresh(a, st);
  land(a, 'slice-one');

  const out = runRefresh(a, st);
  assert.match(out.reason, /23 commit/, 'counts every one of them');
  assert.match(out.reason, /and 3 more/, 'and says what the list left out');
});

// `bin/try --back` returns the primary checkout to main, and an abandoned branch ends
// the same way: pending work, nothing upstream to show for it.
test('pending work that never landed -> silent', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  commit(a, 'abandoned', st);
  runRefresh(a, st);
  sh('git reset -q --hard origin/main', a);

  assert.strictEqual(runRefresh(a, st), null, 'nothing shipped, so nothing to report');
});

test('stop_hook_active -> silent, so a block cannot loop', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  commit(a, 'first-slice', st);
  runRefresh(a, st);
  land(a, 'slice-one');

  assert.strictEqual(runRefresh(a, st, { stopActive: true }), null,
    'one forced continue is enough');
});

test('artifact deleted (pruned) -> silent rather than resurrecting it', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, path.join(root, 'gone.html'));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  commit(a, 'first-slice', st);
  runRefresh(a, st);
  land(a, 'slice-one');

  assert.strictEqual(runRefresh(a, st), null, 'a pruned artifact stops being tracked');
});

test('a worktree that wrote its own artifact tracks that one, not the project plan', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root, 'project-plan.html'));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  const own = artifactFile(root, 'my-own.html');
  track(a, st, own, wtSlug(a));
  runSeed(a, st);
  commit(a, 'first-slice', st);
  runRefresh(a, st);
  land(a, 'slice-one');

  const out = runRefresh(a, st);
  assert.ok(out.reason.includes(own), 'the worktree entry wins');
  assert.ok(!out.reason.includes('project-plan.html'), 'the repo entry is the fallback only');
});

// The pair has to actually compose: link-artifact registers under both keys and clears
// the pending list, so the very next Stop is silent -- the artifact is up to date by
// definition the moment it is written.
test('link-artifact registers the .html under both keys and clears pending', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  commit(a, 'first-slice', st);
  runRefresh(a, st);
  land(a, 'slice-one');

  const artDir = path.join(root, 'home', '.claude', 'artifacts');
  fs.mkdirSync(artDir, { recursive: true });
  const art = path.join(artDir, 'plan.html');
  fs.writeFileSync(art, '<html>');

  const r = spawnSync('bash', [LINK], {
    input: JSON.stringify({ tool_input: { file_path: art }, session_id: SID }),
    cwd: a, encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: st, CLAUDE_STATE_HOST_DIR: '' },
  });
  assert.strictEqual(r.status, 0, `link hook exits 0 (stderr: ${r.stderr})`);

  for (const key of [wtSlug(a), repoSlug(a)]) {
    assert.strictEqual(fs.readFileSync(path.join(st, `${key}.current`), 'utf8').trim(), art,
      'tracked under both the worktree and the project');
  }
  assert.deepStrictEqual(pendingOf(st, a), [], 'the landed slice is now written up');
  assert.strictEqual(runRefresh(a, st), null, 'so a freshly written artifact owes no refresh');
});

// Two sessions sharing ONE worktree (no `git worktree add` between them -- most
// sessions work directly in the primary checkout), where B does nothing at all.
test('another session in the SAME worktree landing -> silent, not misattributed', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));

  runSeed(work, st, 'session-b');
  runRefresh(work, st, { sessionId: 'session-b' });

  runSeed(work, st, 'session-a');
  sh('git checkout -qb slice-one', work);
  commit(work, 'ours-only', st, 'session-a');
  runRefresh(work, st, { sessionId: 'session-a' });
  land(work, 'slice-one');

  const outA = runRefresh(work, st, { sessionId: 'session-a' });
  assert.ok(outA, 'session A landed its own commit');
  assert.match(outA.reason, /ours-only/);

  const outB = runRefresh(work, st, { sessionId: 'session-b' });
  assert.strictEqual(outB, null, "another session's landing in the same worktree owes us no refresh");
});

// The bug the tip-delta scheme exists for, and the one a startup snapshot could not
// reach: B is not idle, it is Stopping between turns while A's work is still
// UNLANDED. The snapshot scheme wrote A's commit into B's pending list at that Stop
// (B started on a clean master, so its baseline was empty and subtracted nothing),
// then nudged B about it the moment A landed. Attribution by tool call means B never
// recorded the commit in the first place.
test("a sibling's unlanded commit is never adopted by a session that Stops beside it", () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));

  // Both sessions start clean, on the same branch in the same checkout.
  runSeed(work, st, 'session-a');
  runSeed(work, st, 'session-b');
  sh('git checkout -qb shared', work);

  // A commits. B takes a turn and Stops while that commit is still unlanded --
  // exactly when the old scheme adopted it.
  commit(work, 'a-only', st, 'session-a');
  runRefresh(work, st, { sessionId: 'session-a' });
  assert.strictEqual(runRefresh(work, st, { sessionId: 'session-b' }), null,
    'B has committed nothing, so B has nothing pending');
  assert.deepStrictEqual(pendingOf(st, work, 'session-b'), [],
    "and A's in-flight commit was not written into B's pending list");

  land(work, 'shared');

  const outB = runRefresh(work, st, { sessionId: 'session-b' });
  assert.strictEqual(outB, null, "A's landing is not B's to write up");

  const outA = runRefresh(work, st, { sessionId: 'session-a' });
  assert.ok(outA, 'while A, who wrote it, is still nudged');
  assert.match(outA.reason, /a-only/);
});

// Same shape, but both sessions are committing -- each nudge must carry only its own
// subjects, not the union of whatever the shared branch happens to hold.
test('two committing sessions in one checkout each report only their own commits', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));

  runSeed(work, st, 'session-a');
  runSeed(work, st, 'session-b');
  sh('git checkout -qb shared', work);

  commit(work, 'a-first', st, 'session-a');
  commit(work, 'b-first', st, 'session-b');
  commit(work, 'a-second', st, 'session-a');
  runRefresh(work, st, { sessionId: 'session-a' });
  runRefresh(work, st, { sessionId: 'session-b' });
  land(work, 'shared');

  const outA = runRefresh(work, st, { sessionId: 'session-a' });
  assert.match(outA.reason, /a-first/);
  assert.match(outA.reason, /a-second/);
  assert.doesNotMatch(outA.reason, /b-first/, "A does not claim B's commit");
  assert.match(outA.reason, /: 2 commit/, 'and counts only its own');

  const outB = runRefresh(work, st, { sessionId: 'session-b' });
  assert.match(outB.reason, /b-first/);
  assert.doesNotMatch(outB.reason, /a-first/, "B does not claim A's commits");
  assert.match(outB.reason, /: 1 commit/);
});

// A pull that fast-forwards someone else's already-pushed commits into HEAD moves the
// tip past them; `--not <upstream>` is what stops them being credited to this session
// on the way through.
test('pulling upstream commits credits none of them to this session', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  const b = worktree(work, root, 'wt-b', 'unrelated');
  runSeed(a, st);

  gitCommit(b, 'theirs');
  land(b, 'unrelated');

  tracked(a, st, SID, 'git pull --ff-only',
    () => sh('git fetch -q origin && git merge -q --ff-only origin/main', a));

  commit(a, 'ours', st);
  runRefresh(a, st);
  land(a, 'slice-one');

  const out = runRefresh(a, st);
  assert.match(out.reason, /ours/);
  assert.doesNotMatch(out.reason, /theirs/, 'a pulled commit is not authorship');
  assert.match(out.reason, /: 1 commit/);
});

// `post` with no `pre` and no SessionStart stamp -- the shape of hooks installed
// midway through a session. With no floor to measure against, the branch could be
// anyone's, so it claims nothing rather than claiming all of it.
test('a post with no floor stays silent instead of adopting the branch', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');

  // No runSeed, and no `pre` half.
  gitCommit(a, 'not-ours');
  runTrack(a, st, 'post', { sessionId: 'unseeded', cmd: "git commit -qm 'not-ours'" });
  runRefresh(a, st, { sessionId: 'unseeded' });
  land(a, 'slice-one');

  assert.strictEqual(runRefresh(a, st, { sessionId: 'unseeded' }), null,
    'no floor means no claim');
});

// The tracker exits on a string match, so the overwhelmingly common Bash call costs
// no git process -- and claims nothing either.
test('a non-commit-shaped command records nothing', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  tracked(a, st, SID, 'ls -la', () => gitCommit(a, 'sneaky'));

  const mine = path.join(st, `${sessionSlug(a, SID)}.mine`);
  assert.strictEqual(fs.existsSync(mine), false, 'nothing claimed off an unrelated command');
});

// The nudge has to be answerable. Rewriting the artifact clears pending through
// link-artifact.sh, but the reason text also invites a session to answer in one line and
// stop when the commits are unrelated, and that path writes no .html. Leaving pending
// intact then fired the identical block on every following Stop until the state file
// aged out at 7 days -- one session took it three times on 2026-08-18.
test('a landed set is nudged once, not on every following Stop', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  commit(a, 'first-slice', st);
  runRefresh(a, st);
  land(a, 'slice-one');

  assert.ok(runRefresh(a, st), 'the landing raises the nudge');
  assert.strictEqual(runRefresh(a, st), null, 'the next Stop is silent');
  assert.deepStrictEqual(pendingOf(st, a), [], 'the reported set is retired');
});

// How a sibling's commit was adopted: B ran something read-only that merely mentioned a
// commit -- `head -20 bin/land`, `git show <sha>` -- which matched the old word list and
// opened a `post` window. A committed into the shared checkout inside it, and B's `post`
// read A's HEAD movement as its own work.
test('a read-only command that names a commit opens no window', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const B = 'session-b';
  runSeed(work, st, SID);
  runSeed(work, st, B);
  tracked(work, st, B, 'head -20 bin/land 2>/dev/null | cut -c1-150',
    () => commit(work, 'a-slice', st, SID));

  const mineB = path.join(st, `${sessionSlug(work, B)}.mine`);
  assert.strictEqual(fs.existsSync(mineB), false, 'the reader claims none of the committer work');
  assert.deepStrictEqual(
    fs.readFileSync(path.join(st, `${sessionSlug(work, SID)}.mine`), 'utf8').trim().split('\n'),
    ['a-slice'], 'and the committer still claims its own');
});

// Most sessions here work directly in the primary checkout, where `git rev-parse
// --git-dir` and `--git-common-dir` both answer `.git`. The worktree and repo slugs are
// then the same string, so the worktree entry could not stop a session being aimed at
// whichever doc another session registered last. The session entry can.
test('a session that wrote its own artifact is not aimed at another session doc', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root, 'their-plan.html'));
  const own = artifactFile(root, 'my-plan.html');
  track(work, st, own, sessionSlug(work, SID));
  runSeed(work, st);
  commit(work, 'first-slice', st);
  runRefresh(work, st);
  land(work, 'HEAD');

  const out = runRefresh(work, st);
  assert.ok(out, 'the landing still raises a nudge');
  assert.ok(out.reason.includes(own), 'the session entry wins');
  assert.ok(!out.reason.includes('their-plan.html'), 'the repo entry stays the fallback');
});

// The command that actually held the window open on 2026-08-18: a session syncing its
// checkout after a sibling landed. It moves HEAD without authoring anything, so it
// advances the floor and claims nothing that arrives while it runs.
test('a sync command adopts nothing a sibling commits inside it', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const B = 'session-b';
  runSeed(work, st, SID);
  runSeed(work, st, B);
  tracked(work, st, B,
    'git checkout main -q && git fetch origin main -q && git merge --ff-only origin/main -q',
    () => commit(work, 'a-slice', st, SID));

  const mineB = path.join(st, `${sessionSlug(work, B)}.mine`);
  assert.strictEqual(fs.existsSync(mineB), false, 'the syncing session claims nothing');
  assert.deepStrictEqual(
    fs.readFileSync(path.join(st, `${sessionSlug(work, SID)}.mine`), 'utf8').trim().split('\n'),
    ['a-slice'], 'and the committer still claims its own');
});

// ── the verb has to be a COMMAND, not a substring ──────────────────────────────────
//
// The text filter reads the raw command, so it matches the verb inside another
// command's quoted argument. `gh pr create --body "run git rebase first"` is the shape
// that costs: it opens a `post` window measured from a HEAD several commands old, which
// is exactly how a sibling's commit was adopted on 2026-08-18. claude_guard.segment
// re-reads the command and the verb is matched against each segment's own argv.
test('a verb quoted inside another command opens no window', { skip: skipParsed }, () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const B = 'session-b';
  runSeed(work, st, SID);
  runSeed(work, st, B);
  tracked(work, st, B, 'gh pr create --title x --body "run git rebase first"',
    () => commit(work, 'a-slice', st, SID));

  const mineB = path.join(st, `${sessionSlug(work, B)}.mine`);
  assert.strictEqual(fs.existsSync(mineB), false, 'the quoting session claims nothing');
  assert.deepStrictEqual(
    fs.readFileSync(path.join(st, `${sessionSlug(work, SID)}.mine`), 'utf8').trim().split('\n'),
    ['a-slice'], 'and the committer still claims its own');
});

// The other half of the pair. Tightening the match must not stop the shapes a commit
// is actually written in from being seen -- a missed one loses the session's own work
// from the write-up, which is the failure the tracker exists to prevent.
test('the shapes a commit is really written in are still claimed', { skip: skipParsed }, () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  for (const [i, cmd] of [
    "env GIT_AUTHOR_NAME=t git commit -qm 'one'",
    "git -C . commit -qm 'two'",
    "(git commit -qm 'three')",
    "FOO=1 ./bin/land",   // land authors through a rebase; the invocation is what counts
  ].entries()) {
    tracked(a, st, SID, cmd, () => gitCommit(a, `sub${i}`));
  }
  assert.deepStrictEqual(
    fs.readFileSync(path.join(st, `${sessionSlug(a, SID)}.mine`), 'utf8').trim().split('\n'),
    ['sub0', 'sub1', 'sub2', 'sub3'], 'every commit-authoring shape is claimed');
});

// The parser is an improvement, never a dependency. With no claude_guard package the
// text filter's verdict stands, which is what this hook did before it.
test('with no claude_guard package the text filter still claims a commit', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const a = worktree(work, root, 'wt-a', 'slice-one');
  runSeed(a, st);
  const noguard = path.join(root, 'no-such-claude-guard');
  runTrack(a, st, 'pre', { cmd: "git commit -qm 'x'", guardHome: noguard });
  gitCommit(a, 'kept');
  runTrack(a, st, 'post', { cmd: "git commit -qm 'x'", guardHome: noguard });
  assert.deepStrictEqual(
    fs.readFileSync(path.join(st, `${sessionSlug(a, SID)}.mine`), 'utf8').trim().split('\n'),
    ['kept'], 'the fallback records the commit');
});
