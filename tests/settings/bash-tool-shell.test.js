// CLAUDE_CODE_SHELL pins the Bash tool to bash on macOS and Linux (#1246). Windows runs Git Bash
// whatever the setting says, and /bin/bash is no Windows path, so the key stays out there.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function render(os) {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { os, hostname: 'work-laptop' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' }));
}

test('macOS and Linux pin the Bash tool to /bin/bash', { skip }, () => {
  for (const os of ['darwin', 'linux']) {
    assert.strictEqual(render(os).env.CLAUDE_CODE_SHELL, '/bin/bash', os);
  }
});

test('Windows leaves CLAUDE_CODE_SHELL unset', { skip }, () => {
  assert.ok(!('CLAUDE_CODE_SHELL' in render('windows').env));
});
