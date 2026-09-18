// Covers home/dot_local/bin/executable_mullvad-settings-watch.
//
// The check exists because a Mullvad tunnel running at a tenth of the line rate is
// indistinguishable from a healthy one unless something measures it. That makes two
// failure modes worse than a missed finding: reporting clean when the settings could
// not actually be read, and firing every day for a setup that is doing nothing wrong.
// Most of what is below is about those two.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');

const SRC = srcPath('dot_local', 'bin', 'executable_mullvad-settings-watch');
const body = fs.readFileSync(SRC, 'utf8');

// jq is the one the script cannot work without; the rest are what it shells out to.
const PASSTHROUGH = ['bash', 'sh', 'cat', 'rm', 'mkdir', 'true', 'jq', 'cksum', 'cut', 'date', 'head'];

// The settings this box was left in after the 2026-08-15 measurements: the healthy case.
function settings({ daita = false, multihop = true, quantum = 'on', entry = ['us', 'chi'], exit = ['us', 'chi'] } = {}) {
  const loc = (city) => (city ? { only: { location: { city } } } : { only: { location: { country: 'us' } } });
  return {
    relay_settings: {
      normal: {
        location: loc(exit),
        wireguard_constraints: { use_multihop: multihop, entry_location: loc(entry) },
      },
    },
    tunnel_options: { wireguard: { daita: { enabled: daita }, quantum_resistant: quantum } },
  };
}

function run({ json, raw, mode = 0o644, env = {}, home: reuse } = {}) {
  const home = reuse || scratch(os.tmpdir(), 'mullvad-watch-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('bash', ['-c', `type -P ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real && !fs.existsSync(path.join(binDir, name))) fs.symlinkSync(real, path.join(binDir, name));
  }
  const log = path.join(home, 'notify.log');
  // Stubbed, never the real one: a suite that reaches the session bus draws a desktop
  // banner on every run, which has happened here before.
  fs.writeFileSync(path.join(binDir, 'notify-send'), '#!/bin/sh\necho "notify $*" >> "$LOG"\n', { mode: 0o755 });

  const file = path.join(home, 'settings.json');
  fs.writeFileSync(file, raw !== undefined ? raw : JSON.stringify(json ?? settings(), null, 2), { mode });

  const script = path.join(home, 'mullvad-settings-watch');
  fs.writeFileSync(script, body, { mode: 0o755 });
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `${JSON.stringify(script)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, LOG: log, MULLVAD_SETTINGS: file, ...env },
  });
  return {
    out,
    home,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    notifications: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  };
}

test('reports clean on the configuration this box was left in', () => {
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.doesNotMatch(r.out, /FINDINGS/);
  assert.match(r.out, /daita=off multihop=on quantum=on entry=us\/chi exit=us\/chi/);
});

test('flags DAITA coming back on', () => {
  const r = run({ json: settings({ daita: true }) });
  assert.strictEqual(r.exitCode, 1, r.out);
  assert.match(r.out, /DAITA is on, expected off/);
  assert.match(r.notifications, /notify .*Mullvad settings drifted/);
});

// The original bug: entry left at `country us` while the exit was pinned to Chicago,
// so Mullvad picked us-lax-wg-603 and every packet crossed the country and back.
test('flags an unconstrained entry while the exit is pinned to a city', () => {
  const r = run({ json: settings({ entry: null }) });
  assert.strictEqual(r.exitCode, 1, r.out);
  assert.match(r.out, /entry is unconstrained while the exit is pinned to us\/chi/);
});

// The reverse trap: moving the exit and leaving the entry pinned recreates the detour.
test('flags an entry city that no longer matches the exit', () => {
  const r = run({ json: settings({ exit: ['us', 'nyc'] }) });
  assert.strictEqual(r.exitCode, 1, r.out);
  assert.match(r.out, /entry us\/chi does not match exit us\/nyc/);
});

test('flags multihop being turned off', () => {
  const r = run({ json: settings({ multihop: false }) });
  assert.strictEqual(r.exitCode, 1, r.out);
  assert.match(r.out, /multihop is off, expected on/);
});

// A check that cries wolf gets muted and then detects nothing. An exit at country scope
// has no city for the entry to match, so there is nothing to report.
test('stays quiet when the exit is not pinned to a city', () => {
  const r = run({ json: settings({ exit: null, entry: null }) });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.doesNotMatch(r.out, /FINDINGS/);
});

test('does not demand a matching entry when multihop is off', () => {
  const r = run({ json: settings({ multihop: false, entry: null }), env: { MULLVAD_WATCH_EXPECT_MULTIHOP: 'off' } });
  assert.strictEqual(r.exitCode, 0, r.out);
});

// The worst outcome is not a missed finding, it is a confident all-clear. An upgrade that
// moves the schema must land here rather than in the healthy branch.
test('exits 2 rather than clean when the schema is unrecognised', () => {
  const r = run({ json: { tunnel_options: { wireguard: {} } } });
  assert.strictEqual(r.exitCode, 2, r.out);
  assert.match(r.out, /unrecognised settings schema/);
  assert.doesNotMatch(r.out, /FINDINGS/);
});

test('exits 2 when the settings file cannot be read', () => {
  const r = run({ raw: '{}', mode: 0o000 });
  assert.strictEqual(r.exitCode, 2, r.out);
  assert.match(r.out, /cannot read/);
});

test('exits 2 on malformed JSON instead of reporting clean', () => {
  const r = run({ raw: 'not json at all' });
  assert.strictEqual(r.exitCode, 2, r.out);
});

// Expectations are overridable so a policy change does not need the script edited.
test('MULLVAD_WATCH_EXPECT_DAITA=on treats DAITA as required', () => {
  const clean = run({ json: settings({ daita: true }), env: { MULLVAD_WATCH_EXPECT_DAITA: 'on' } });
  assert.strictEqual(clean.exitCode, 0, clean.out);
  const drifted = run({ env: { MULLVAD_WATCH_EXPECT_DAITA: 'on' } });
  assert.strictEqual(drifted.exitCode, 1, drifted.out);
  assert.match(drifted.out, /DAITA is off, expected on/);
});

// An unchanged finding tells you nothing the last banner already did.
test('does not re-notify for an unchanged finding inside the window', () => {
  const first = run({ json: settings({ daita: true }) });
  assert.match(first.notifications, /notify/);
  const second = run({ json: settings({ daita: true }), home: first.home });
  assert.strictEqual(second.exitCode, 1, second.out);
  const count = (second.notifications.match(/notify/g) || []).length;
  assert.strictEqual(count, 1, 'the second run must not raise a fresh banner');
});

test('re-notifies once the repeat window lapses', () => {
  const first = run({ json: settings({ daita: true }) });
  const second = run({ json: settings({ daita: true }), home: first.home, env: { MULLVAD_WATCH_REPEAT_AFTER: '0' } });
  const count = (second.notifications.match(/notify/g) || []).length;
  assert.strictEqual(count, 2, 'a lapsed window must raise the finding again');
});

