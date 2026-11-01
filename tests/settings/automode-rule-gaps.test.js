// `claude auto-mode critique` (2026-11-01) found three rules whose wording let the classifier
// allow what the setup means to stop. The sops allow read as covering an editor override that
// prints the decrypted file (#1109). The deploy soft deny exempted `--check`, under which
// `check_mode: false` tasks run for real (#1110). The environment called the live hosts
// "non-production" while three other entries treat a master push as a production deploy (#1111).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function autoMode() {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box', homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' })).autoMode;
}

test('the sops allow names sops set and excludes every editor variable', { skip }, () => {
  const hits = autoMode().allow.filter((e) => e.includes('ansible/vars/secrets.yml') && e.includes('`sops set'));
  assert.strictEqual(hits.length, 1);
  for (const name of ['SOPS_EDITOR', 'EDITOR', 'VISUAL', '`exec-env`', '`--output`']) {
    assert.ok(hits[0].includes(name), name);
  }
});

test('the deploy soft deny covers --check and exempts only --dry-run', { skip }, () => {
  const hits = autoMode().soft_deny.filter((e) => e.startsWith('Running `scripts/deploy.sh`'));
  assert.strictEqual(hits.length, 1);
  assert.ok(!hits[0].includes('WITHOUT `--check`'), hits[0]);
  assert.ok(hits[0].includes('`check_mode: false`'), hits[0]);
  assert.ok(hits[0].includes('`scripts/deploy.sh --dry-run`'), hits[0]);
});

test('no environment entry calls the live hosts non-production', { skip }, () => {
  assert.ok(!autoMode().environment.some((e) => e.includes('non-production')));
});
