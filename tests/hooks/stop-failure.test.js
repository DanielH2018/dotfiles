// Behavioral test for the StopFailure hook (executable_stop-failure.sh). Real bash against
// the ACTUAL hook, with osascript stubbed on PATH so no run draws a real notification and
// the branch runs on every platform. Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_stop-failure.sh');

const skip = skipUnless('bash', 'jq');

// Runs the hook on one payload and returns what the osascript stub was called with, or ''.
// The stub inherits the hook's stdout, so execFileSync returns only once the backgrounded
// stub has exited and written its log.
function notified(payload) {
  const dir = scratch(os.tmpdir(), 'sf-');
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\n`, { mode: 0o755 });
  execFileSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, cwd: dir, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
}

test('notifies on the error field the harness sends for a rate limit', { skip }, () => {
  assert.match(notified({ hook_event_name: 'StopFailure', error: 'rate_limit' }), /Rate limited/);
});

test('does not notify for a server error', { skip }, () => {
  assert.strictEqual(notified({ hook_event_name: 'StopFailure', error: 'server_error' }), '');
});
