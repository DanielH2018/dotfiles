// The auto-mode classifier allows the homelab-takeover-check sudo wrapper on daniel-box only,
// the one host server#5494 installs it on (#860). Rendered under named hostnames, because
// the suite runs on whichever machine pushes.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');
const WRAPPER = 'sudo -n /usr/local/sbin/homelab-takeover-check';

function allow(hostname) {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname, homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' })).autoMode.allow;
}

test('daniel-box allows the takeover-check wrapper and keeps $defaults first', { skip }, () => {
  const entries = allow('daniel-box');
  assert.strictEqual(entries[0], '$defaults');
  assert.strictEqual(entries.filter((e) => e.includes(WRAPPER)).length, 1);
});

test('no other host allows the takeover-check wrapper', { skip }, () => {
  for (const hostname of ['daniel-server', 'daniel-pi', 'work-laptop']) {
    assert.ok(!allow(hostname).some((e) => e.includes('homelab-takeover-check')), hostname);
  }
});
