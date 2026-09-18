// The claude-guard bin shim: resolves uv's managed 3.14 and execs the package CLI.
// Pins the two properties the spec's failure contract rests on: no uv-managed 3.14
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

test('the shim\'s own lookup ignores a real cwd venv only because of --system',
  { skip: skipUnless('uv') }, (t) => {
    // A *dangling* or wrong-version cwd venv is not the risk `--system` guards against: uv
    // already probes a discovered venv's interpreter and falls back to the managed toolchain
    // on its own regardless of `--system`. The one shape that actually differs is a REAL,
    // version-matching venv found by walking up from cwd -- exactly what a project's own
    // `.venv` is -- which uv prefers over the managed install unless `--system` is present.
    const argv = shimLookupArgv(SHIM);
    assert.ok(argv.includes('--system'), argv.join(' '));

    const cwd = scratch(os.tmpdir(), 'claude-guard-real-venv-', t);
    const venv = path.join(cwd, '.venv');
    const created = spawnSync('uv', ['venv', '--python', '3.14', venv], { encoding: 'utf8' });
    if (created.status !== 0) {
      t.skip(`uv venv --python 3.14 unavailable: ${created.stderr}`);
      return;
    }

    const r = spawnSync('uv', ['python', 'find', ...argv], { encoding: 'utf8', cwd });
    assert.strictEqual(r.status, 0, r.stderr);
    const found = r.stdout.trim();
    assert.ok(!found.startsWith(cwd), `got the cwd venv instead of managed: ${found}`);
    assert.match(found, /\/uv\/python\//);
    assert.ok(fs.statSync(found).isFile(), found);

    // Control: the fixture must actually discriminate -- without --system the same lookup,
    // from the same cwd, must prefer the venv it just proved --system skips. If uv's own
    // preference for a cwd venv ever changes, skip visibly rather than pass for no reason.
    const argvNoSystem = argv.filter((a) => a !== '--system');
    const r2 = spawnSync('uv', ['python', 'find', ...argvNoSystem], { encoding: 'utf8', cwd });
    if (r2.status !== 0) {
      t.skip('uv python find without --system did not return 0; behaviour changed');
      return;
    }
    const found2 = r2.stdout.trim();
    if (!found2.startsWith(cwd)) {
      t.skip('uv no longer prefers a cwd venv without --system; the control no longer discriminates');
      return;
    }
    assert.ok(found2.startsWith(cwd));
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
