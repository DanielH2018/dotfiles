// Regression guard for executable_memory-stale-paths.py (SessionStart).
//
// Every test here is a PAIR: one input the hook must report and one it must stay quiet
// about. That shape is the point. This hook is only ever observed passing — it prints
// nothing on a healthy tree — so a rule that silently stopped matching would look
// exactly like a clean run. Measured on 2026-08-29, before the fixes these tests pin,
// it reported three memories and every one was a deliberate mention, while both of the
// genuinely stale paths on the machine went unreported. It read green throughout.
//
// Runs the ACTUAL hook against a throwaway git repo and a throwaway CLAUDE_CONFIG_DIR.
// Offline. Skips cleanly when python3 or git are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_memory-stale-paths.py');

let toolsOk = true;
let python = 'python3';
try {
  execFileSync(python, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' });
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch { toolsOk = false; }
const skip = toolsOk ? false : 'python3 >= 3.10 or git unavailable';

const dirs = [];
function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return fs.realpathSync(d);
}

// A repo with `scripts/` and `docs/` populated, plus a memory directory holding one
// memory. Returns what the hook prints for it.
//
// The hook derives the memory directory from the repo path, replacing every separator
// with a dash — so the fixture has to name the directory the same way rather than
// picking one.
function report(memoryText, { files = ['scripts/live.py'], repoDir = null } = {}) {
  const repo = repoDir || tmpdir('memstale-repo-');
  if (!repoDir) {
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    for (const rel of files) {
      fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), '');
    }
  }
  const config = tmpdir('memstale-cfg-');
  const memories = path.join(config, 'projects', repo.split(path.sep).join('-'), 'memory');
  fs.mkdirSync(memories, { recursive: true });
  fs.writeFileSync(path.join(memories, 'a-memory.md'), memoryText);
  return execFileSync(python, [HOOK, '--repo', repo], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_MEMORY_PATH_CHECK: '1' },
  });
}

test('reports a backticked path that is gone, and not one that is present', { skip }, () => {
  assert.match(report('See `scripts/moved.py` for the details.'), /scripts\/moved\.py/);
  assert.strictEqual(report('See `scripts/live.py` for the details.'), '');
});

// candidate_paths splits a backticked span on whitespace. Without that, the commonest
// way a memory names a script — inside the command that runs it — was invisible,
// because the span holds spaces and PATHISH rejects it whole.
test('reads a path out of a backticked command, and leaves a live one alone', { skip }, () => {
  assert.match(report('Run `uv run python scripts/moved.py --prune` afterwards.'), /scripts\/moved\.py/);
  assert.strictEqual(report('Run `uv run python scripts/live.py --prune` afterwards.'), '');
});

// The absence-marker window is scoped to the sentence holding the mention. A +/-200
// character window read across sentence boundaries and suppressed real findings: the
// live example said "a lock whose process is gone is ignored" one sentence before
// naming a path that had genuinely moved, and `is gone` inside the window silenced it.
test('a marker suppresses only within its own sentence', { skip }, () => {
  const sameSentence = 'The guard at `scripts/moved.py` no longer exists.';
  assert.strictEqual(report(sameSentence), '');

  const priorSentence = 'A lock whose process is gone is ignored. See `scripts/moved.py` here.';
  assert.match(report(priorSentence), /scripts\/moved\.py/);
});

// Existence is checked against the caller's worktree first, then the main checkout. An
// untracked path — a gitignored directory, a scratch file — exists only in the checkout
// it was made in and never in a worktree, so checking the worktree alone called it
// deleted. Two of the three real findings on 2026-08-29 were exactly that.
test('a path present only in the main checkout is not reported from a worktree', { skip }, () => {
  const repo = tmpdir('memstale-repo-');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'tracked.md'), 'x');
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { stdio: 'ignore' });
  // Untracked, so it never reaches the worktree — the shape of a gitignored directory.
  fs.mkdirSync(path.join(repo, 'docs', 'untracked'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'untracked', 'page.md'), 'x');

  const wt = path.join(repo, 'wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'side'], { stdio: 'ignore' });

  const config = tmpdir('memstale-cfg-');
  // The slug comes from the MAIN checkout even when the hook runs in the worktree.
  const memories = path.join(config, 'projects', repo.split(path.sep).join('-'), 'memory');
  fs.mkdirSync(memories, { recursive: true });
  const run = (text) => {
    fs.writeFileSync(path.join(memories, 'a-memory.md'), text);
    return execFileSync(python, [HOOK, '--repo', wt], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_MEMORY_PATH_CHECK: '1' },
    });
  };

  assert.strictEqual(run('The pages under `docs/untracked/` are the ones.'), '');
  assert.match(run('The pages under `docs/absent/` are the ones.'), /docs\/absent/);
});

// ── the [ENFORCED]/(SCOPED) index pass ─────────────────────────────────────────────
//
// An index entry marked [ENFORCED] or (SCOPED) is a pointer to a check. The pointer
// outlives the check when a test is renamed or a hook retired, and nothing else re-reads
// it. Measured on the live server index 2026-09-18: 30 marked entries, 4 of them naming
// a test or a function at a file it had since moved out of — every one green in CI under
// its new name, every pointer wrong.

// Like report(), but the memory is linked from a MEMORY.md line carrying a marker, and
// the repo holds a test module defining `test_live`. Three memory files, so a multi-link
// index line has something to point at.
function reportIndexed(indexLine, memoryText) {
  const repo = tmpdir('memstale-repo-');
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'test_thing.py'), 'def test_live():\n    pass\n');
  const config = tmpdir('memstale-cfg-');
  const memories = path.join(config, 'projects', repo.split(path.sep).join('-'), 'memory');
  fs.mkdirSync(memories, { recursive: true });
  fs.writeFileSync(path.join(memories, 'MEMORY.md'), `# Index\n\n${indexLine}\n`);
  for (const name of ['a-memory.md', 'b-memory.md', 'c-memory.md']) {
    fs.writeFileSync(path.join(memories, name), memoryText);
  }
  return execFileSync(python, [HOOK, '--repo', repo], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_MEMORY_PATH_CHECK: '1' },
  });
}

const FULL = '- [A thing](a-memory.md) — one line. [ENFORCED]';
const SCOPED = '- [A thing](a-memory.md) — one line. [ENFORCED, SCOPED]';

test('a pointer-only entry whose check is gone is retirable; a live check is silent', { skip }, () => {
  const out = reportIndexed(FULL, 'ENFORCED by `tests/test_gone.py::test_live`.\n');
  assert.match(out, /a-memory\.md: tests\/test_gone\.py::test_live .*retire/);
  assert.strictEqual(reportIndexed(FULL, 'ENFORCED by `tests/test_thing.py::test_live`.\n'), '');
});

// PATHISH rejects the `::`, so a node id was invisible to the path scan; and a file that
// still exists says nothing about a test renamed inside it.
test('a node id naming a test the file no longer defines is flagged', { skip }, () => {
  const out = reportIndexed(FULL, 'ENFORCED by `tests/test_thing.py::test_renamed`.\n');
  assert.match(out, /tests\/test_thing\.py::test_renamed/);
  assert.strictEqual(reportIndexed(FULL, 'ENFORCED by `test_live` in `tests/test_thing.py`.\n'), '');
});

// A SCOPED entry keeps a body the check does not cover, so its stale check is a reference
// to fix and never a retire suggestion.
test('a SCOPED entry with a missing check warns without a retire suggestion', { skip }, () => {
  const out = reportIndexed(SCOPED, 'SCOPED: the check covers x (`tests/test_gone.py`).\n');
  assert.match(out, /a-memory\.md: tests\/test_gone\.py \(SCOPED/);
  assert.doesNotMatch(out, /retir/);
});

// Markers bind to the nearest preceding link, not the line: the live index puts several
// links on one bullet with a marker after each, and a line-level read hands the first
// entry the second's marker and the unmarked third a marker it never had.
test('markers bind per link on a multi-link line', { skip }, () => {
  const line = '- A: [a](a-memory.md) [ENFORCED] · [b](b-memory.md) (SCOPED) · [c](c-memory.md) (none).';
  const out = reportIndexed(line, 'ENFORCED by `tests/test_gone.py`.\n');
  // The path scan reports all three memories for the same gone path, so read only
  // the index block.
  const index = out.slice(out.indexOf('index entries'));
  assert.match(index, /a-memory\.md: .*pointer-only/);
  assert.match(index, /b-memory\.md: .*SCOPED/);
  assert.doesNotMatch(index, /c-memory\.md/);
});

test('opting out silences the hook entirely', { skip }, () => {
  const repo = tmpdir('memstale-repo-');
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  const config = tmpdir('memstale-cfg-');
  const memories = path.join(config, 'projects', repo.split(path.sep).join('-'), 'memory');
  fs.mkdirSync(memories, { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(memories, 'a-memory.md'), 'See `scripts/moved.py` here.');
  const run = (check) => execFileSync(python, [HOOK, '--repo', repo], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_MEMORY_PATH_CHECK: check },
  });
  assert.match(run('1'), /scripts\/moved\.py/);
  assert.strictEqual(run('0'), '');
});

test.after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
