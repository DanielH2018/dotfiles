// Regression guard for executable_streamcontroller-health.
//
// Drives the ACTUAL script against fixture trees (SC_HEALTH_SYSFS / SC_HEALTH_PROC)
// with stub pgrep/flatpak/systemctl on PATH, so it never touches the real machine.
//
// The behaviour worth pinning is the health signal itself. The script must ask "does
// StreamController hold the deck's USB node", NOT "does anything hold it" -- on this
// box winedevice.exe opens every USB device whenever a Wine prefix is running, so the
// looser question reports a healthy deck for as long as a game is open. That is the
// `wine` case below, and it is the reason this file exists.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_streamcontroller-health');

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }
const skip = bashOk ? false : 'bash unavailable';

const NODE = '/dev/bus/usb/001/021';
const dirs = [];

function mkdtemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// A sysfs tree containing the deck, or an empty one when attached is false.
function makeSysfs(attached) {
  const root = mkdtemp('sch-sysfs-');
  if (attached) {
    const dev = path.join(root, '1-1.4.4');
    fs.mkdirSync(dev);
    fs.writeFileSync(path.join(dev, 'idProduct'), '006d\n');
    fs.writeFileSync(path.join(dev, 'idVendor'), '0fd9\n');
    fs.writeFileSync(path.join(dev, 'busnum'), '1\n');
    fs.writeFileSync(path.join(dev, 'devnum'), '21\n');
  }
  return root;
}

// A /proc tree. `holders` are pids whose fd/3 points at the deck node.
function makeProc(pids, holders) {
  const root = mkdtemp('sch-proc-');
  for (const pid of pids) {
    const fd = path.join(root, String(pid), 'fd');
    fs.mkdirSync(fd, { recursive: true });
    fs.symlinkSync(holders.includes(pid) ? NODE : '/dev/null', path.join(fd, '3'));
  }
  return root;
}

// Stub bin dir. STUB_PIDS drives pgrep; once flatpak kill runs it reports none, which
// is what lets the script's "wait for the old instance to die" loop terminate.
function makeStubs() {
  const bin = mkdtemp('sch-bin-');
  const marks = mkdtemp('sch-marks-');

  // -c matches real pgrep: it prints the count even when that count is zero, and still
  // exits 1. A stub that stayed silent on no-match is what let the script's
  // `|| printf '0'` fallback append a second 0 without any test noticing.
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/bash
pids="\${STUB_PIDS:-}"
[ -e "${marks}/killed" ] && pids=""
for a in "$@"; do
  if [ "$a" = "-c" ]; then
    n=0
    [ -n "$pids" ] && n=$(printf '%s\\n' $pids | wc -l)
    printf '%s\\n' "$n"
    [ "$n" -gt 0 ] || exit 1
    exit 0
  fi
done
[ -z "$pids" ] && exit 1
printf '%s\\n' $pids
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'flatpak'), `#!/bin/bash
[ "$1" = "kill" ] && touch "${marks}/killed"
exit 0
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/bash
for a in "$@"; do
  case "$a" in
    is-active) [ -n "\${STUB_NO_SESSION:-}" ] && exit 1 || exit 0 ;;
    is-failed) [ -n "\${STUB_UNIT_FAILED:-}" ] && exit 0 || exit 1 ;;
    start) echo "start" >> "${marks}/systemctl"; exit 0 ;;
  esac
done
exit 0
`, { mode: 0o755 });

  return { bin, marks };
}

function run({ attached = true, pids = [], holders = [], unitFailed = false, noSession = false, state, home }) {
  const { bin, marks } = makeStubs();
  const fakeHome = home || mkdtemp('sch-home-');
  const resetBin = path.join(fakeHome, '.local', 'bin');
  fs.mkdirSync(resetBin, { recursive: true });
  fs.writeFileSync(path.join(resetBin, 'streamdeck-usb-reset'), `#!/bin/bash
echo reset >> "${marks}/reset"
`, { mode: 0o755 });

  const out = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: fakeHome,
      SC_HEALTH_SYSFS: makeSysfs(attached),
      SC_HEALTH_PROC: makeProc(pids, holders),
      XDG_RUNTIME_DIR: state,
      STUB_PIDS: pids.join(' '),
      ...(unitFailed ? { STUB_UNIT_FAILED: '1' } : {}),
      ...(noSession ? { STUB_NO_SESSION: '1' } : {}),
    },
  });

  return {
    out,
    restarted: fs.existsSync(path.join(marks, 'systemctl')),
    didReset: fs.existsSync(path.join(marks, 'reset')),
  };
}

test('no deck attached is a no-op, not a fault', { skip }, () => {
  const r = run({ attached: false, pids: [111], state: mkdtemp('sch-state-') });
  assert.match(r.out, /no Stream Deck attached/);
  assert.equal(r.restarted, false);
});

test('deck held by StreamController is healthy', { skip }, () => {
  const r = run({ pids: [111], holders: [111], state: mkdtemp('sch-state-') });
  assert.equal(r.out.trim(), '');
  assert.equal(r.restarted, false);
});

test('a non-StreamController holder does not count as healthy', { skip }, () => {
  // pid 222 holds the node but is not StreamController, so it is absent from
  // STUB_PIDS -- exactly the winedevice.exe shape. `fuser` would have called this
  // healthy; the script must strike instead.
  const r = run({ pids: [111], holders: [222], state: mkdtemp('sch-state-') });
  assert.match(r.out, /strike 1\/2/);
  assert.equal(r.restarted, false);
});

test('a deliberate quit stays quit', { skip }, () => {
  // Nothing running and the unit is not failed: the user closed the app. Restarting
  // here would make it impossible to turn off. Asserting only "did not restart" on a
  // single run proves nothing -- one run can never get past strike 1. The guard is
  // working only if no strike accrues at all, so a second check still does nothing.
  const state = mkdtemp('sch-state-');
  const first = run({ pids: [], unitFailed: false, state });
  assert.equal(first.restarted, false);
  assert.doesNotMatch(first.out, /strike/);

  const second = run({ pids: [], unitFailed: false, state });
  assert.equal(second.restarted, false);
});

test('no graphical session is a no-op, however broken the deck looks', { skip }, () => {
  // The pre-login incident exactly: deck attached, nothing holding it, unit already
  // failed from an earlier burst. Every signal says "recover", but starting the app
  // here launches GTK against no display and it segfaults. Two runs, so a strike
  // accrued by the first would show up as a restart in the second.
  const state = mkdtemp('sch-state-');
  const first = run({ pids: [], holders: [], unitFailed: true, noSession: true, state });
  assert.match(first.out, /no graphical session/);
  assert.equal(first.restarted, false);

  const second = run({ pids: [], holders: [], unitFailed: true, noSession: true, state });
  assert.equal(second.restarted, false);
  assert.equal(second.didReset, false, 'must not touch USB before anyone has logged in');
});

test('two consecutive strikes trigger a reset-then-restart', { skip }, () => {
  const state = mkdtemp('sch-state-');
  const first = run({ pids: [111], holders: [], state });
  assert.match(first.out, /strike 1\/2/);
  assert.equal(first.restarted, false);

  const second = run({ pids: [111], holders: [], state });
  assert.match(second.out, /recovering/);
  assert.equal(second.didReset, true, 'must reset the USB device before restarting');
  assert.equal(second.restarted, true);
});

test('a healthy check clears an outstanding strike', { skip }, () => {
  const state = mkdtemp('sch-state-');
  run({ pids: [111], holders: [], state });          // strike 1
  run({ pids: [111], holders: [111], state });       // recovered on its own
  const third = run({ pids: [111], holders: [], state });
  assert.match(third.out, /strike 1\/2/, 'strike count must have been reset');
  assert.equal(third.restarted, false);
});

test('restarts are capped within the hour', { skip }, () => {
  const state = mkdtemp('sch-state-');
  // Pre-load the ledger with the hour's allowance, all timestamped now.
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(state, 'streamcontroller-health.restarts'), `${now}\n${now}\n${now}\n`);
  fs.writeFileSync(path.join(state, 'streamcontroller-health.strikes'), '1');

  const r = run({ pids: [111], holders: [], state });
  assert.match(r.out, /not retrying/);
  assert.equal(r.restarted, false);
});

process.on('exit', () => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
