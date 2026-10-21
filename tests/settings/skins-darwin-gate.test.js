// The skins plugin and its hellosverre-mods marketplace are left out on darwin, the work
// laptop, where the plugin is disabled and a registered marketplace would still clone the
// third-party repo. Both halves are rendered under a named OS, because the suite runs on
// whichever machine pushes and the gate's polarity has to be checked from every one of them.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function renderAs(os) {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { os } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' }));
}

test('linux enables skins and registers its marketplace', { skip }, () => {
  const s = renderAs('linux');
  assert.strictEqual(s.enabledPlugins['skins@hellosverre-mods'], true);
  assert.strictEqual(s.extraKnownMarketplaces['hellosverre-mods'].source.repo, 'hellosverre/claude-skins');
});

test('darwin neither enables skins nor registers its marketplace', { skip }, () => {
  const s = renderAs('darwin');
  assert.ok(!('skins@hellosverre-mods' in s.enabledPlugins));
  assert.ok(!('hellosverre-mods' in s.extraKnownMarketplaces));
});
