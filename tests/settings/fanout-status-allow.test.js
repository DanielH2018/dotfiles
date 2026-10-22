// The auto-mode classifier denied a fan-out status poll as "External System Writes" on
// 2026-09-25, so the allow list names the command as read-only. server#4346 moved the
// command behind scripts/dev/fanout.py, which the issue-fanout skill tells sessions to type;
// the old fanout_place.py path stays as a shim (#829). The hint must name both forms.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function allow() {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box', homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' })).autoMode.allow;
}

test('one auto-mode hint names both fan-out status forms as read-only', { skip }, () => {
  const hints = allow().filter((e) => e.includes('scripts/dev/fanout.py place status <run-id>'));
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes('scripts/dev/fanout_place.py status <run-id>'), hints[0]);
  assert.ok(hints[0].includes('read-only'), hints[0]);
});
