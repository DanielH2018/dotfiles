// Regression guard for bin/effort (home/dot_local/bin/executable_effort).
//
// The property that matters is the way back out. effortLevel is carried forward across every
// `chezmoi apply` by claude-settings-merge's RUNTIME_OWNED_KEYS, so a pin set once outlives the
// session that set it whenever the template leaves the key unset. The script could set all
// five levels and clear none. `auto` is the reverse state, and it deletes the key rather than
// storing a sixth value, because absence is what leaves effort unpinned. `clear-model` is the
// reverse state for the per-model key that `/effort` writes on Opus 5.5.
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

// On Opus 5.5, `/effort` writes modelSettings.<model>.effortLevel rather than the top-level
// key, and the per-model key wins. The script read only .effortLevel, so on 2026-09-28 it
// printed `medium` while every request ran at `xhigh` (#696). The three tests below cover
// reporting that key, clearing it, and warning when a top-level set is still overridden.
const PER_MODEL = {
  model: 'claude-opus-5-5',
  effortLevel: 'medium',
  modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh', other: 1 } },
};

test('the current level reports a per-model effort pin', { skip }, (t) => {
  const home = fakeHome(t, PER_MODEL);

  const r = run('bash', [EFFORT], { env: { ...process.env, HOME: home }, input: '' });

  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /claude-opus-5-5=xhigh/);
});

test('clear-model deletes only the per-model effortLevel', { skip }, (t) => {
  const home = fakeHome(t, PER_MODEL);

  const r = effort(home, 'clear-model');

  assert.strictEqual(r.code, 0, r.stderr);
  const after = settingsOf(home);
  assert.deepStrictEqual(after.modelSettings, { 'claude-opus-5-5': { other: 1 } });
  assert.strictEqual(after.effortLevel, 'medium');
  assert.strictEqual(after.model, 'claude-opus-5-5');
});

test('setting a level warns while a per-model pin still overrides it', { skip }, (t) => {
  const home = fakeHome(t, PER_MODEL);

  const r = effort(home, 'low');

  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(settingsOf(home).effortLevel, 'low');
  assert.match(r.stderr, /claude-opus-5-5=xhigh/);
  assert.match(r.stderr, /clear-model/);
});
