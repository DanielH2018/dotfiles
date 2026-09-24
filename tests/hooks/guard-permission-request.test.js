// The PermissionRequest/Bash shim's failure contract: whatever cannot run prints nothing, so
// the permission prompt stands, and nothing it starts may run unbounded (#581, #657).
//
// PermissionRequest has no `ask`: the hook either allows, denies, or says nothing and leaves
// the prompt up. Silence is therefore this allow-only hook's non-allow verdict. What was
// missing was the bound. `uv python find` and the Python judge both ran bare, so a hung one
// held the hook until the harness killed it at 10s. Drives the ACTUAL hook with a stub `uv`
// on PATH that hands back a stub interpreter, so no real uv or Python is needed.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_guard-permission-request.sh');

const skip = skipUnless('bash', 'timeout');

const DIR = scratch(os.tmpdir(), 'guard-perm-req-');
const BIN = path.join(DIR, 'bin');
const SHARE = path.join(DIR, 'share');
fs.mkdirSync(BIN);
fs.mkdirSync(path.join(SHARE, 'claude_guard'), { recursive: true });
fs.writeFileSync(path.join(SHARE, 'claude_guard', 'cli.py'), '');
const PY = path.join(DIR, 'python3.14');
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
// The stub judge echoes a fixed allow after reading its stdin, or hangs, or fails after
// printing the allow, as STUB_PY says.
fs.writeFileSync(PY, `#!/bin/bash
cat >/dev/null
case "\${STUB_PY:-}" in
  slow) sleep 30 ;;
  fail) printf '%s\\n' '${ALLOW}'; exit 1 ;;
esac
printf '%s\\n' '${ALLOW}'
`, { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'uv'), `#!/bin/bash
[ -n "\${STUB_UV_SLOW:-}" ] && sleep 30
printf '%s\\n' ${JSON.stringify(PY)}
`, { mode: 0o755 });

function run(env = {}) {
  const started = Date.now();
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${BIN}:${process.env.PATH}`, CLAUDE_GUARD_HOME: SHARE,
      CLAUDE_GUARD_TIMEOUT_S: '1', ...env,
    },
  });
  return { ...r, seconds: (Date.now() - started) / 1000 };
}

test('a judge that answers has its verdict passed through', { skip }, () => {
  const r = run();
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), ALLOW);
});

test('a hung uv python find is cut off, prints nothing, and says why', { skip }, () => {
  const r = run({ STUB_UV_SLOW: '1' });
  assert.ok(r.seconds < 8, `took ${r.seconds}s`);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /uv python find.*within 1s \(timeout\).*not evaluated/);
});

test('a hung judge is cut off, prints nothing, and says why', { skip }, () => {
  const r = run({ STUB_PY: 'slow' });
  assert.ok(r.seconds < 8, `took ${r.seconds}s`);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /claude_guard.*within 1s \(timeout\).*not evaluated/);
});

test('a judge that exits non-zero has its output dropped', { skip }, () => {
  const r = run({ STUB_PY: 'fail' });
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /exit 1.*not evaluated/);
});

test('a missing run-bounded.sh prints nothing and names the library', { skip }, () => {
  const r = run({ RUN_BOUNDED_LIB: path.join(DIR, 'no-such-lib.sh') });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /cannot load .*not evaluated/);
});
