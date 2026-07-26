// Guards the test-isolation seams themselves, not agentview's behaviour.
//
// The bug this exists to prevent: agentview reads its Windows-side inputs from absolute
// /mnt/c paths, so a suite that builds a temp HOME still reads the operator's live machine.
// The ui and hotkeys suites did exactly that -- they rendered the real Windows sessions next
// to their fixtures ("4 sessions - 2 machines" where the fixtures seed two) and every
// row-position assertion shifted. It read as flakiness because it tracked whether a Claude
// session happened to be running on the Windows side at that moment.
//
// Pinning the individual files fixes today. This file fixes tomorrow: it fails when a new
// seam appears in the script, and when a new agentview suite forgets the helper.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentviewWinSeams } = require('./lib/agentview-env');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'home', 'dot_local', 'bin', 'executable_agentview');
const SELF = path.basename(__filename);

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const suites = fs.readdirSync(__dirname)
  .filter((f) => /^agentview.*\.test\.js$/.test(f) && f !== SELF)
  .sort();

test('the suite list is non-empty', () => {
  // A glob that silently matches nothing would make every check below vacuous.
  assert.ok(suites.length >= 6, `expected the agentview suites, found ${suites.length}`);
});

test('the helper covers every absolute /mnt seam the script defaults', () => {
  // Derived, not hardcoded: `VAR="${AGENT_VIEW_X:-/mnt/...}"` is the shape of a seam that a
  // temp HOME cannot move and a PATH stub cannot shadow. AGENT_VIEW_WIN_GITBASH is excluded
  // by the /mnt/ anchor on purpose -- its default is a native C:\ path passed to wezterm as
  // an argument, never executed from WSL.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const found = [...src.matchAll(/\$\{(AGENT_VIEW_[A-Z_]+):-\/mnt\//g)].map((m) => m[1]);

  assert.ok(found.length > 0, 'found no /mnt seams -- has the script moved or the shape changed?');
  assert.deepStrictEqual(
    [...new Set(found)].sort(),
    [...agentviewWinSeams.SEAMS].sort(),
    'a /mnt seam in executable_agentview is not covered by tests/lib/agentview-env.js',
  );
});

test('every agentview suite pins the seams through the shared helper', () => {
  const offenders = suites.filter((f) => {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // Only suites that actually run the script need the seams pinned.
    if (!src.includes('executable_agentview')) return false;
    return !/require\(['"]\.\/lib\/agentview-env['"]\)/.test(src);
  });

  assert.deepStrictEqual(offenders, [],
    `these suites run agentview without tests/lib/agentview-env.js: ${offenders.join(', ')}`);
});

test('no agentview suite hand-rolls a seam the helper owns', () => {
  // Setting one directly is how the files drift back apart -- the helper stops being the
  // single place a new seam has to land.
  const bad = [];
  for (const f of suites) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const seam of agentviewWinSeams.SEAMS) {
      if (new RegExp(`${seam}\\s*:`).test(src)) bad.push(`${f} sets ${seam}`);
    }
  }
  assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('the helper returns all three seams', () => {
  const bin = scratch('avseam-bin-');
  const { env } = agentviewWinSeams({ bin, scratch });
  assert.deepStrictEqual(Object.keys(env).sort(), [...agentviewWinSeams.SEAMS].sort());
});

test('the registry defaults to a fresh empty dir, not the real one', () => {
  const bin = scratch('avseam-bin-');
  const { windir } = agentviewWinSeams({ bin, scratch });
  assert.ok(fs.existsSync(windir), 'windir should exist');
  assert.deepStrictEqual(fs.readdirSync(windir), [], 'windir should start empty');
  assert.ok(!windir.startsWith('/mnt/'), `windir must not point at Windows: ${windir}`);
});

test('wezterm is absent by default so its [ -x ] guards short-circuit', () => {
  const bin = scratch('avseam-bin-');
  const { wezterm } = agentviewWinSeams({ bin, scratch });
  assert.ok(!fs.existsSync(wezterm), 'default wezterm seam should not exist');
  assert.ok(!wezterm.startsWith('/mnt/'), 'default wezterm seam must not be the real binary');
});

test('a wezterm body makes the stub real and executable', () => {
  const bin = scratch('avseam-bin-');
  const { wezterm } = agentviewWinSeams({ bin, scratch, weztermBody: '#!/bin/bash\nexit 0\n' });
  assert.ok(fs.existsSync(wezterm));
  assert.ok(fs.statSync(wezterm).mode & 0o111, 'stub should be executable');
});

test('the claude.exe stub is executable and answers an empty roster', () => {
  const bin = scratch('avseam-bin-');
  const { winClaude } = agentviewWinSeams({ bin, scratch });
  assert.ok(fs.statSync(winClaude).mode & 0o111, 'stub should be executable');
  assert.match(fs.readFileSync(winClaude, 'utf8'), /\[\]/);
});

test('a caller-supplied windir is used as-is', () => {
  const bin = scratch('avseam-bin-');
  const mine = scratch('avseam-win-');
  const { windir } = agentviewWinSeams({ bin, scratch, windir: mine });
  assert.strictEqual(windir, mine);
});
