// Covers home/.chezmoiscripts/os-unix/run_onchange_after_seed-skins-prefs.sh.tmpl.
//
// The plugin rewrites its store file on every `/skin` change, so the behaviour worth pinning
// is that the seed writes only where the file is absent and never clobbers a host's own
// choices. The file name is the other half: the plugin derives it from the plugin id, and a
// seed under the wrong name is silently ignored.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-unix', 'run_onchange_after_seed-skins-prefs.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const STORE_NAME = `skins_hellosverre-mods-${crypto.createHash('sha256').update('skins@hellosverre-mods').digest('hex').slice(0, 12)}.json`;

function runSeed(home) {
  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderTemplate(body));
  execFileSync('sh', [scriptFile], { env: { HOME: home, PATH: process.env.PATH } });
  return path.join(home, '.claude', 'plugins', 'store', STORE_NAME);
}

test('store file name is the plugin store hash of the plugin id', () => {
  assert.ok(body.includes(STORE_NAME), `script must write ${STORE_NAME}`);
});

test('seeds catppuccin with the band off on a host with no store file', { skip }, () => {
  const home = scratch(os.tmpdir(), 'skins-seed-');
  const file = runSeed(home);
  const { prefs } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(prefs.skin, 'catppuccin');
  assert.strictEqual(prefs.band, false);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('leaves an existing store file untouched', { skip }, () => {
  const home = scratch(os.tmpdir(), 'skins-seed-');
  const store = path.join(home, '.claude', 'plugins', 'store');
  fs.mkdirSync(store, { recursive: true });
  const existing = '{"custom":{},"prefs":{"skin":"nord","band":true}}\n';
  fs.writeFileSync(path.join(store, STORE_NAME), existing);
  const file = runSeed(home);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), existing);
});
