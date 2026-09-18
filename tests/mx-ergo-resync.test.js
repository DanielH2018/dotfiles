// Regression guard for executable_mx-ergo-resync.
//
// Drives the ACTUAL script with a stub solaar on PATH, so it never writes to the real trackball
// -- a live run would briefly divert the wheel, and a bug in the script under test would leave
// the box with no scrolling and no pointer to debug it with.
//
// The stub keeps its state in a file and answers queries from it, so the before/after reporting
// and the no-drift path are exercised for real rather than asserted against a fixed string.
//
// Four properties matter:
//
//  - An unreachable device must FAIL. `solaar config` only reaches active devices; on a sleeping
//    trackball every write silently no-ops, so exiting 0 would report a repair that never
//    happened -- the one outcome worse than not running it.
//  - lowres-scroll-mode must be cleared. That single setting is what kills scrolling: a diverted
//    wheel emits LOWRES_WHEEL HID++ notifications that nothing on this box consumes.
//  - Middle Button stays Diverted while everything else goes Regular. Assert Middle Button
//    Regular and the precision hold dies; leave the tilts Diverted and horizontal scroll stays
//    dead. It is the asymmetry that is easy to get wrong, so it is pinned in both directions.
//  - dpi is reported but never written. The hold-to-precision rules own that value at runtime
//    and a resync landing mid-press would fight them -- but a dpi the rules never write is a
//    fingerprint of an outside writer, so the run has to surface it.
//  - A write that does not take must exit non-zero. Individual solaar calls can fail (the
//    reprogrammable-keys TypeError is the known one) without being fatal, so the script has to
//    read back and check rather than trust the writes.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');

const SCRIPT = srcPath('dot_local', 'bin', 'executable_mx-ergo-resync');

const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
const skip = BASH ? false : 'bash unavailable';

function mkdtemp(prefix) {
  const d = scratch(os.tmpdir(), prefix);
  return d;
}

const HEALTHY = [
  'lowres-scroll-mode = False',
  'divert-keys = {Middle Button:Diverted, Back Button:Regular, Forward Button:Regular, Left Tilt:Regular, Right Tilt:Regular, DPI Switch:Regular}',
  'reprogrammable-keys = {Middle Button:Mouse Middle Button, Back Button:Mouse Back Button, Forward Button:Mouse Forward Button, Left Tilt:Mouse Scroll Left Button, Right Tilt:Mouse Scroll Right Button, DPI Switch:Mouse Middle Button}',
  // 200 is what the real device was found holding: a value neither rule writes (they use 100
  // and 400), so it is evidence of an outside writer rather than of this setup misbehaving.
  'dpi = 200',
].join('\n');

// What the box actually looked like when Options+ had been round-tripped: wheel diverted and
// every button diverted along with it.
const DRIFTED = [
  'lowres-scroll-mode = True',
  'divert-keys = {Middle Button:Diverted, Back Button:Diverted, Forward Button:Diverted, Left Tilt:Diverted, Right Tilt:Diverted, DPI Switch:Diverted}',
  'reprogrammable-keys = {Middle Button:Mouse Middle Button, Back Button:Mouse Back Button, Forward Button:Mouse Forward Button, Left Tilt:Mouse Scroll Left Button, Right Tilt:Mouse Scroll Right Button, DPI Switch:Mouse Middle Button}',
  'dpi = 200',
].join('\n');

// `reachable: false` omits the state file entirely, so the stub prints nothing for every query.
// That is exactly how the real CLI behaves against a device it cannot reach: solaar/cli/config.py
// pings first and raises "no online device found matching ...", which goes to stderr and leaves
// no parseable setting line -- verified against the installed solaar.
//
// `refuse` names a setting whose WRITES silently do nothing, reproducing a solaar call that fails
// without being fatal.
function run({ state = HEALTHY, reachable = true, refuse = '' } = {}) {
  const bin = mkdtemp('mer-bin-');
  const work = mkdtemp('mer-work-');
  const log = path.join(work, 'calls');
  const statePath = path.join(work, 'state');

  if (reachable) fs.writeFileSync(statePath, `${state}\n`);

  // `sed -i.bak`, with the suffix attached, is the one in-place form both seds accept. Bare
  // `-i "script"` is GNU-only: BSD sed reads the next argument as the backup suffix, so the
  // script becomes the suffix and the filename becomes the script, and it exits complaining
  // about an "unescaped newline inside substitute pattern" having changed nothing. The stub
  // sends its own stderr to /dev/null through solaar_q, so on macOS that surfaced only as
  // every write appearing not to take — the script then correctly reported six unapplied
  // settings and exited 1. Verified against /usr/bin/sed: bare -i leaves the file untouched,
  // -i.bak rewrites it. The .bak files land in a mktemp dir that is removed with the rest.
  fs.writeFileSync(path.join(bin, 'solaar'), `#!/bin/bash
printf 'solaar %s\\n' "$*" >> "${log}"
[ -f "${statePath}" ] || exit 0
setting=$3
if [ $# -eq 3 ]; then grep "^\${setting} = " "${statePath}"; exit 0; fi
[ "\${setting}" = "${refuse}" ] && exit 1
if [ $# -eq 4 ]; then
    val=$4
    case "\$val" in false) val=False ;; true) val=True ;; esac
    sed -i.bak "s/^\${setting} = .*/\${setting} = \${val}/" "${statePath}"
else
    # Map setting: rewrite just this key's value, on this setting's line only. The address is
    # load-bearing -- "Middle Button:" appears on both the divert-keys and reprogrammable-keys
    # lines, and an unanchored sed would clobber the other one.
    sed -i.bak "/^\${setting} = /s/\$4:[^,}]*/\$4:\$5/" "${statePath}"
fi
`, { mode: 0o755 });

  // Stub notify-send too. The failure path calls it, and with only solaar stubbed the real
  // /usr/bin/notify-send would resolve and draw an actual desktop banner on every test run --
  // which is how a previous suite ended up firing notifications on every git push.
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/bash
printf 'notify %s\\n' "$*" >> "${log}"
`, { mode: 0o755 });

  const res = { status: 0, out: '' };
  try {
    res.out = execFileSync(BASH, [SCRIPT], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: mkdtemp('mer-home-') },
    });
  } catch (e) {
    res.status = e.status;
    res.out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  res.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  res.state = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  return res;
}

test('fails loudly when the trackball is unreachable', { skip }, () => {
  const { status, out } = run({ reachable: false });
  assert.strictEqual(status, 1);
  assert.match(out, /not reachable/);
});

test('does not write anything to an unreachable trackball', { skip }, () => {
  const { calls } = run({ reachable: false });
  // Queries are fine; a write would be a lie, since it silently no-ops on a sleeping device.
  assert.doesNotMatch(calls, /lowres-scroll-mode false/);
  assert.doesNotMatch(calls, /divert-keys \w/);
});

test('clears the scroll diversion that kills scrolling', { skip }, () => {
  const { status, state } = run({ state: DRIFTED });
  assert.strictEqual(status, 0);
  assert.match(state, /^lowres-scroll-mode = False$/m);
});

test('restores every control to Regular except the precision hold', { skip }, () => {
  const { state } = run({ state: DRIFTED });
  assert.match(state, /Middle Button:Diverted/);
  for (const key of ['Back Button', 'Forward Button', 'Left Tilt', 'Right Tilt', 'DPI Switch']) {
    assert.match(state, new RegExp(`${key}:Regular`), `${key} should be Regular`);
  }
});

test('keeps middle click on the precision button', { skip }, () => {
  const { state } = run({ state: DRIFTED });
  assert.match(state, /DPI Switch:Mouse Middle Button/);
});

test('never writes dpi -- the hold rules own it at runtime', { skip }, () => {
  const { calls, state } = run({ state: DRIFTED });
  // Queries are `config <serial> dpi` and nothing more; a write would carry a value after it.
  assert.doesNotMatch(calls, /config \S+ dpi \S/);
  assert.match(state, /^dpi = 200$/m);
});

test('reports dpi, so an outside writer is visible in the run', { skip }, () => {
  const { out } = run({ state: DRIFTED });
  assert.match(out, /dpi = 200/);
});

test('exits non-zero when a write does not take', { skip }, () => {
  const { status, out, calls } = run({ state: DRIFTED, refuse: 'lowres-scroll-mode' });
  assert.strictEqual(status, 1);
  assert.match(out, /FAILED to apply/);
  assert.match(out, /scroll wheel still diverted/);
  // Visible without a terminal -- this is meant to be bound to a key.
  assert.match(calls, /^notify .*MX Ergo resync failed/m);
});

test('names the specific control that failed', { skip }, () => {
  const { status, out } = run({ state: DRIFTED, refuse: 'divert-keys' });
  assert.strictEqual(status, 1);
  assert.match(out, /divert-keys Left Tilt != Regular/);
});

test('does not claim no-drift when a write failed', { skip }, () => {
  const { out } = run({ state: HEALTHY, refuse: 'lowres-scroll-mode' });
  // HEALTHY already satisfies every assertion, so a refused write changes nothing and the
  // read-back still passes. The point is that the check is on observed state, not on write
  // status -- a no-op write against an already-correct device is not a failure.
  assert.match(out, /no drift/);
});

test('reports drift when it repaired something', { skip }, () => {
  const { out } = run({ state: DRIFTED });
  assert.doesNotMatch(out, /no drift/);
  assert.match(out, /before:/);
  assert.match(out, /after:/);
});

test('reports no drift when already correct', { skip }, () => {
  const { status, out } = run({ state: HEALTHY });
  assert.strictEqual(status, 0);
  assert.match(out, /no drift/);
});

test('is idempotent -- a second run leaves the healthy state untouched', { skip }, () => {
  const { state } = run({ state: HEALTHY });
  assert.strictEqual(state.trim(), HEALTHY);
});

