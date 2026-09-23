// Regression guard for bin/effort (home/dot_local/bin/executable_effort).
//
// The property that matters is the way back out. effortLevel is carried forward across every
// `chezmoi apply` by claude-settings-merge's RUNTIME_OWNED_KEYS, so a pin set once outlives the
// session that set it; the script could set all five levels and clear none, which left the
// deployed settings.json pinned at `medium` against settings.base.json's stated intent that the
// key stay absent. `auto` is the reverse state, and it deletes the key rather than storing a
// sixth value, because absence is what leaves effort unpinned.
//
// $HOME is a scratch directory, so nothing here touches the real settings.json. Skips without
// bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');
const { run } = require('../lib/run');

const EFFORT = srcPath('dot_local', 'bin', 'executable_effort');

const skip = skipUnless('bash', 'jq');

// A settings.json carrying a neighbouring key, so a test can prove the script edited only
// effortLevel. A jq filter that rewrote the document would pass a test that read effortLevel
// alone.
function fakeHome(t, settings) {
  const home = scratch(os.tmpdir(), 'effort-home-', t);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'claude-opus-5', ...settings }, null, 2),
  );
  return home;
}

function settingsOf(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
}

function effort(home, ...args) {
  return run('bash', [EFFORT, ...args], { env: { ...process.env, HOME: home } });
}

test('auto deletes effortLevel rather than storing a value', { skip }, (t) => {
  const home = fakeHome(t, { effortLevel: 'medium' });

  const r = effort(home, 'auto');

  assert.strictEqual(r.code, 0, r.stderr);
  const after = settingsOf(home);
  assert.ok(!('effortLevel' in after), `key still present: ${JSON.stringify(after)}`);
  assert.strictEqual(after.model, 'claude-opus-5');
});

test('a level still pins, and only that key', { skip }, (t) => {
  const home = fakeHome(t, {});

  const r = effort(home, 'xhigh');

  assert.strictEqual(r.code, 0, r.stderr);
  const after = settingsOf(home);
  assert.strictEqual(after.effortLevel, 'xhigh');
  assert.strictEqual(after.model, 'claude-opus-5');
});

test('an unknown level is refused and the file is untouched', { skip }, (t) => {
  const home = fakeHome(t, { effortLevel: 'medium' });

  const r = effort(home, 'unpin');

  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /Invalid effort level: unpin/);
  // The valid-options line is what tells a caller `auto` exists, so it is asserted.
  assert.match(r.stderr, /auto/);
  assert.strictEqual(settingsOf(home).effortLevel, 'medium');
});
