// The 2026-11-01 auto-mode audit found the classifier refusing two force-with-lease pushes to
// fan-out branches and one `land.sh --arm-merge`, and three `ssh daniel-server` runs of a
// tagged initial_setup.yml that the soft_deny deploy clearance named only in its local form.
// Neither allow entry is host-gated: sessions on every host push branches and land PRs.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');
const HOSTS = ['daniel-box', 'daniel-server', 'daniel-pi', 'work-laptop'];

function autoMode(hostname) {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname, homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' })).autoMode;
}

test('every host allows force-with-lease to a feature branch, never to master or main', { skip }, () => {
  for (const hostname of HOSTS) {
    const hits = autoMode(hostname).allow.filter((e) => e.startsWith('`git push --force-with-lease`'));
    assert.strictEqual(hits.length, 1, hostname);
    for (const excluded of ['`master`', '`main`', '`--force`', '`-f`']) {
      assert.ok(hits[0].includes(excluded), `${hostname}: ${excluded}`);
    }
  }
});

test('every host allows land.sh on the session\'s own PR, excluding --any-author', { skip }, () => {
  for (const hostname of HOSTS) {
    const hits = autoMode(hostname).allow.filter((e) => e.startsWith('`./scripts/deploy_tools/land.sh --pr <n>`'));
    assert.strictEqual(hits.length, 1, hostname);
    assert.ok(hits[0].includes('`--any-author`'), hostname);
  }
});

test('the deploy clearance names the ssh daniel-server form of a tagged initial_setup run', { skip }, () => {
  const clearance = autoMode('daniel-box').soft_deny.filter((e) => e.includes('owed.jsonl'));
  assert.strictEqual(clearance.length, 1);
  assert.ok(clearance[0].includes('ssh daniel-server'), clearance[0]);
  assert.ok(clearance[0].includes('-e target=daniel-server'), clearance[0]);
});
