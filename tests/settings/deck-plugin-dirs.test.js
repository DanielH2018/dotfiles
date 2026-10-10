// The deck mod loads in every session on the two k3s nodes through CLAUDE_CODE_PLUGIN_DIRS
// (#797). Rendered under named hostnames, because the suite runs on whichever machine pushes.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function render(data) {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify(data),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' }));
}

test('daniel-box and daniel-server load the deck mod from the primary server checkout', { skip }, () => {
  for (const hostname of ['daniel-box', 'daniel-server']) {
    const s = render({ chezmoi: { hostname, homeDir: '/home/ubuntu' } });
    assert.strictEqual(
      s.env.CLAUDE_CODE_PLUGIN_DIRS, '/home/ubuntu/server/.claude/plugins/deck', hostname,
    );
  }
});

test('no other host and no agent user sets CLAUDE_CODE_PLUGIN_DIRS', { skip }, () => {
  for (const data of [
    { chezmoi: { hostname: 'work-laptop' } },
    { chezmoi: { hostname: 'daniel-pi' } },
    { chezmoi: { hostname: 'daniel-server' }, agent: true },
  ]) {
    assert.ok(!('CLAUDE_CODE_PLUGIN_DIRS' in render(data).env), JSON.stringify(data));
  }
});
