// SessionStart(source=compact) is the only thing that re-primes the model after a
// compaction: PreCompact's payload goes to the user via systemMessage, never into the
// model's context. The hook was gated to `startup` in both the script and its matcher,
// so nothing ran at the one moment the context had just been discarded (A3-01/A3-02).
//
// Drives the real hook against a scratch repo, and asserts the matcher in the settings
// template still names `compact` — the script and the registration have to agree, and
// either one alone silently does nothing.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The repo's pre-push hook exports GIT_DIR/GIT_WORK_TREE, which would point the hook's
// git calls at the outer repo instead of the fixture.
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_NAMESPACE']) {
  delete process.env[v];
}

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_session-context.sh');
const SETTINGS = path.join(__dirname, '..', 'home', '.chezmoitemplates', 'settings.base.json');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq && command -v git'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq/git unavailable';

const cleanups = [];
after(() => { for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true }); });

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sesctx-'));
  cleanups.push(d);
  const git = (...args) => execFileSync('git', args, { cwd: d, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return d;
}

function run(cwd, source) {
  return execFileSync('bash', [HOOK], {
    cwd, encoding: 'utf8', input: JSON.stringify({ source, cwd }),
  });
}

test('source=compact produces context, where it used to produce nothing', { skip }, () => {
  const d = repo();
  const out = run(d, 'compact');
  assert.notStrictEqual(out.trim(), '', 'compaction must not leave the model with no state');
  assert.match(out, /Branch:|branch/i);
});

test('source=compact says the state is ground truth and names what it cannot recover', { skip }, () => {
  const d = repo();
  const out = run(d, 'compact');
  assert.match(out, /compaction/i);
  assert.match(out, /verbatim/i, 'the preserve-verbatim rule has to survive the boundary');
  assert.match(out, /Test pass\/fail|next steps/i, 'must name what it cannot re-derive');
});

test('source=startup still works and stays free of the compaction note', { skip }, () => {
  const d = repo();
  const out = run(d, 'startup');
  assert.match(out, /Recent commits:/);
  assert.doesNotMatch(out, /compaction/i);
});

test('a resume is still skipped', { skip }, () => {
  const d = repo();
  assert.strictEqual(run(d, 'resume').trim(), '');
});

test('the SessionStart matcher names compact, not startup alone', { skip }, () => {
  // The script and the registration have to agree; either alone is a silent no-op.
  const src = fs.readFileSync(SETTINGS, 'utf8');
  const block = src.slice(src.indexOf('"SessionStart"'));
  const matcher = block.slice(0, block.indexOf('session-context.sh')).match(/"matcher":\s*"([^"]+)"/);
  assert.ok(matcher, 'session-context.sh must be registered under a matcher');
  assert.match(matcher[1], /\bcompact\b/, `matcher "${matcher[1]}" must include compact`);
  assert.match(matcher[1], /\bstartup\b/);
});
