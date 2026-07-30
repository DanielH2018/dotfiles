// Regression guard for executable_tq-wrap-tests.py (PreToolUse/Bash). Feeds
// hook payloads through the ACTUAL hook and asserts what it rewrites and — the
// half that matters more — what it leaves alone. This hook sits in front of
// every Bash call the agent makes, so a false positive here corrupts an
// unrelated command. Offline and deterministic; skips without python3.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_tq-wrap-tests.py');
const TQ = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_tq');

let python3Ok = true;
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch { python3Ok = false; }
const skip = python3Ok ? false : 'python3 unavailable';

// The hook only rewrites when `tq` resolves on PATH, because that is the word it
// emits. The repo's copy is named executable_tq, so give it a resolvable alias
// and point TQ_BIN at it: this exercises the checkout rather than whatever
// `chezmoi apply` last deployed.
const dirs = [];
let binDir = '';
if (python3Ok) {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-hook-bin-'));
  dirs.push(binDir);
  fs.symlinkSync(TQ, path.join(binDir, 'tq'));
}

function runHook(command, { tool = 'Bash', env = {}, raw = null } = {}) {
  const input = raw !== null ? raw : JSON.stringify({ tool_name: tool, tool_input: { command } });
  const r = spawnSync('python3', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TQ_BIN: TQ, ...env },
  });
  return r;
}

function rewritten(command, opts) {
  const r = runHook(command, opts);
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  if (!r.stdout.trim()) return null;
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  return payload.hookSpecificOutput.updatedInput.command;
}

test('a bare node --test run is routed through tq', { skip }, () => {
  assert.strictEqual(rewritten('node --test'), 'tq node --test');
  assert.strictEqual(rewritten('node --test tests/x.test.js'), 'tq node --test tests/x.test.js');
  assert.strictEqual(rewritten('go test ./...'), 'tq go test ./...');
});

test('the lint runners are routed too', { skip }, () => {
  // Proves the hook is asking tq's own detect() rather than a private copy:
  // ruff and shellcheck are only recognised by the tq in this checkout.
  assert.strictEqual(rewritten('ruff check .'), 'tq ruff check .');
  assert.strictEqual(rewritten('mypy src'), 'tq mypy src');
  assert.strictEqual(rewritten('eslint .'), 'tq eslint .');
  assert.strictEqual(rewritten('tsc --noEmit'), 'tq tsc --noEmit');
  assert.strictEqual(rewritten('shellcheck x.sh'), 'tq shellcheck x.sh');
  assert.strictEqual(rewritten('uv run pytest'), 'tq uv run pytest');
  assert.strictEqual(rewritten('go vet ./...'), 'tq go vet ./...');
  assert.strictEqual(rewritten('cargo clippy'), 'tq cargo clippy');
  assert.strictEqual(rewritten('cargo test'), 'tq cargo test');
  assert.strictEqual(rewritten('gradle test'), 'tq gradle test');
  assert.strictEqual(rewritten('./gradlew test'), 'tq ./gradlew test');
  assert.strictEqual(rewritten('mvn test'), 'tq mvn test');
  assert.strictEqual(rewritten('mvn clean test'), 'tq mvn clean test');
});

test('a command tq does not claim is left alone', { skip }, () => {
  for (const command of [
    'git status',
    'ls -la',
    'node script.js',            // no --test
    'ruff format --check .',     // reformatting, not diagnostics
    'echo "run node --test"',
    'gradle build',               // does not name the test task explicitly
    'mvn install',                // does not name the test phase explicitly
  ]) {
    assert.strictEqual(rewritten(command), null, `must not rewrite: ${command}`);
  }
});

test('the sweeps that dominate context are routed too', { skip }, () => {
  assert.strictEqual(rewritten('git log --oneline -50'), 'tq git log --oneline -50');
  assert.strictEqual(rewritten('git diff main'), 'tq git diff main');
  assert.strictEqual(rewritten("find . -name '*.py'"), "tq find . -name '*.py'");
  assert.strictEqual(rewritten('rg TODO src'), 'tq rg TODO src');
  assert.strictEqual(rewritten('ls -R src'), 'tq ls -R src');
  // Still not mistaken for the runner it merely names: this is a grep survey,
  // and nothing injects pytest's reporter flags into it.
  assert.strictEqual(rewritten('grep pytest notes.txt'), 'tq grep pytest notes.txt');
});

test('a command that writes or runs something is never claimed', { skip }, () => {
  // The line tq must not cross: it captures stdout, so it can only ever stand
  // in front of a command whose whole effect is what it printed.
  for (const command of [
    'git commit -m wip',
    'git push',
    'git checkout -b x',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} ;',
    'git diff --quiet',          // the status is the answer, not the shape
    'grep -l TODO src',          // a different answer shape: names, not matches
    'ls -lR src',                // a long listing carries permissions, not paths
  ]) {
    assert.strictEqual(rewritten(command), null, `must not rewrite: ${command}`);
  }
});

test('anything more than one simple command is left alone', { skip }, () => {
  // A `tq` prefix would wrap only the first stage and change what the shell
  // does with the rest, which is worse than not digesting at all.
  for (const command of [
    'node --test | tail -5',
    'node --test && git push',
    'node --test; echo done',
    'node --test > out.txt',
    'node --test 2>&1',
    'echo $(node --test)',
    'echo `node --test`',
    'node --test\nls',
  ]) {
    assert.strictEqual(rewritten(command), null, `must not rewrite: ${command}`);
  }
});

test('TQ_OFF disables the rewrite, by env or inline', { skip }, () => {
  assert.strictEqual(rewritten('node --test', { env: { TQ_OFF: '1' } }), null);
  // Inline needs no special case: an assignment is not a program name.
  assert.strictEqual(rewritten('TQ_OFF=1 node --test'), null);
});

test('an already-wrapped command is not wrapped twice', { skip }, () => {
  assert.strictEqual(rewritten('tq node --test'), null);
});

test('a non-Bash tool call is ignored', { skip }, () => {
  assert.strictEqual(rewritten('node --test', { tool: 'Read' }), null);
});

test('unreadable input fails open rather than erroring', { skip }, () => {
  for (const raw of ['', 'not json at all', '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":null}']) {
    const r = runHook(null, { raw });
    assert.strictEqual(r.status, 0, `exited ${r.status} on ${JSON.stringify(raw)}`);
    assert.strictEqual(r.stdout.trim(), '');
  }
});

test('an unparseable command fails open', { skip }, () => {
  // Unbalanced quotes: the shell may still accept it, so the hook must not
  // guess at what it means.
  assert.strictEqual(rewritten('node --test "unclosed'), null);
});

test('the rewrite is skipped when tq cannot be resolved by name', { skip }, () => {
  // Emitting a bare `tq` that PATH cannot find would break a working command.
  // The PATH still has to reach python3 to run the hook at all, so drop only
  // the directories that actually hold a tq.
  const reduced = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((dir) => dir && !fs.existsSync(path.join(dir, 'tq')))
    .join(path.delimiter);
  const r = runHook('node --test', { env: { PATH: reduced } });
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), '');
});

// TQ_LIB is derived from $TQ_HOME when that is set, and this hook runs in front of every
// Bash call — so an importable directory here is an execution path into the hook itself,
// chosen by whoever can set an environment variable. Both refusals must leave the command
// untouched and still exit 0: rewrite() is called under a deliberately blind except.
test('a world-writable TQ_HOME is refused rather than imported', { skip }, () => {
  const hostile = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-hostile-'));
  dirs.push(hostile);
  // If this were imported the hook would die on the SystemExit rather than return null.
  fs.writeFileSync(path.join(hostile, 'detect.py'), 'raise SystemExit("must never be imported")\n');
  fs.chmodSync(hostile, 0o777);
  const r = runHook('node --test', { env: { TQ_HOME: hostile } });
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), '');
});

test('a TQ_HOME with no module is refused', { skip }, () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-empty-'));
  dirs.push(empty);
  const r = runHook('node --test', { env: { TQ_HOME: empty } });
  assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), '');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
