const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');

const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_echo-push-notification.sh');

function run(payload) {
  const r = spawnSync('bash', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out).systemMessage : '';
}

const notify = (message, tool_response) => ({
  tool_name: 'PushNotification',
  tool_input: { message, status: 'proactive' },
  tool_response,
});

test('a phone push is echoed into the transcript', () => {
  assert.strictEqual(
    run(notify('build failed: 2 auth tests', 'Terminal notification sent. Mobile push requested.')),
    'Sent to phone: build failed: 2 auth tests',
  );
});

test('a push the tool skipped is labelled as not sent', () => {
  const msg = run(notify('PR merged', 'Not sent — this terminal is active, so your output here already reaches the user.'));
  assert.strictEqual(msg, 'Notification not sent (terminal active): PR merged');
});

test('a push with Remote Control off is labelled desktop-only', () => {
  const msg = run(notify('PR merged', 'Terminal notification sent. Mobile push not sent (Remote Control inactive).'));
  assert.strictEqual(msg, 'Notification sent to the desktop only: PR merged');
});

test('quotes and newlines in the message survive as valid JSON', () => {
  const text = 'run `gh variable set "X"`\nthen land';
  assert.strictEqual(run(notify(text, 'Mobile push requested.')), `Sent to phone: ${text}`);
});

test('no message, no output', () => {
  assert.strictEqual(run({ tool_name: 'PushNotification', tool_input: {} }), '');
});
