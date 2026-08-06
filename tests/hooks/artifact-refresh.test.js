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

function state(root) {
  const d = path.join(root, 'state');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Must match artifact_repo_slug byte for byte. `readlink -f x | sha1sum` is NOT the
// same -- readlink emits a trailing newline and the hook hashes with printf '%s'.
function slugOf(work) {
  return sh(`printf '%s' "$(readlink -f "$(git rev-parse --git-common-dir)")" | sha1sum | cut -c1-16`, work);
}

// Seeds the registry the way link-artifact.sh would.
function track(work, stateDir, artifact, { baseline = true } = {}) {
  const slug = slugOf(work);
  fs.writeFileSync(path.join(stateDir, `${slug}.current`), artifact);
  if (baseline) {
    fs.writeFileSync(path.join(stateDir, `${slug}.sha`), sh('git rev-parse refs/remotes/origin/main', work));
  }
  return slug;
}

// Runs the Stop hook. `stopActive` mirrors the harness re-invoking it after it blocked.
function runRefresh(work, stateDir, { stopActive = false } = {}) {
  const input = JSON.stringify({ stop_hook_active: stopActive });
  const r = spawnSync('bash', [REFRESH], {
    input, cwd: work, encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: stateDir },
  });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

function landCommit(work, msg) {
  sh(`echo ${msg} >> f && git add f && git commit -qm ${msg} && git push -q origin main`, work);
  sh('git fetch -q origin', work);
}

test('no registered artifact -> silent', () => {
  const { root, work } = repoWithOrigin();
  assert.strictEqual(runRefresh(work, state(root)), null, 'nothing tracked, nothing to say');
});

test('registered artifact but upstream unmoved -> silent', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const art = path.join(root, 'plan.html');
  fs.writeFileSync(art, '<html>');
  track(work, st, art);

  assert.strictEqual(runRefresh(work, st), null, 'no new commits means no refresh owed');
});

test('commits landed since the artifact -> blocks with a refresh instruction', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const art = path.join(root, 'plan.html');
  fs.writeFileSync(art, '<html>');
  track(work, st, art);

  landCommit(work, 'two');
  const out = runRefresh(work, st);
  assert.ok(out, 'a landed commit is a refresh trigger');
  assert.strictEqual(out.decision, 'block', 'Stop hooks steer via decision:block');
  assert.match(out.reason, /AUTO-ARTIFACT REFRESH/);
  assert.match(out.reason, /data-status/, 'names the markup to update');
  assert.ok(out.reason.includes(art), 'names the artifact path');
  assert.match(out.reason, /do not invent status/i, 'gives an out when commits are unrelated');
});

test('stop_hook_active -> silent, so a block cannot loop', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const art = path.join(root, 'plan.html');
  fs.writeFileSync(art, '<html>');
  track(work, st, art);
  landCommit(work, 'two');

  assert.strictEqual(runRefresh(work, st, { stopActive: true }), null,
    'one forced continue is enough');
});

test('artifact deleted (pruned) -> silent rather than resurrecting it', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  track(work, st, path.join(root, 'gone.html'));
  landCommit(work, 'two');

  assert.strictEqual(runRefresh(work, st), null, 'a pruned artifact stops being tracked');
});

test('no baseline SHA -> adopts head silently instead of firing on all history', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const art = path.join(root, 'plan.html');
  fs.writeFileSync(art, '<html>');
  const slug = track(work, st, art, { baseline: false });
  landCommit(work, 'two');

  assert.strictEqual(runRefresh(work, st), null, 'an artifact predating the hook is adopted quietly');
  assert.strictEqual(fs.readFileSync(path.join(st, `${slug}.sha`), 'utf8').trim(),
    sh('git rev-parse refs/remotes/origin/main', work), 'and the baseline is now seeded');
});

// The pair has to actually compose: link-artifact registers and seeds, so the very next
// Stop is silent -- the artifact is up to date by definition the moment it is written.
test('link-artifact registers the .html and seeds the baseline', () => {
  const { root, work } = repoWithOrigin();
  const st = state(root);
  const artDir = path.join(root, 'home', '.claude', 'artifacts');
  fs.mkdirSync(artDir, { recursive: true });
  const art = path.join(artDir, 'plan.html');
  fs.writeFileSync(art, '<html>');

  const r = spawnSync('bash', [LINK], {
    input: JSON.stringify({ tool_input: { file_path: art } }),
    cwd: work, encoding: 'utf8',
    env: { ...process.env, CLAUDE_ARTIFACT_STATE_DIR: st, CLAUDE_STATE_HOST_DIR: '' },
  });
  assert.strictEqual(r.status, 0, `link hook exits 0 (stderr: ${r.stderr})`);

  const slug = slugOf(work);
  assert.strictEqual(fs.readFileSync(path.join(st, `${slug}.current`), 'utf8').trim(), art,
    'the .html is now this repo tracked artifact');
  assert.strictEqual(fs.readFileSync(path.join(st, `${slug}.sha`), 'utf8').trim(),
    sh('git rev-parse refs/remotes/origin/main', work), 'baseline seeded at write time');

  assert.strictEqual(runRefresh(work, st), null, 'so a freshly written artifact owes no refresh');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
