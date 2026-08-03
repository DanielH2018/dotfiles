// Regression guard for executable_bt-hid-kick.
//
// Drives the ACTUAL script with stub systemctl/notify-send on PATH, so it never restarts the
// real Bluetooth stack -- which on this box would risk provoking the very wedge the watchdog
// exists to recover from.
//
// Two properties matter. It must start the FORCE unit: bt-hid-health.service honours
// MIN_RESTART_INTERVAL=600, so binding the plain unit to a key produces a button that no-ops for
// up to ten minutes in exactly the situation you would press it. And a refused start must be
// visible -- the polkit grant is only exercised by this one path, so it can rot unnoticed until
// the day someone presses the key with no pointer to debug it.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_bt-hid-kick');

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

const dirs = [];

function mkdtemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function run({ started = true } = {}) {
  const bin = mkdtemp('bhk-bin-');
  const marks = mkdtemp('bhk-marks-');
  const log = path.join(marks, 'calls');

  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "${log}"
exit ${started ? 0 : 1}
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/bash
printf 'notify %s\\n' "$*" >> "${log}"
`, { mode: 0o755 });

  const res = { status: 0, out: '' };
  try {
    res.out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: mkdtemp('bhk-home-') },
    });
  } catch (e) {
    res.status = e.status;
    res.out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  res.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  return res;
}

test('starts the force unit, not the rate-limited one', { skip }, () => {
  const { status, calls } = run();
  assert.strictEqual(status, 0);
  assert.match(calls, /^systemctl start bt-hid-health-force\.service$/m);
  assert.doesNotMatch(calls, /start bt-hid-health\.service/);
});

test('a successful kick toasts that bluetoothd is restarting', { skip }, () => {
  const { calls, out } = run();
  assert.match(calls, /notify .*Restarting bluetoothd/);
  assert.match(out, /Restarting bluetoothd/);
});

test('a refused start is surfaced and exits non-zero', { skip }, () => {
  const { status, calls, out } = run({ started: false });
  assert.notStrictEqual(status, 0, 'a silent failure here is invisible until the key is needed');
  assert.match(calls, /notify .*Could not kick Bluetooth/);
  assert.match(calls, /dialog-error/);
  assert.match(out, /Could not kick/);
});

process.on('exit', () => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
