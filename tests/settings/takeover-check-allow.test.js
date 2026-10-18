// The auto-mode classifier allows the homelab-takeover-check sudo wrapper on daniel-box only,
// the one host server#5494 installs it on (#860). That entry only takes effect because
// daniel-box also drops the `Bash(sudo:*)` deny, which Claude Code evaluates before the
// classifier; claude_guard's sudo-boundary rule carries the boundary there (#863). Rendered
// under named hostnames, because the suite runs on whichever machine pushes.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');
const WRAPPER = 'sudo -n /usr/local/sbin/homelab-takeover-check';

function render(hostname) {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname, homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' }));
}

const allow = (hostname) => render(hostname).autoMode.allow;

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

test('only daniel-box drops the sudo deny, and no host drops the su deny', { skip }, () => {
  const box = render('daniel-box').permissions.deny;
  assert.ok(!box.includes('Bash(sudo:*)'), 'daniel-box: the deny would shadow the allow entry');
  assert.ok(box.includes('Bash(su:*)'), 'daniel-box keeps su denied');
  for (const hostname of ['daniel-server', 'daniel-pi', 'work-laptop']) {
    const deny = render(hostname).permissions.deny;
    assert.ok(deny.includes('Bash(sudo:*)'), `${hostname} keeps sudo denied`);
    assert.ok(deny.includes('Bash(su:*)'), `${hostname} keeps su denied`);
  }
});
