// hook-input.sh's decision helpers: hook_deny and hook_ask print the PreToolUse JSON the
// guards used to build by hand, and they must carry a reason holding payload data intact.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const LIB = srcPath('private_dot_claude', 'hooks', 'hook-input.sh');

const skip = skipUnless('bash', 'jq');

// The reason is passed as $1 rather than spliced into the script, the way a guard passes
// its own $REASON.
function sh(snippet, reason) {
  const r = spawnSync('bash', ['-c', `set -u; . ${JSON.stringify(LIB)}; ${snippet}`, 'sh', reason], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('hook_deny prints a PreToolUse deny with the reason', { skip }, () => {
  const r = sh('hook_deny "$1"', 'blocked');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked',
    },
  });
});

test('hook_ask prints a PreToolUse ask', { skip }, () => {
  const r = sh('hook_ask "$1"', 'check this');
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('a reason holding a quote, a backslash and a newline survives as one string', { skip }, () => {
  const reason = 'file "a\\b"\nnext line';
  const r = sh('hook_deny "$1"', reason);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, reason);
});

test('neither helper exits, so the caller decides', { skip }, () => {
  const r = sh('hook_deny "$1" >/dev/null; hook_ask "$1" >/dev/null; echo after', 'x');
  assert.strictEqual(r.stdout, 'after\n');
});
