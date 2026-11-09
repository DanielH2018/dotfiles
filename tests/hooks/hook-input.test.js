// hook-input.sh's decision helpers: hook_deny and hook_ask print the PreToolUse JSON the
// guards used to build by hand, and they must carry a reason holding payload data intact.
// Also hook_under_temp_root, which bash-write-fanout.sh uses.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const LIB = srcPath('private_dot_claude', 'hooks', 'lib', 'hook-input.sh');

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

// hook_under_temp_root, run with an explicit root list so the host's real /tmp plays no part.
const DIR = scratch(os.tmpdir(), 'hook-input-');
const REAL_ROOT = path.join(DIR, 'real-root');
const LINKED_ROOT = path.join(DIR, 'linked-root');
const OUTSIDE = path.join(DIR, 'outside');
fs.mkdirSync(REAL_ROOT);
fs.mkdirSync(OUTSIDE);
fs.symlinkSync(REAL_ROOT, LINKED_ROOT);
fs.writeFileSync(path.join(REAL_ROOT, 'f.md'), '');
fs.writeFileSync(path.join(OUTSIDE, 'f.md'), '');

function underTempRoot(file, roots) {
  return spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; hook_under_temp_root "$1" "$2"`, 'sh', file, roots])
    .status;
}

test('a file is under a root named through a symlink', { skip }, () => {
  assert.strictEqual(underTempRoot(path.join(REAL_ROOT, 'f.md'), `/nonexistent:${LINKED_ROOT}`), 0);
});

test('a file outside every root is not under one', { skip }, () => {
  assert.strictEqual(underTempRoot(path.join(OUTSIDE, 'f.md'), LINKED_ROOT), 1);
});

test('an empty root list matches nothing', { skip }, () => {
  assert.strictEqual(underTempRoot(path.join(REAL_ROOT, 'f.md'), ''), 1);
});
