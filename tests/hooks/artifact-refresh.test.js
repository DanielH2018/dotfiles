const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOKS = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const REFRESH = path.join(HOOKS, 'executable_artifact-refresh.sh');
const LINK = path.join(HOOKS, 'executable_link-artifact.sh');

const dirs = [];

function sh(cmd, cwd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${cmd} (stderr: ${r.stderr})`);
  return (r.stdout || '').trim();
}

// A repo with an `origin` that is a real second repo, so refs/remotes/origin/* exist
// and the hook's upstream lookup behaves as it does on a live checkout.
function repoWithOrigin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-'));
  dirs.push(root);
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  sh(`git init -q --bare -b main ${remote}`);
  sh(`git clone -q ${remote} ${work}`);
  sh('git config user.email t@t && git config user.name t', work);
  sh('echo one > f && git add f && git commit -qm one && git push -q origin main', work);
  return { root, work };
}

// The bug this file guards is cross-worktree, so the fixture has to make real ones --
// a second clone would not share refs/remotes/origin and could not reproduce it.
function worktree(work, root, name, branch) {
  const p = path.join(root, name);
  sh(`git worktree add -q -b ${branch} ${p}`, work);
  return p;
}

function commit(wt, msg) {
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

// Runs the Stop hook. `stopActive` mirrors the harness re-invoking it after it blocked.
function runRefresh(cwd, stateDir, { stopActive = false } = {}) {
  const input = JSON.stringify({ stop_hook_active: stopActive });
  const r = spawnSync('bash', [REFRESH], {
    input, cwd, encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: stateDir },
  });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

function pendingOf(stateDir, dir) {
  const p = path.join(stateDir, `${wtSlug(dir)}.pending`);
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

  assert.strictEqual(runRefresh(work, st), null, 'nothing has landed, so nothing is owed');
  assert.deepStrictEqual(pendingOf(st, work), [], 'and there is nothing to remember');
});

test('our commits still unlanded -> silent, but remembered for when they land', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  commit(a, 'first-slice');

  assert.strictEqual(runRefresh(a, st), null, 'work in progress is not work that shipped');
  assert.deepStrictEqual(pendingOf(st, a), ['first-slice'], 'recorded against this worktree');
});

test('our commits landed -> blocks with a refresh instruction', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const art = artifactFile(root);
  track(work, st, art);
  const a = worktree(work, root, 'wt-a', 'slice-one');
  commit(a, 'first-slice');
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

// The reported bug: with the diff taken against upstream, everything another session
// landed arrived in your nudge as if you had written it.
test('another worktree landing -> silent here, and absent from our nudge', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  const b = worktree(work, root, 'wt-b', 'unrelated');

  commit(a, 'ours-first');
  commit(a, 'ours-second');
  commit(b, 'theirs');
  runRefresh(a, st);
  runRefresh(b, st);

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

  commit(a, 'ours');
  const before = sh('git rev-parse --short HEAD', a);
  runRefresh(a, st);

  commit(b, 'theirs');
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

  const writeUp = () => {
    const r = spawnSync('bash', [LINK], {
      input: JSON.stringify({ tool_input: { file_path: art } }),
      cwd: a, encoding: 'utf8',
      env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: st, CLAUDE_STATE_HOST_DIR: '' },
    });
    assert.strictEqual(r.status, 0, `link hook exits 0 (stderr: ${r.stderr})`);
  };
  writeUp();

  for (const [n, name] of [['one', 'slice-one'], ['two', 'slice-two'], ['three', 'slice-three']]) {
    commit(a, name);
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
  for (let i = 1; i <= 23; i++) commit(a, `c${i}`);
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
  commit(a, 'abandoned');
  runRefresh(a, st);
  sh('git reset -q --hard origin/main', a);

  assert.strictEqual(runRefresh(a, st), null, 'nothing shipped, so nothing to report');
});

test('stop_hook_active -> silent, so a block cannot loop', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, artifactFile(root));
  const a = worktree(work, root, 'wt-a', 'slice-one');
  commit(a, 'first-slice');
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
  commit(a, 'first-slice');
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
  commit(a, 'first-slice');
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
  commit(a, 'first-slice');
  runRefresh(a, st);
  land(a, 'slice-one');

  const artDir = path.join(root, 'home', '.claude', 'artifacts');
  fs.mkdirSync(artDir, { recursive: true });
  const art = path.join(artDir, 'plan.html');
  fs.writeFileSync(art, '<html>');

  const r = spawnSync('bash', [LINK], {
    input: JSON.stringify({ tool_input: { file_path: art } }),
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

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
