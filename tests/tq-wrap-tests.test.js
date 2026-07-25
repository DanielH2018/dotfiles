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
let binDir = '';
if (python3Ok) {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-hook-bin-'));
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
});

test('the lint runners are routed too', { skip }, () => {
  // Proves the hook is asking tq's own detect() rather than a private copy:
  // ruff and shellcheck are only recognised by the tq in this checkout.
  assert.strictEqual(rewritten('ruff check .'), 'tq ruff check .');
  assert.strictEqual(rewritten('shellcheck x.sh'), 'tq shellcheck x.sh');
  assert.strictEqual(rewritten('uv run pytest'), 'tq uv run pytest');
});

test('a command tq does not claim is left alone', { skip }, () => {
  for (const command of [
    'git status',
    'ls -la',
    'node script.js',            // no --test
    'ruff format --check .',     // reformatting, not diagnostics
    'grep pytest notes.txt',     // merely names a runner
    'echo "run node --test"',
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
