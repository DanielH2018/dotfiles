// Behavioral test for the StopFailure hook (executable_stop-failure.sh). Real bash against
// the ACTUAL hook, with osascript and systemctl stubbed on PATH so no run draws a real
// notification or starts a real unit, and both branches run on every platform. Skips without
// bash/jq.
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

const SESSION_CGROUP = '0::/user.slice/user-1000.slice/session-1.scope\n';
const BATCH_CGROUP =
  '0::/user.slice/user-1000.slice/user@1000.service/app.slice/fanout-dotfiles-850.service\n';

// Runs the hook on one payload and returns what each stub was called with, '' when it was
// not. `cgroup` stands in for /proc/self/cgroup, so a run inside a fan-out batch does not read
// the batch's own. The stubs inherit the hook's stdout, so execFileSync returns only once a
// backgrounded stub has exited and written its log. Runs that share `dir` share the stamp
// directory the quiet window reads.
function run(payload, cgroup = SESSION_CGROUP, dir = scratch(os.tmpdir(), 'sf-')) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ['osascript', 'systemctl']) {
    fs.writeFileSync(path.join(bin, tool),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${path.join(dir, tool)}'\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'cgroup'), cgroup);
  execFileSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      STOP_FAILURE_CGROUP_FILE: path.join(dir, 'cgroup'), XDG_RUNTIME_DIR: dir,
    },
    cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const calls = (tool) => {
    const f = path.join(dir, tool);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };
  return { osascript: calls('osascript'), systemctl: calls('systemctl') };
}

const notified = (payload) => run(payload).osascript;

test('notifies on the error field the harness sends for a rate limit', { skip }, () => {
  assert.match(notified({ hook_event_name: 'StopFailure', error: 'rate_limit' }), /Rate limited/);
});

test('does not notify for a server error', { skip }, () => {
  assert.strictEqual(notified({ hook_event_name: 'StopFailure', error: 'server_error' }), '');
});

const START = (instance) => `start\n--no-block\n--no-ask-password\nclaude-stop-alert@${instance}.service\n`;

test('starts the alert unit with an instance naming the cause', { skip }, () => {
  assert.strictEqual(run({ hook_event_name: 'StopFailure', error: 'server_error' }).systemctl,
    START('server_error'));
});

test('replaces characters a unit instance may not carry', { skip }, () => {
  assert.strictEqual(run({ hook_event_name: 'StopFailure', error: 'x/../y z' }).systemctl,
    START('x____y_z'));
});

test('names an empty cause unknown, since the polkit rule refuses an empty instance', { skip }, () => {
  assert.strictEqual(run({ hook_event_name: 'StopFailure', error: '' }).systemctl,
    START('unknown'));
});

test('pages once per cause inside the quiet window', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'sf-');
  run({ hook_event_name: 'StopFailure', error: 'rate_limit' }, SESSION_CGROUP, dir);
  run({ hook_event_name: 'StopFailure', error: 'rate_limit' }, SESSION_CGROUP, dir);
  const { systemctl } = run({ hook_event_name: 'StopFailure', error: 'overloaded' }, SESSION_CGROUP, dir);
  assert.strictEqual(systemctl,
    START('rate_limit') + START('overloaded'));
});

test('skips the alert inside a fan-out batch, which pages on its own', { skip }, () => {
  const payload = { hook_event_name: 'StopFailure', error: 'rate_limit' };
  assert.strictEqual(run(payload, BATCH_CGROUP).systemctl, '');
  assert.notStrictEqual(run(payload, SESSION_CGROUP).systemctl, '');
});
