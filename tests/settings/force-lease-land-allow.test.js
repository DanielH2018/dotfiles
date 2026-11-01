// The 2026-11-01 auto-mode audit found the classifier refusing two force-with-lease pushes to
// fan-out branches and one `land.sh --arm-merge`, and three `ssh daniel-server` runs of a
// tagged initial_setup.yml. Those runs now go through server#6881's owed_run.py, whose
// allow entry replaces the soft_deny's clearance for a hand-typed run. Neither the push nor
// the land.sh entry is host-gated: sessions on every host push branches and land PRs.
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

test('an owed manual_plane line clears through owed_run.py, never a hand-typed run', { skip }, () => {
  const { allow, soft_deny } = autoMode('daniel-box');
  const hits = allow.filter((e) => e.startsWith('`uv run python scripts/deploy_tools/owed_run.py <role>`'));
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].includes("another session's PR"), hits[0]);
  const deploy = soft_deny.filter((e) => e.startsWith('Running `scripts/deploy.sh`'));
  assert.strictEqual(deploy.length, 1);
  assert.ok(deploy[0].includes('owed_run.py'), deploy[0]);
  assert.ok(!deploy[0].includes('ssh daniel-server'), deploy[0]);
});
