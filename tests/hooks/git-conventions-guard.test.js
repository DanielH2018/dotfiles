// Wiring test for executable_git-conventions-guard.sh (PreToolUse/Bash, #575). The rules
// themselves are pinned case by case in claude-guard's tests/test_git_conventions.py; this
// proves the shim reaches them, emits the harness's JSON, and stays silent both on the
// prefilter path and when the package is missing.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');
const { scratch } = require('../lib/tmp');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_git-conventions-guard.sh');
const GUARD = srcPath('dot_local', 'share', 'claude-guard');

// The shim needs the uv-managed 3.14 that guard-pre-tool-use.sh resolves; without it the
// hook is silent by design, and every assertion below would measure that instead.
const managedPython = (() => {
  try {
    const r = execFileSync(
      'uv', ['python', 'find', '--no-project', '--managed-python', '--system', '3.14'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return fs.existsSync(r);
  } catch { return false; }
})();
const skip = skipUnless('bash') || (managedPython ? false : 'no uv-managed 3.14');

function decide(command, guardHome = GUARD) {
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_GUARD_HOME: guardHome },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

test('asks on git commit --amend and passes a plain commit', { skip }, () => {
  const d = decide('git commit --amend --no-edit');
  assert.strictEqual(d.hookEventName, 'PreToolUse');
  assert.strictEqual(d.permissionDecision, 'ask');
  assert.strictEqual(decide('git commit -m "Add the guard"'), null);
});

test('asks on a merge commit and passes the ff-only merge land-sync runs', { skip }, () => {
  assert.strictEqual(decide('git merge topic').permissionDecision, 'ask');
  assert.strictEqual(decide('git merge --ff-only origin/main'), null);
});

test('denies a prefixed PR title and passes an imperative one', { skip }, () => {
  const d = decide('gh pr create --title "feat: x"');
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /feat:/);
  assert.strictEqual(decide('gh pr create --title "Pin the runner image"'), null);
});

test('is silent when the claude_guard package is not deployed', { skip }, () => {
  const empty = scratch(os.tmpdir(), 'gcg-empty-');
  assert.strictEqual(decide('git commit --amend', path.join(empty, 'none')), null);
});
