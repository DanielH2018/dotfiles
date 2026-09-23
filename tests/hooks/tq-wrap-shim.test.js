// Regression guard for executable_tq-wrap-tests.sh (PreToolUse/Bash).
//
// The shim no longer reads the command (#580): it keeps two exits that need no parsing,
// TQ_OFF and no tq binary, and execs the Python hook for everything else, where
// claude_guard.segment decides. Its correctness property is still that for EVERY command it
// produces exactly what the Python hook produces, so the central test stays differential:
// it runs both and compares. A shim that is merely "close" silently stops wrapping a test
// runner, or rewrites a command Python would have left alone.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch, hardenedCopy } = require('../lib/tmp');
const { have, skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOKS = srcPath('private_dot_claude', 'hooks');
const SHIM = path.join(HOOKS, 'executable_tq-wrap-tests.sh');
const PY = path.join(HOOKS, 'executable_tq-wrap-tests.py');
const LIB = path.join(HOOKS, 'hook-input.sh');
const TQ = srcPath('dot_local', 'bin', 'executable_tq');

const skip = skipUnless('python3', 'bash');

// Hardened copies of tq's lib and of claude_guard, which the Python hook refuses to import
// from a group-writable checkout (tests/lib/tmp.js, hardenedCopy). Without them both sides
// would return nothing for every command and the differential test would compare two
// empty strings.
let binDir = '';
let tqLib = '';
let guard = '';
if (have('python3') && have('bash')) {
  binDir = scratch(os.tmpdir(), 'tqshim-bin-');
  fs.symlinkSync(TQ, path.join(binDir, 'tq'));
  tqLib = hardenedCopy(scratch(os.tmpdir(), 'tqshim-lib-'), srcPath('dot_local', 'share', 'tq'));
  guard = hardenedCopy(scratch(os.tmpdir(), 'tqshim-guard-'), srcPath('dot_local', 'share', 'claude-guard'));
}

function baseEnv(extra = {}) {
  const e = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    TQ_BIN: TQ,
    TQ_HOME: tqLib,
    CLAUDE_GUARD_HOME: guard,
    TQ_WRAP_PY: PY,
    HOOK_INPUT_LIB: LIB,
  };
  delete e.TQ_OFF;
  return { ...e, ...extra };
}

function payload(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function viaShim(command, env = {}) {
  return spawnSync('bash', [SHIM], { input: payload(command), encoding: 'utf8', env: baseEnv(env) }).stdout || '';
}
function viaPython(command, env = {}) {
  return spawnSync('python3', [PY], { input: payload(command), encoding: 'utf8', env: baseEnv(env) }).stdout || '';
}

// Spread across the three populations the 24h telemetry showed: shell-character commands
// (62%), simple non-candidates (36%), and the commands tq actually claims (2%).
const CORPUS = [
  'echo hi',
  'ls -la',
  'ls',
  'git status',
  'git log --oneline -5',
  'node --test tests/',
  'pytest -q',
  'grep -rn foo .',
  'rg pattern',
  'ruff check .',
  'shellcheck x.sh',
  'ls -la | head -20',
  'git status && echo done',
  'echo $HOME',
  'cat f.txt > out.txt',
  'find . -name "*.js"',
  '  git status',
  'TQ_OFF=1 node --test',
  'python3 -c pass',
  './script.sh',
  '/usr/bin/git status',
  'unbalanced "quote',
  '',
  // shlex reads the program as `git`, a naive split as `"git"`. Only Python judges that.
  '"git" diff',
  "'git' diff",
  // An `env`/`command`/`exec` prefix: Python asks tq about `env` rather than about the
  // runner behind it, so neither side wraps.
  'env pytest tests/',
  'command pytest -q',
  'exec node --test',
  // A separator inside quotes is an argument (#580). The jq pass this shim used to run
  // skipped these on the character alone, and claude_guard.segment reads each as one
  // command, which Python wraps.
  'node --test "tests/a;b.test.js"',
  "node --test 'x && y'",
];

test('shim output is identical to the python hook for every command', { skip }, () => {
  let wrapped = 0;
  for (const cmd of CORPUS) {
    const out = viaShim(cmd);
    assert.strictEqual(out, viaPython(cmd), `diverged on: ${JSON.stringify(cmd)}`);
    if (out) wrapped += 1;
  }
  // Non-vacuity: identical outputs prove nothing if both sides return nothing for every
  // command, which is what an unimportable tq lib or claude_guard produces.
  assert.ok(wrapped >= 4, `only ${wrapped} corpus commands were rewritten; the hook is not reaching tq`);
});

test('a non-Bash tool is left alone by both', { skip }, () => {
  const input = JSON.stringify({ tool_name: 'Read', tool_input: { command: 'node --test' } });
  const s = spawnSync('bash', [SHIM], { input, encoding: 'utf8', env: baseEnv() }).stdout || '';
  const p = spawnSync('python3', [PY], { input, encoding: 'utf8', env: baseEnv() }).stdout || '';
  assert.strictEqual(s, '');
  assert.strictEqual(s, p);
});

test('TQ_OFF disables the shim exactly as it disables the hook', { skip }, () => {
  assert.strictEqual(viaShim('node --test', { TQ_OFF: '1' }), '');
  assert.strictEqual(viaShim('node --test', { TQ_OFF: '1' }), viaPython('node --test', { TQ_OFF: '1' }));
});
