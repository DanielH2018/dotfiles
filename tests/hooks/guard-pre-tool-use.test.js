// The PreToolUse/Bash shim's failure contract.
//
// An unevaluable deny list prints `ask` and exits 0: the call stops and waits for a human.
// Nothing else in the tree pins this branch, and it is reached only when uv, the managed 3.15
// or the package is missing -- a path no ordinary run exercises, so a regression here would be
// invisible until the day it mattered.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_guard-pre-tool-use.sh');

// An empty CLAUDE_GUARD_HOME reaches `fail()` at the shim's first check (no claude_guard/cli.py)
// without depending on whether this machine has uv or a managed 3.15 installed.
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

test('unevaluable rules ask and exit 0, so the prompt stands', () => {
  const r = runHook({});
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});

test('a stale CLAUDE_GUARD_DENY_SHADOW in the env changes nothing', () => {
  // Slice 4's shadow switch made the shim print nothing on failure when set to anything but
  // "0". Slice 6 retired it with the bash hook it shadowed; a settings.json regenerated
  // before that may still export the old value, and it must not turn the ask back into
  // silence.
  const r = runHook({ CLAUDE_GUARD_DENY_SHADOW: '1' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});

// stdin arrives through hook-input.sh (#565). The shim reads it with hook_read_input and never
// with jq, so these pin what that change could break: a missing library is a "cannot run" like
// a missing interpreter, and the payload reaches Python unchanged with no jq available.
const UV = spawnSync('bash', ['-c', 'command -v uv'], { encoding: 'utf8' }).stdout.trim();
const PY314 = UV && spawnSync(UV, ['python', 'find', '--no-project', '--managed-python', '--system', '3.15']).status === 0;
const needsPy = { skip: PY314 ? false : 'no uv-managed Python 3.15' };

// A stand-in claude_guard package whose cli answers `decision`, with its stdin as the reason.
function echoPackage(decision) {
  const home = scratch(os.tmpdir(), 'guard-pre-tool-use-echo-');
  fs.mkdirSync(path.join(home, 'claude_guard'));
  fs.writeFileSync(path.join(home, 'claude_guard', '__init__.py'), '');
  fs.writeFileSync(path.join(home, 'claude_guard', 'cli.py'), [
    'import json, sys',
    'raw = sys.stdin.read()',
    `out = {"hookEventName": "PreToolUse", "permissionDecision": "${decision}", "permissionDecisionReason": raw}`,
    'print(json.dumps({"hookSpecificOutput": out}))',
    '',
  ].join('\n'));
  return home;
}

test('a missing hook-input.sh asks, like a missing interpreter', needsPy, () => {
  // A working package, so the library is the only thing missing. The pre-#565 shim never
  // sourced it, reaches Python here, and answers with the stand-in's own `allow`.
  const r = runHook({ CLAUDE_GUARD_HOME: echoPackage('allow'), HOOK_INPUT_LIB: '/nonexistent/hook-input.sh' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});

test('the payload reaches the Python side byte-for-byte, with no jq on PATH', needsPy, () => {
  // Run with a PATH holding only uv and what run-bounded.sh itself needs: a jq dependency
  // creeping into the shim fails this outright rather than passing unnoticed.
  const home = echoPackage('ask');
  const bin = scratch(os.tmpdir(), 'guard-pre-tool-use-bin-');
  fs.symlinkSync(UV, path.join(bin, 'uv'));
  for (const tool of ['bash', 'cat', 'head', 'mktemp', 'rm', 'timeout', 'wc']) {
    fs.symlinkSync(spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, tool));
  }
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo "a\\b" \'c\' | wc -l' }, cwd: '/w' });
  const r = spawnSync('/bin/bash', [HOOK], {
    encoding: 'utf8',
    input: payload,
    env: { ...process.env, CLAUDE_GUARD_HOME: home, PATH: bin },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, payload);
});

// Nothing the shim starts may run unbounded (#581, #660). A hung `uv python find` or judge
// used to hold the hook until the harness killed it at 10s, and a killed PreToolUse hook is a
// non-blocking error: the call ran with no deny check. A stub `uv` on PATH hands back a stub
// interpreter, so no real uv or Python is needed.
const STUB = scratch(os.tmpdir(), 'guard-pre-tool-use-stub-');
const STUB_BIN = path.join(STUB, 'bin');
const STUB_SHARE = path.join(STUB, 'share');
const STUB_PY = path.join(STUB, 'python3.15');
fs.mkdirSync(STUB_BIN);
fs.mkdirSync(path.join(STUB_SHARE, 'claude_guard'), { recursive: true });
fs.writeFileSync(path.join(STUB_SHARE, 'claude_guard', 'cli.py'), '');
fs.writeFileSync(STUB_PY, `#!/bin/bash
cat >/dev/null
[ -n "\${STUB_PY_SLOW:-}" ] && sleep 30
printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
`, { mode: 0o755 });
fs.writeFileSync(path.join(STUB_BIN, 'uv'), `#!/bin/bash
[ -n "\${STUB_UV_SLOW:-}" ] && sleep 30
printf '%s\\n' ${JSON.stringify(STUB_PY)}
`, { mode: 0o755 });

function runStubbed(env) {
  const started = Date.now();
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    timeout: 20000,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/w' }),
    // GUARD_PYTHON_CACHE=0: a cached interpreter would answer without asking the stub uv.
    env: {
      ...process.env, PATH: `${STUB_BIN}:${process.env.PATH}`, CLAUDE_GUARD_HOME: STUB_SHARE,
      GUARD_PYTHON_CACHE: '0', ...env,
    },
  });
  return { ...r, seconds: (Date.now() - started) / 1000 };
}

test('the stub judge is heard when nothing hangs', () => {
  // The control for the three below: the same fixture, unhung, reaches the stub's `allow`.
  const r = runStubbed({});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(decisionOf(r.stdout), 'allow');
});

test('a hung uv python find asks within 10s, at the default bound', () => {
  const r = runStubbed({ STUB_UV_SLOW: '1' });
  assert.ok(r.seconds < 10, `took ${r.seconds}s`);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});

test('a hung judge is cut off and asks', () => {
  const r = runStubbed({ STUB_PY_SLOW: '1', CLAUDE_GUARD_TIMEOUT_S: '1' });
  assert.ok(r.seconds < 8, `took ${r.seconds}s`);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});

test('a missing run-bounded.sh asks rather than running the judge unbounded', () => {
  const r = runStubbed({ RUN_BOUNDED_LIB: path.join(STUB, 'no-such-lib.sh') });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(decisionOf(r.stdout), 'ask');
});

test('the real package answers the git conventions through this shim (#619)', needsPy, () => {
  // git-conventions-guard.sh was folded into `cli pre-tool-use`; this is the wiring test that
  // hook's own suite used to carry. The rules are pinned case by case in claude-guard's
  // tests/test_git_conventions.py.
  const decide = (command) => {
    const r = spawnSync('bash', [HOOK], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/w' }),
      env: { ...process.env, CLAUDE_GUARD_HOME: srcPath('dot_local', 'share', 'claude-guard') },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim() ? decisionOf(r.stdout) : null;
  };
  assert.strictEqual(decide('git commit --amend --no-edit'), 'ask');
  assert.strictEqual(decide('git commit -m "Add the guard"'), null);
});
