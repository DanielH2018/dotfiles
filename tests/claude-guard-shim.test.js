// The claude-guard bin shim: resolves uv's managed 3.14 and execs the package CLI.
// Pins the two properties the spec's failure contract rests on: no uv-managed 3.14
// means a clear error on stderr and exit 2 (never a silent exit 0), and a present
// one runs the real CLI out of the source tree via CLAUDE_GUARD_HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHIM = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-guard');
const SHARE = path.join(__dirname, '..', 'home', 'dot_local', 'share', 'claude-guard');

let uvOk = true;
try { execFileSync('uv', ['--version'], { stdio: 'ignore' }); } catch { uvOk = false; }

test('shim runs the CLI from CLAUDE_GUARD_HOME', { skip: uvOk ? false : 'uv unavailable' }, () => {
  const r = spawnSync('bash', [SHIM, 'explain', 'ls; pwd'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^status: ok/m);
  assert.match(r.stdout, /\[1\] sep=eof heredocs=0: pwd/);
});

test('shim ignores a dangling venv found in cwd', { skip: uvOk ? false : 'uv unavailable' }, () => {
  // `uv python find` without `--system` can answer with a virtualenv it discovers by walking
  // up from cwd, not just a uv-managed install -- and the harness runs a session's hooks (and
  // a human running this CLI by hand) with cwd = whatever project is open. A stale `.venv`
  // there (e.g. after a pruned worktree) would make the shim resolve a dangling symlink
  // instead of the managed 3.14, silently, since the failure contract is "print nothing" for
  // the hook shims and "error, never a silent no-op" for this one -- either way the WRONG
  // interpreter must never be the one that runs.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-guard-dangling-venv-'));
  fs.mkdirSync(path.join(cwd, '.venv', 'bin'), { recursive: true });
  fs.symlinkSync('/nonexistent', path.join(cwd, '.venv', 'bin', 'python3'));
  const r = spawnSync('bash', [SHIM, 'explain', 'ls; pwd'], {
    encoding: 'utf8', cwd, env: { ...process.env, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^status: ok/m);
});

test('shim fails closed with a message when no managed 3.14 is available', () => {
  // spawnSync's env replaces process.env wholesale, and bash itself would normally need to
  // be resolved through that same PATH. Using an argv[0] with a slash (`/bin/bash`) bypasses
  // Node's PATH lookup for bash, so an empty PATH is free to make the bare `uv` the shim
  // shells out to unresolvable — wherever a real uv lives on the machine running this test.
  const r = spawnSync('/bin/bash', [SHIM, 'explain', 'ls'], {
    encoding: 'utf8', env: { PATH: '', HOME: process.env.HOME, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /uv python install 3\.14/);
  assert.strictEqual(r.stdout, '');
});
