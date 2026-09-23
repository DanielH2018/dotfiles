// Coverage for wait_for_running() in sandbox-proxy.sh — the gate both the socket
// proxy and the create-filter pass through before the sandbox is allowed to run.
//
// It used to count attempts: 15 polls of `docker inspect`, then "failed to start
// after 15 attempts". A poll count is not a wait. Each iteration costs one inspect
// plus 0.2s of sleep, and an inspect is microseconds on an idle host and can be most
// of a second on a loaded one — so the budget shrank exactly when the container
// needed it most, and a slow host reported a start failure for a proxy that was
// coming up normally. The replacement is a wall-clock deadline, and the middle test
// below is the one that tells the two designs apart: under a slow inspect the old
// loop runs its 15 polls regardless, while a deadline ends when the time is up.
//
// sandbox-proxy.sh is sourced by the launcher and runs nothing at load time, so
// these source it for real rather than extracting the function. docker is stubbed
// on PATH; nothing here starts a container. Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { run } = require('../lib/run');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const PROXY_LIB = srcPath('private_dot_claude', 'sandbox', 'executable_sandbox-proxy.sh');

const skip = process.platform === 'win32' ? 'sandbox lib is Unix-only' : skipUnless('bash');

// A docker stub whose `inspect` walks STATES, one per call, repeating the last entry
// once it runs out. DELAY makes each call slow, standing in for a loaded host.
function dockerStub(states, delay = '0') {
  const dir = scratch(os.tmpdir(), 'proxy-wait-');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/bash
[ "$1" = inspect ] || exit 0
sleep ${delay}
n=0
[ -f "$STUB_CALLS" ] && n=$(cat "$STUB_CALLS")
n=$((n + 1))
printf '%s' "$n" > "$STUB_CALLS"
states=(${states.map((s) => `'${s}'`).join(' ')})
i=$((n - 1))
[ "$i" -lt "\${#states[@]}" ] || i=$(( \${#states[@]} - 1 ))
printf '%s\\n' "\${states[$i]}"
`, { mode: 0o755 });
  return dir;
}

function waitFor(stubDir, { timeout = '30' } = {}) {
  const started = Date.now();
  const r = run('bash', ['-c', `. "$1"; wait_for_running proxy-ctr`, 'bash', PROXY_LIB], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      STUB_CALLS: path.join(stubDir, 'calls'),
      SANDBOX_PROXY_START_TIMEOUT: timeout,
    },
  });
  return { ...r, elapsed: Date.now() - started };
}

test('returns once the container reports running', { skip }, () => {
  const r = waitFor(dockerStub(['created', 'created', 'running']));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stderr, '', 'a container that came up must report nothing');
});

// The property the attempt count could not hold. Every inspect here takes 0.3s and
// the container never comes up: a 15-poll loop would spend ~7.5s before giving up
// whatever budget was asked for, while a deadline of 1s ends at 1s.
test('gives up on the wall clock rather than on a number of polls', { skip }, () => {
  const r = waitFor(dockerStub(['created'], '0.3'), { timeout: '1' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /did not report running within 1s/,
    'the failure must name the budget it actually applied');
  assert.ok(r.elapsed < 4000,
    `waited ${r.elapsed}ms for a 1s budget — the wait is still counting polls`);
});

// Both containers run with --rm, so one that died is removed and inspect answers
// nothing. Waiting out the rest of the budget only delays a failure already decided.
test('fails fast when the container has gone rather than waiting out the budget', { skip }, () => {
  const r = waitFor(dockerStub(['created', '']), { timeout: '30' });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /exited before it was ready/);
  assert.ok(r.elapsed < 5000, `waited ${r.elapsed}ms for a container that was already gone`);
});
