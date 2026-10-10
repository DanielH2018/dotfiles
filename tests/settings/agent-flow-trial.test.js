// The agent-flow mod trial (#794): installed on daniel-box only, from a copy pinned to the
// audited commit. Both halves are rendered under a named hostname, because the suite runs on
// whichever machine pushes and the gate's polarity has to be checked from every one of them.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');
const EXTERNAL = srcPath('.chezmoiexternal.toml.tmpl');
const DIR = '.local/share/claude-agent-flow';

function renderAs(hostname, file) {
  return execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname } }),
  ], { input: fs.readFileSync(file, 'utf8'), encoding: 'utf8' });
}

test('daniel-box enables agent-flow from the pinned local copy', { skip }, () => {
  const s = JSON.parse(renderAs('daniel-box', SETTINGS));
  assert.strictEqual(s.enabledPlugins['agent-flow@claude-agent-flow'], true);
  const { source } = s.extraKnownMarketplaces['claude-agent-flow'];
  assert.strictEqual(source.source, 'directory');
  assert.ok(source.path.endsWith(`/${DIR}`), source.path);
});

test('the external pins agent-flow to a full commit and a checksum', { skip }, () => {
  const toml = renderAs('daniel-box', EXTERNAL);
  assert.match(toml, new RegExp(`^\\["${DIR.replace(/[./]/g, '\\$&')}"\\]$`, 'm'));
  assert.match(toml, /^\s*url = "https:\/\/github\.com\/Charlie0113-T\/claude-agent-flow\/archive\/[0-9a-f]{40}\.tar\.gz"$/m);
  assert.match(toml, /^\s*checksum\.sha256 = "[0-9a-f]{64}"$/m);
});

test('no other host installs or enables agent-flow', { skip }, () => {
  for (const host of ['daniel-server', 'work-laptop']) {
    const s = JSON.parse(renderAs(host, SETTINGS));
    assert.ok(!('agent-flow@claude-agent-flow' in s.enabledPlugins), host);
    assert.ok(!('claude-agent-flow' in s.extraKnownMarketplaces), host);
    assert.strictEqual(renderAs(host, EXTERNAL).trim(), '', host);
  }
});
