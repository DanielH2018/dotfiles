// The PreToolUse/Bash shim's failure contract, which differs by host and sandbox.
//
// On the host an unevaluable deny list prints `ask` and exits 0: the call stops and waits for
// a human. In the sandbox that is fail-OPEN, because the CMD is
// `claude --dangerously-skip-permissions` and an ask is skipped under that flag. So the
// sandbox sets CLAUDE_GUARD_FAIL_CLOSED=1 and the same shim denies with exit 2 instead.
// Nothing else in the tree pins either branch, and both are reached only when uv, the managed
// 3.14 or the package is missing -- a path no ordinary run exercises, so a regression here
// would be invisible until the day it mattered.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');

const HOOK = path.join(
  __dirname, '..', '..', 'home', 'private_dot_claude', 'hooks',
  'executable_guard-pre-tool-use.sh',
);

// An empty CLAUDE_GUARD_HOME reaches `fail()` at the shim's first check (no claude_guard/cli.py)
// without depending on whether this machine has uv or a managed 3.14 installed.
function missingPackageDir() {
  const dir = scratch(os.tmpdir(), 'guard-pre-tool-use-');
  return dir;
}

function runHook(env) {
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      cwd: '/workspace',
    }),
    env: { ...process.env, CLAUDE_GUARD_HOME: missingPackageDir(), ...env },
  });
}

function decisionOf(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

test('unevaluable rules ask and exit 0 by default, so the host prompt stands', () => {
  const r = runHook({ CLAUDE_GUARD_FAIL_CLOSED: '0' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});

test('CLAUDE_GUARD_FAIL_CLOSED=1 denies and exits 2, because the sandbox skips an ask', () => {
  const r = runHook({ CLAUDE_GUARD_FAIL_CLOSED: '1' });
  // Exit 2 is what actually blocks under --dangerously-skip-permissions (hooks.md, "Exit code
  // 2 behavior per event": it blocks whether or not JSON is printed). The JSON and the stderr
  // line are the two channels the reason can reach the user by, and which one the harness
  // surfaces on this path is not documented -- hence both.
  assert.strictEqual(r.status, 2);
  assert.strictEqual(decisionOf(r.stdout), 'deny');
  assert.match(r.stderr, /fails closed/);
});

test('a stale CLAUDE_GUARD_DENY_SHADOW in the env changes nothing', () => {
  // Slice 4's shadow switch made the shim print nothing on failure when set to anything but
  // "0". Slice 6 retired it with the bash hook it shadowed; a settings.json regenerated
  // before that, or a container image built from one, may still export the old value, and
  // it must not turn the ask back into silence.
  const r = runHook({ CLAUDE_GUARD_FAIL_CLOSED: '0', CLAUDE_GUARD_DENY_SHADOW: '1' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});
