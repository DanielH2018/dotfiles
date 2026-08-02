// Regression guard for executable_pre-compact.sh (PreCompact).
// Drives the ACTUAL hook against fixture transcripts and asserts it re-injects the state the
// CLAUDE.md compaction policy asks to preserve: trigger kind, push state, files modified, and
// test commands run. The headline guard is `manual` — the hook was registered auto-only and so
// never ran at the moment it was most needed. Offline and deterministic. Skips without bash/jq.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Under the repo's pre-push hook git exports GIT_DIR/GIT_WORK_TREE into the environment, which
// would point the hook's `git` calls at the outer repo instead of each fixture.
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_NAMESPACE']) {
  delete process.env[v];
}

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_pre-compact.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const cleanups = [];
after(() => { for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanups.push(d); return d; }

// Build a transcript from tool_use descriptors: ['Edit', '/a.js'] or ['Bash', 'npm test'].
function transcript(entries) {
  const dir = tmp('precompact-');
  const file = path.join(dir, 'transcript.jsonl');
  const lines = entries.map(([name, arg]) => JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        name,
        input: name === 'Bash' ? { command: arg } : { file_path: arg },
      }],
    },
  }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Run the hook in `cwd` (defaults to a non-repo dir so git output stays out of the way).
function run({ trigger = 'auto', transcript_path = '', cwd } = {}) {
  const payload = {};
  if (trigger !== null) payload.trigger = trigger;
  if (transcript_path) payload.transcript_path = transcript_path;
  let out;
  try {
    out = execFileSync('bash', [HOOK], {
      input: JSON.stringify(payload),
      cwd: cwd || tmp('precompact-cwd-'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) { out = e.stdout || ''; }
  return JSON.parse(out);
}

test('emits valid hook JSON that lets compaction proceed', { skip }, () => {
  const r = run();
  assert.strictEqual(r.continue, true);
  assert.ok(typeof r.systemMessage === 'string' && r.systemMessage.length > 0);
});

// The bug this whole change exists to fix.
test('distinguishes manual /compact from auto-compact', { skip }, () => {
  assert.match(run({ trigger: 'manual' }).systemMessage, /Manual \/compact proceeding/);
  assert.match(run({ trigger: 'auto' }).systemMessage, /Auto-compact proceeding/);
});

test('defaults to auto when no trigger is supplied', { skip }, () => {
  assert.match(run({ trigger: null }).systemMessage, /Auto-compact proceeding/);
});

test('lists files modified, deduped and scratch-filtered', { skip }, () => {
  const t = transcript([
    ['Edit', '/repo/src/a.js'],
    ['Edit', '/repo/src/a.js'],          // duplicate collapses
    ['Write', '/repo/src/b.js'],
    ['Bash', 'ls'],                       // not a file edit
    ['Write', '/tmp/scratch.sh'],         // scratch, excluded
    ['Write', '/home/u/.claude/jobs/abc123/tmp/probe.sh'], // job scratch, excluded
  ]);
  const msg = run({ transcript_path: t }).systemMessage;
  assert.match(msg, /Files modified this session \(2\)/);
  assert.match(msg, /\/repo\/src\/a\.js/);
  assert.match(msg, /\/repo\/src\/b\.js/);
  assert.ok(!msg.includes('/tmp/scratch.sh'), 'plain /tmp scratch should be filtered');
  assert.ok(!msg.includes('probe.sh'), 'job tmp scratch should be filtered');
});

test('caps the file list and reports the overflow count', { skip }, () => {
  const entries = Array.from({ length: 30 }, (_, i) => ['Edit', `/repo/f${String(i).padStart(2, '0')}.js`]);
  const msg = run({ transcript_path: transcript(entries) }).systemMessage;
  assert.match(msg, /Files modified this session \(30\)/);
  assert.match(msg, /\.\.\. and 5 more/);
});

test('surfaces test commands and ignores ordinary shell calls', { skip }, () => {
  const t = transcript([
    ['Bash', 'git status'],
    ['Bash', 'npm test'],
    ['Bash', 'node --test tests/foo.test.js'],
    ['Bash', 'ls -la /etc'],
    ['Bash', 'pytest -q'],
  ]);
  const msg = run({ transcript_path: t }).systemMessage;
  assert.match(msg, /Test commands run/);
  assert.match(msg, /npm test/);
  assert.match(msg, /node --test tests\/foo\.test\.js/);
  assert.match(msg, /pytest -q/);
  assert.ok(!msg.includes('ls -la /etc'), 'non-test commands should not be listed');
});

test('truncates long test commands so the injection stays cheap', { skip }, () => {
  const long = 'cd /some/very/long/path && ' + 'x'.repeat(300) + ' && npm test';
  const msg = run({ transcript_path: transcript([['Bash', long]]) }).systemMessage;
  const line = msg.split('\n').find((l) => l.includes('/some/very/long/path'));
  assert.ok(line, 'the long command should still appear');
  assert.ok(line.trim().length <= 120, `expected <=120 chars, got ${line.trim().length}`);
});

test('reports test results as unverified rather than asserting them', { skip }, () => {
  const msg = run({ transcript_path: transcript([['Bash', 'npm test']]) }).systemMessage;
  assert.match(msg, /re-run to confirm status, do not assume it from here/);
});

test('always asks for corrections and errors to survive verbatim', { skip }, () => {
  assert.match(run().systemMessage, /Preserve verbatim.*user corrections/s);
});

test('survives a missing, unreadable, or malformed transcript', { skip }, () => {
  assert.strictEqual(run({ transcript_path: '/nonexistent/nope.jsonl' }).continue, true);

  const dir = tmp('precompact-bad-');
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, 'not json at all\n{"partial":\n' + JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/good.js' } }] },
  }) + '\n');
  const r = run({ transcript_path: bad });
  assert.strictEqual(r.continue, true);
  assert.match(r.systemMessage, /\/repo\/good\.js/, 'valid lines still parse around malformed ones');
});

test('reports push state for an unpushed branch', { skip }, () => {
  const repo = tmp('precompact-repo-');
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hi\n');
  git(['add', 'f.txt']);
  git(['commit', '-qm', 'seed']);

  const msg = run({ cwd: repo }).systemMessage;
  assert.match(msg, /branch: main/);
  assert.match(msg, /NOT pushed — no upstream set/);
  assert.match(msg, /seed/, 'recent commits should be listed');
});

test('flags uncommitted work', { skip }, () => {
  const repo = tmp('precompact-dirty-');
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'hi\n');
  git(['add', 'f.txt']);
  git(['commit', '-qm', 'seed']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'changed\n');

  assert.match(run({ cwd: repo }).systemMessage, /Uncommitted changes:[\s\S]*f\.txt/);
});
