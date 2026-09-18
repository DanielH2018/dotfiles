// Regression guard for executable_tq-wrap-tests.sh (PreToolUse/Bash).
//
// The shim exists only to avoid starting python3 for the ~98% of Bash calls tq will never
// claim. That makes its correctness property unusually simple to state and unusually easy
// to get wrong: for EVERY command it must produce exactly what the Python hook produces.
// A shim that is merely "close" silently stops wrapping a test runner, or worse, rewrites
// a command Python would have left alone.
//
// So the central test here is differential rather than expectational — it runs both and
// compares — plus the two failure modes the design depends on: the candidate list must be
// re-derived when tq's detect.py changes (a stale copy is the drift the .py's own comments
// refuse to accept), and anything unclassifiable must fall through rather than guess.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have, skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOKS = srcPath('private_dot_claude', 'hooks');
const SHIM = path.join(HOOKS, 'executable_tq-wrap-tests.sh');
const PY = path.join(HOOKS, 'executable_tq-wrap-tests.py');
const LIB = path.join(HOOKS, 'hook-input.sh');
const TQ = srcPath('dot_local', 'bin', 'executable_tq');

const skip = skipUnless('python3', 'bash', 'jq');

let binDir = '';
let cacheDir = '';
if (have('python3') && have('bash') && have('jq')) {
  binDir = scratch(os.tmpdir(), 'tqshim-bin-');
  cacheDir = scratch(os.tmpdir(), 'tqshim-cache-');
  fs.symlinkSync(TQ, path.join(binDir, 'tq'));
}

function baseEnv(extra = {}) {
  const e = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    TQ_BIN: TQ,
    TQ_WRAP_PY: PY,
    HOOK_INPUT_LIB: LIB,
    XDG_CACHE_HOME: cacheDir,
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
  // The case that makes the fall-through branch load-bearing: shlex reads the program as
  // `git`, a naive split reads it as `"git"`. The shim must not decide that difference
  // itself — it has to hand the command to Python, which wraps it.
  '"git" diff',
  "'git' diff",
];

test('shim output is identical to the python hook for every command', { skip }, () => {
  for (const cmd of CORPUS) {
    assert.strictEqual(viaShim(cmd), viaPython(cmd), `diverged on: ${JSON.stringify(cmd)}`);
  }
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

// The whole reason the shim may keep a candidate list at all is that it re-derives it from
// detect.py and re-derives it again when that file changes. If this regresses, the list
// silently becomes the hand-maintained copy the Python hook's comments explicitly rejected,
// and a newly-claimed program stops being offered to tq.
test('the candidate cache is rebuilt when tq detect.py changes', { skip }, () => {
  const lib = scratch(os.tmpdir(), 'tqshim-lib-');
  const cache = scratch(os.tmpdir(), 'tqshim-c2-');
  const detect = path.join(lib, 'detect.py');
  const env = { TQ_HOME: lib, XDG_CACHE_HOME: cache };

  // A world where tq claims nothing: the shim must skip, and cache that.
  fs.writeFileSync(detect, 'CANDIDATES = set()\ndef detect(argv):\n    return None\n');
  assert.strictEqual(viaShim('node --test', env), '', 'should skip while tq claims nothing');
  const cached = path.join(cache, 'claude-hooks', 'tq-candidates.json');
  assert.ok(fs.existsSync(cached), 'a candidate cache should have been written');
  assert.strictEqual(JSON.parse(fs.readFileSync(cached, 'utf8')).length, 0);

  // Now tq claims `node`. The mtime/size key must invalidate, or the shim keeps skipping.
  fs.writeFileSync(detect, 'CANDIDATES = {"node"}\ndef detect(argv):\n    return "node"\n');
  const now = Date.now() / 1000 + 5;
  fs.utimesSync(detect, now, now);
  viaShim('node --test', env);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(cached, 'utf8')), ['node'],
    'the cache should have been re-derived after detect.py changed');
});

test('an unreadable tq lib falls through to python rather than guessing', { skip }, () => {
  const env = { TQ_HOME: path.join(os.tmpdir(), 'tqshim-does-not-exist') };
  assert.strictEqual(viaShim('node --test', env), viaPython('node --test', env));
});
