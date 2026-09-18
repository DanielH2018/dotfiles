// Regression guard for executable_desk-away.
//
// Drives the ACTUAL script with stub kscreen-doctor/loginctl/dbus-send on PATH, so it never
// touches the real session or the real displays.
//
// Two properties carry the whole script and both fail silently if broken:
//
//   * the lock must happen BEFORE the blank -- the lock screen appearing wakes the display, so
//     the reverse order leaves the screens lit and looks like DPMS simply not working;
//   * a failed lock must NOT blank anyway -- dark screens read as "locked" from across the room,
//     so blanking an unlocked session is the one outcome worse than doing nothing.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_desk-away');

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

function mkdtemp(prefix) {
  const d = scratch(os.tmpdir(), prefix);
  return d;
}

// Every stub appends to one log, so the test can assert on ORDER and not just on occurrence.
function makeStubs({ dpms, loginctlOk, dbusOk }) {
  const bin = mkdtemp('da-bin-');
  const marks = mkdtemp('da-marks-');
  const log = path.join(marks, 'calls');

  fs.writeFileSync(path.join(bin, 'kscreen-doctor'), `#!/bin/bash
printf 'kscreen %s\\n' "$*" >> "${log}"
if [ "$1 $2" = "--dpms show" ]; then
  for s in HDMI-A-1 DP-1 DP-2 DP-3; do echo "dpms mode for screen $s: ${dpms}"; done
fi
exit 0
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\\n' "$*" >> "${log}"
exit ${loginctlOk ? 0 : 1}
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'dbus-send'), `#!/bin/bash
printf 'dbus-send %s\\n' "$*" >> "${log}"
exit ${dbusOk ? 0 : 1}
`, { mode: 0o755 });

  return { bin, log };
}

function run({ dpms = 'on', loginctlOk = true, dbusOk = true } = {}) {
  const { bin, log } = makeStubs({ dpms, loginctlOk, dbusOk });
  const res = { status: 0, out: '' };
  try {
    res.out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: mkdtemp('da-home-') },
    });
  } catch (e) {
    res.status = e.status;
    res.out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  res.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return res;
}

test('displays on -> locks the session, then blanks', { skip }, () => {
  const { status, calls } = run({ dpms: 'on' });
  assert.strictEqual(status, 0);
  assert.match(calls, /loginctl lock-session/);
  assert.match(calls, /kscreen --dpms off/);
  assert.ok(
    calls.indexOf('loginctl lock-session') < calls.indexOf('kscreen --dpms off'),
    `the lock must precede the blank, got:\n${calls}`,
  );
});

test('displays already blanked -> wakes them and does not lock', { skip }, () => {
  const { status, calls } = run({ dpms: 'off' });
  assert.strictEqual(status, 0);
  assert.match(calls, /kscreen --dpms on/);
  assert.doesNotMatch(calls, /lock-session/);
  assert.doesNotMatch(calls, /--dpms off/);
});

test('loginctl cannot resolve a session -> falls back to the screensaver bus', { skip }, () => {
  const { status, calls } = run({ dpms: 'on', loginctlOk: false, dbusOk: true });
  assert.strictEqual(status, 0);
  assert.match(calls, /dbus-send.*org\.freedesktop\.ScreenSaver\.Lock/);
  assert.match(calls, /kscreen --dpms off/);
});

test('no way to lock at all -> leaves the displays on and exits non-zero', { skip }, () => {
  const { status, calls, out } = run({ dpms: 'on', loginctlOk: false, dbusOk: false });
  assert.notStrictEqual(status, 0, 'a session left unlocked must not report success');
  assert.doesNotMatch(calls, /--dpms off/, 'blanking an unlocked session is worse than doing nothing');
  assert.match(out, /could not lock/);
});

test('the toggle direction is read from the live DPMS state, not a state file', { skip }, () => {
  const { calls } = run({ dpms: 'on' });
  assert.match(calls, /kscreen --dpms show/, 'the script must ask what state the displays are in');
});

