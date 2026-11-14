// The claude-guard bin shim: resolves uv's managed 3.15 and execs the package CLI.
// Pins the two properties the spec's failure contract rests on: no uv-managed 3.15
// means a clear error on stderr and exit 2 (never a silent exit 0), and a present
// one runs the real CLI out of the source tree via CLAUDE_GUARD_HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const SHIM = srcPath('dot_local', 'bin', 'executable_claude-guard');
const SHARE = srcPath('dot_local', 'share', 'claude-guard');

test('shim runs the CLI from CLAUDE_GUARD_HOME', { skip: skipUnless('uv') }, () => {
  const r = spawnSync('bash', [SHIM, 'explain', 'ls; pwd'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^status: ok/m);
  assert.match(r.stdout, /\[1\] sep=eof heredocs=0: pwd/);
});

test('shim ignores a claude_guard package in the working directory', { skip: skipUnless('uv') }, (t) => {
  const cwd = scratch(os.tmpdir(), 'claude-guard-cwd-pkg-', t);
  fs.mkdirSync(path.join(cwd, 'claude_guard'));
  fs.writeFileSync(path.join(cwd, 'claude_guard', '__init__.py'), '');
  fs.writeFileSync(path.join(cwd, 'claude_guard', 'cli.py'), 'print("planted cli ran")\n');

  const r = spawnSync('bash', [SHIM, 'explain', 'ls; pwd'], {
    encoding: 'utf8', cwd, env: { ...process.env, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /planted cli ran/);
  assert.match(r.stdout, /^status: ok/m);
});

// Extract the `uv python find ...` argv straight from the shim's own source text, so this
// test tracks whatever flags the shim actually passes rather than a hand-copied duplicate
// that could silently drift out of sync with it.
function shimLookupArgv(shimPath) {
  const text = fs.readFileSync(shimPath, 'utf8');
  const m = text.match(/uv python find ((?:\S+\s*)+)/);
  assert.ok(m, `no \`uv python find\` invocation found in ${shimPath}`);
  const tokens = [];
  for (const tok of m[1].split(/\s+/)) {
    if (tok.startsWith('2>') || tok === '||' || tok === ')') break;
    tokens.push(tok);
  }
  return tokens;
}

// An inherited VIRTUAL_ENV (a session started under `uv run` has one) outranks the cwd walk,
// so a fixture that leaves it set measures the active venv instead of the one it built.
function envWithoutActiveVenv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['VIRTUAL_ENV', 'CONDA_PREFIX']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function makeVenv(t, prefix) {
  const dir = scratch(os.tmpdir(), prefix, t);
  const venv = path.join(dir, '.venv');
  const created = spawnSync('uv', ['venv', '--python', '3.15', venv],
    { encoding: 'utf8', env: envWithoutActiveVenv() });
  if (created.status !== 0) {
    t.skip(`uv venv --python 3.15 unavailable: ${created.stderr}`);
    return null;
  }
  return dir;
}

function assertManaged(r, venvDir) {
  assert.strictEqual(r.status, 0, r.stderr);
  const found = r.stdout.trim();
  assert.ok(!found.startsWith(venvDir), `got the venv instead of managed: ${found}`);
  assert.match(found, /\/uv\/python\//);
  assert.ok(fs.statSync(found).isFile(), found);
}

test('the shim\'s own lookup ignores a real cwd venv only because of --system',
  { skip: skipUnless('uv') }, (t) => {
    // A *dangling* or wrong-version cwd venv is not the risk `--system` guards against: uv
    // already probes a discovered venv's interpreter and falls back to the managed toolchain
    // on its own regardless of `--system`. The one shape that actually differs is a REAL,
    // version-matching venv found by walking up from cwd -- exactly what a project's own
    // `.venv` is -- which uv prefers over the managed install unless `--system` is present.
    const argv = shimLookupArgv(SHIM);
    assert.ok(argv.includes('--system'), argv.join(' '));
    const cwd = makeVenv(t, 'claude-guard-real-venv-');
    if (!cwd) return;
    const env = envWithoutActiveVenv();

    assertManaged(spawnSync('uv', ['python', 'find', ...argv], { encoding: 'utf8', cwd, env }), cwd);

    // Control: without --system the same lookup, from the same cwd, must return the venv.
    // If it does not, --system no longer guards anything and belongs out of the shim.
    const argvNoSystem = argv.filter((a) => a !== '--system');
    const r2 = spawnSync('uv', ['python', 'find', ...argvNoSystem], { encoding: 'utf8', cwd, env });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.ok(r2.stdout.trim().startsWith(cwd),
      `without --system uv returned ${r2.stdout.trim()}, not the cwd venv: --system may be dead`);
  });

test('the shim\'s own lookup ignores an active VIRTUAL_ENV only because of --system',
  { skip: skipUnless('uv') }, (t) => {
    const argv = shimLookupArgv(SHIM);
    const venvDir = makeVenv(t, 'claude-guard-active-venv-');
    if (!venvDir) return;
    const cwd = scratch(os.tmpdir(), 'claude-guard-plain-cwd-', t);
    const env = envWithoutActiveVenv({ VIRTUAL_ENV: path.join(venvDir, '.venv') });

    assertManaged(spawnSync('uv', ['python', 'find', ...argv], { encoding: 'utf8', cwd, env }), venvDir);

    const argvNoSystem = argv.filter((a) => a !== '--system');
    const r2 = spawnSync('uv', ['python', 'find', ...argvNoSystem], { encoding: 'utf8', cwd, env });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.ok(r2.stdout.trim().startsWith(venvDir),
      `without --system uv returned ${r2.stdout.trim()}, not the active venv`);
  });

test('shim fails closed with a message when no managed 3.15 is available', () => {
  // spawnSync's env replaces process.env wholesale, and bash itself would normally need to
  // be resolved through that same PATH. Using an argv[0] with a slash (`/bin/bash`) bypasses
  // Node's PATH lookup for bash, so an empty PATH is free to make the bare `uv` the shim
  // shells out to unresolvable — wherever a real uv lives on the machine running this test.
  const r = spawnSync('/bin/bash', [SHIM, 'explain', 'ls'], {
    encoding: 'utf8', env: { PATH: '', HOME: process.env.HOME, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /uv python install 3\.15/);
  assert.strictEqual(r.stdout, '');
});
