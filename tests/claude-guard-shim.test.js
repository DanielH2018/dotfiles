// The claude-guard bin shim: resolves uv's managed 3.14 and execs the package CLI.
// Pins the two properties the spec's failure contract rests on: no uv-managed 3.14
// means a clear error on stderr and exit 2 (never a silent exit 0), and a present
// one runs the real CLI out of the source tree via CLAUDE_GUARD_HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
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

test('shim fails closed with a message when no managed 3.14 is available', () => {
  // A PATH with no uv makes `uv python find` fail the same way a missing interpreter does.
  // /usr/bin:/bin keeps `bash` itself resolvable (spawnSync's own env replaces process.env
  // wholesale, so bash must be found in the same restricted PATH) while omitting the
  // directory uv actually lives in on this machine (~/.local/bin).
  const r = spawnSync('bash', [SHIM, 'explain', 'ls'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /uv python install 3\.14/);
  assert.strictEqual(r.stdout, '');
});
