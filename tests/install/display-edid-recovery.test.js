// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-display-edid-recovery.sh.tmpl.
//
// Two things are worth testing here and they are not the same thing.
//
// The health script is the part with logic: it decides, from EDID bytes alone, whether a display
// came back wrong, and it must decide that without ever naming a connector -- DP connector names
// have rotated between sessions on this box, so a check keyed on "DP-3" would pass here and be
// aimed at the wrong monitor after a reboot. It also must not act on a healthy display: the
// recovery writes to a live connector's `status`, so a false positive is a screen that blinks
// for no reason every two minutes. Most of the file is that: fake /sys/class/drm trees, real
// EDID bytes, and assertions about which connectors come back.
//
// The installer is the part with no logic, but two details in it are load-bearing and silent
// when wrong. The resume unit needs `After=` on the sleep targets as well as `WantedBy=`, or it
// runs on the way into suspend instead of on the way out and never sees the failure. And no unit
// may set ProtectKernelTunables, which would remount /sys read-only and make every recovery a
// no-op that still logs success.
//
// The `sleep` stub is the hook that makes the recovery ladder testable: the real script re-reads
// the tree after each reprobe, so a stub that repairs the fake tree on the Nth sleep decides
// exactly which rung "works", with no timing race.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-display-edid-recovery.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// Real binaries the health script needs; PATH is replaced wholesale by the stub dir, so anything
// not listed here and not stubbed simply won't exist.
const PASSTHROUGH = ['sh', 'bash', 'cat', 'cp', 'wc', 'od', 'grep', 'install', 'date', 'tee', 'chmod', 'ls', 'mkdir', 'printf', 'echo', 'cmp', 'rm', 'dirname', 'uname', 'command'];

const dirs = [];
let renderedCache;
// Pinned to the workstation profile: this script is gated behind is-desktop-linux, so it renders
// to zero bytes on a server-profile host and every assertion below fails there for no reason.
// See the `profile` note in tests/lib/render.js.
const rendered = () => (renderedCache ??= renderFile(SRC, { profile: 'workstation' }));

// The health script is embedded in the installer as a quoted heredoc, so it is extracted rather
// than duplicated here -- a copy in the test would keep passing after the real one drifted.
function healthScript() {
  const body = rendered();
  const start = body.indexOf("<<'DISPLAY_EDID_HEALTH'\n");
  assert.ok(start !== -1, 'installer no longer contains the DISPLAY_EDID_HEALTH heredoc');
  const from = start + "<<'DISPLAY_EDID_HEALTH'\n".length;
  const end = body.indexOf('\nDISPLAY_EDID_HEALTH\n', from);
  assert.ok(end !== -1, 'DISPLAY_EDID_HEALTH heredoc is unterminated');
  return body.slice(from, end);
}

// A minimal but structurally real EDID: 128 bytes, the fixed 00 FF..FF 00 header, and the PNP
// manufacturer id packed into bytes 8-9 as three 5-bit letters with A=1.
function edid(vendor) {
  const buf = Buffer.alloc(128);
  buf[0] = 0x00;
  for (let i = 1; i <= 6; i++) buf[i] = 0xff;
  buf[7] = 0x00;
  const v = vendor.split('').reduce((acc, ch) => (acc << 5) | (ch.charCodeAt(0) - 64), 0);
  buf.writeUInt16BE(v & 0x7fff, 8);
  return buf;
}

// connectors: [{ name, status, edid }] where edid is a Buffer, or null for "no EDID at all".
function fakeDrm(root, connectors) {
  const drm = path.join(root, 'sys', 'class', 'drm');
  for (const c of connectors) {
    const dir = path.join(drm, c.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status'), `${c.status}\n`);
    fs.writeFileSync(path.join(dir, 'edid'), c.edid ?? Buffer.alloc(0));
  }
  return drm;
}

function stubDir(root) {
  const binDir = path.join(root, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real && !fs.existsSync(path.join(binDir, name))) fs.symlinkSync(real, path.join(binDir, name));
  }
  return binDir;
}

// Runs the extracted health script against a fake tree.
//
// `repairAfter` is the sleep number on which the stub writes a good EDID back and restores
// `status` to "connected" -- i.e. it plays the part of the kernel honouring the reprobe. The
// call order in the non-forced path is: confirm delay (1), settle after re-detect (2), the 1s
// inside the forced off/detect (3), settle after that (4). So repairAfter:2 exercises the first
// rung succeeding and repairAfter:4 the second, while leaving it unset exercises neither working.
function runHealth({ connectors, args = [], repairAfter, repairVendor = 'GSM', minInterval = 0, stampAgeSeconds, readOnlyStatus = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'display-edid-'));
  dirs.push(root);
  const drm = fakeDrm(root, connectors);
  const binDir = stubDir(root);
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // The repair target is whichever connector the test made broken; there is only ever one.
  const target = connectors.find((c) => c.status === 'connected' && (!c.edid || c.edid.length < 128 || c.vendor === 'NVD'));
  fs.writeFileSync(path.join(root, 'good.edid'), edid(repairVendor));

  // Stands in for the kernel between the script's writes and its next read.
  //
  // Restoring `status` to "connected" on every tick is not a convenience, it is the part that
  // makes the test honest: the real `status` attribute is write-to-command, read-as-state, so it
  // always reads back "connected" or "disconnected" no matter what was written to it. A fake tree
  // that leaves the literal "detect" sitting in the file makes the very first reprobe look like a
  // success -- the connector stops reading "connected", so it drops out of the broken list -- and
  // every escalation test passes without the escalation ever running.
  fs.writeFileSync(path.join(binDir, 'sleep'), `#!/bin/sh
n=$(cat "$SLEEP_COUNT" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$SLEEP_COUNT"
echo "$1" >> "$SLEEP_LOG"
[ -n "\${REPAIR_CONN:-}" ] || exit 0
echo connected > "$DRM_DIR/$REPAIR_CONN/status"
if [ -n "\${REPAIR_AFTER:-}" ] && [ "$n" -ge "$REPAIR_AFTER" ]; then
  cp "$GOOD_EDID" "$DRM_DIR/$REPAIR_CONN/edid"
fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'logger'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

  if (stampAgeSeconds !== undefined) {
    const then = Math.floor(Date.now() / 1000) - stampAgeSeconds;
    fs.writeFileSync(path.join(stateDir, 'last-recovery'), `${then}\n`);
  }

  const scriptFile = path.join(root, 'display-edid-health');
  fs.writeFileSync(scriptFile, healthScript(), { mode: 0o755 });

  // Stands in for a sandbox that left /sys read-only: the script's writes fail rather than being
  // ignored, which is a different diagnosis and has to read differently in the journal.
  if (readOnlyStatus && target) fs.chmodSync(path.join(drm, target.name, 'status'), 0o444);

  const env = {
    PATH: binDir,
    HOME: root,
    DRM_DIR: drm,
    STATE_DIR: stateDir,
    CONFIRM_DELAY: '1',
    SETTLE: '1',
    MIN_INTERVAL: String(minInterval),
    SLEEP_COUNT: path.join(root, 'sleepcount'),
    SLEEP_LOG: path.join(root, 'sleeplog'),
    GOOD_EDID: path.join(root, 'good.edid'),
  };
  // REPAIR_CONN is set whenever there is a broken connector at all, repairAfter or not: the stub
  // needs it to normalise `status` even in the scenarios where the EDID never comes back.
  if (target) env.REPAIR_CONN = target.name;
  if (repairAfter !== undefined) env.REPAIR_AFTER = String(repairAfter);

  const out = execFileSync(path.join(binDir, 'bash'), ['-c', `bash ${JSON.stringify(scriptFile)} ${args.join(' ')} 2>&1; echo "EXIT:$?"`], { encoding: 'utf8', env });
  const readStatus = (name) => fs.readFileSync(path.join(drm, name, 'status'), 'utf8').trim();
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    readStatus,
    sleeps: fs.existsSync(env.SLEEP_LOG) ? fs.readFileSync(env.SLEEP_LOG, 'utf8').trim().split('\n') : [],
  };
}

const healthy = (name, vendor = 'GSM') => ({ name, status: 'connected', edid: edid(vendor) });
const placeholder = (name) => ({ name, status: 'connected', edid: edid('NVD'), vendor: 'NVD' });
const noEdid = (name, status = 'connected') => ({ name, status, edid: null });

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('leaves a fully healthy set of connectors alone', { skip }, () => {
  const r = runHealth({ connectors: [healthy('card1-DP-1'), healthy('card1-DP-3'), healthy('card1-HDMI-A-1', 'AUS')] });
  assert.strictEqual(r.exitCode, 0);
  // Nothing was written to any connector, which is the property that matters: the recovery
  // touches a live display, so acting on a healthy one is worse than not acting at all.
  assert.strictEqual(r.readStatus('card1-DP-3'), 'connected');
  assert.doesNotMatch(r.out, /forcing/);
  assert.deepStrictEqual(r.sleeps, []);
});

test('ignores a disconnected connector that has no EDID', { skip }, () => {
  // An unplugged port is the ordinary case of "connector with no EDID" and must never be treated
  // as a fault, or the timer would reprobe an empty port every two minutes forever.
  const r = runHealth({ connectors: [healthy('card1-DP-1'), noEdid('card1-DP-2', 'disconnected')] });
  assert.strictEqual(r.exitCode, 0);
  assert.doesNotMatch(r.out, /forcing/);
});

test('detects the NVIDIA placeholder EDID and recovers on the first rung', { skip }, () => {
  const r = runHealth({ connectors: [healthy('card1-DP-1'), placeholder('card1-DP-3')], repairAfter: 2 });
  assert.strictEqual(r.exitCode, 0);
  assert.match(r.out, /card1-DP-3 is connected with no usable EDID; forcing a re-detect/);
  assert.match(r.out, /card1-DP-3 recovered after re-detect/);
  // The second rung must not run once the first one worked.
  assert.doesNotMatch(r.out, /forcing it off/);
});

test('escalates to a forced off\\/detect when a plain re-detect does not take', { skip }, () => {
  const r = runHealth({ connectors: [placeholder('card1-DP-3')], repairAfter: 4 });
  assert.strictEqual(r.exitCode, 0);
  assert.match(r.out, /forcing a re-detect/);
  assert.match(r.out, /forcing it off and re-detecting/);
  assert.match(r.out, /recovered after a forced off\/detect/);
});

test('says plainly when neither rung recovers, and exits non-zero', { skip }, () => {
  const r = runHealth({ connectors: [placeholder('card1-DP-3')] });
  assert.strictEqual(r.exitCode, 1);
  // This line is the whole diagnostic value of the unit: if it shows up in the journal, the
  // kernel-level reprobe does not work on this driver and the fix needs a different lever.
  assert.match(r.out, /card1-DP-3 did not recover from either reprobe; power-cycle the monitor by hand/);
  // Both rungs were tried before giving up, rather than one failing and the other being skipped.
  assert.match(r.out, /forcing a re-detect/);
  assert.match(r.out, /forcing it off and re-detecting/);
});

test('reports the error text when the write to status is refused', { skip }, () => {
  // The whole justification for shipping this before the fault can be reproduced is that the
  // journal will name the failing layer. "Permission denied" and "the driver ignored it" are the
  // two candidates and they need different fixes, so the error text cannot be swallowed.
  const r = runHealth({ connectors: [placeholder('card1-DP-3')], readOnlyStatus: true });
  assert.strictEqual(r.exitCode, 1);
  assert.match(r.out, /card1-DP-3: writing 'detect' to status failed:.*[Pp]ermission denied/);
  assert.match(r.out, /card1-DP-3: writing 'off' to status failed:/);
});

test('treats a connected connector with a zero-length EDID as broken', { skip }, () => {
  const r = runHealth({ connectors: [noEdid('card1-DP-3')], repairAfter: 2 });
  assert.strictEqual(r.exitCode, 0);
  assert.match(r.out, /card1-DP-3 is connected with no usable EDID/);
});

test('holds off while a monitor is still waking, then acts if it stays bad', { skip }, () => {
  // The confirm delay is not decoration: without it every resume would race the monitor's own
  // wake-up and reprobe a display that was about to be fine.
  const r = runHealth({ connectors: [placeholder('card1-DP-3')], repairAfter: 1 });
  assert.strictEqual(r.exitCode, 0);
  assert.doesNotMatch(r.out, /forcing/);
  assert.deepStrictEqual(r.sleeps, ['1']);
});

test('rate-limits a second recovery inside MIN_INTERVAL', { skip }, () => {
  const r = runHealth({ connectors: [placeholder('card1-DP-3')], minInterval: 300, stampAgeSeconds: 30 });
  assert.strictEqual(r.exitCode, 0);
  assert.match(r.out, /skipping/);
  assert.doesNotMatch(r.out, /forcing/);
  assert.strictEqual(r.readStatus('card1-DP-3'), 'connected');
});

test('--force ignores both the confirm delay and the rate limit', { skip }, () => {
  const r = runHealth({ connectors: [placeholder('card1-DP-3')], args: ['--force'], minInterval: 300, stampAgeSeconds: 5, repairAfter: 1 });
  assert.strictEqual(r.exitCode, 0);
  assert.doesNotMatch(r.out, /skipping/);
  assert.match(r.out, /forcing a re-detect/);
});

test('--force on a healthy machine reports that and changes nothing', { skip }, () => {
  // The way to see it, for a fault that leaves no trace once it clears: running the manual unit
  // has to say "nothing was wrong" rather than exit silently like the automatic path.
  const r = runHealth({ connectors: [healthy('card1-DP-3')], args: ['--force'] });
  assert.strictEqual(r.exitCode, 0);
  assert.match(r.out, /every connected output has a real EDID/);
  assert.strictEqual(r.readStatus('card1-DP-3'), 'connected');
});

test('decides from EDID bytes, never from a connector name', { skip }, () => {
  // Connector names rotate on this box, so the same physical monitor can be DP-1 one boot and
  // DP-3 the next. A placeholder on any name must be found, and a healthy DP-3 must be left be.
  const r = runHealth({ connectors: [healthy('card1-DP-3'), placeholder('card1-DP-1')], repairAfter: 2 });
  assert.strictEqual(r.exitCode, 0);
  assert.match(r.out, /card1-DP-1 is connected with no usable EDID/);
  assert.doesNotMatch(r.out, /card1-DP-3 is connected/);
  assert.strictEqual(r.readStatus('card1-DP-3'), 'connected');
  const src = healthScript();
  assert.doesNotMatch(src, /DP-3/, 'health script must not hard-code a connector name');
});

// --- installer -------------------------------------------------------------------------------

function runInstaller({ withConnectors = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'display-edid-inst-'));
  dirs.push(root);
  const binDir = stubDir(root);
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'etc', 'systemd', 'system'), { recursive: true });
  fs.mkdirSync(path.join(root, 'etc', 'polkit-1', 'rules.d'), { recursive: true });
  fs.mkdirSync(path.join(root, 'usr', 'local', 'bin'), { recursive: true });
  const drm = path.join(root, 'fakedrm');
  if (withConnectors) fs.mkdirSync(path.join(drm, 'card1-DP-1'), { recursive: true });
  else fs.mkdirSync(drm, { recursive: true });

  // sudo that authenticates and otherwise execs through, so `sudo tee` really writes.
  fs.writeFileSync(path.join(binDir, 'sudo'), `#!/bin/sh\n[ "$1" = "-v" ] && exit 0\nexec "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'systemctl'), `#!/bin/sh\necho "$@" >> "$STATE_DIR/systemctl.log"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'logger'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

  const scriptFile = path.join(root, 'render.sh');
  fs.writeFileSync(scriptFile, rendered());
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: root, PATH: binDir, STATE_DIR: stateDir, INSTALL_ROOT: root, DRM_GLOB: path.join(drm, 'card*-*') },
  });

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    health: read(path.join(root, 'usr', 'local', 'bin', 'display-edid-health')),
    unit: (n) => read(path.join(root, 'etc', 'systemd', 'system', n)),
    polkit: read(path.join(root, 'etc', 'polkit-1', 'rules.d', '49-display-edid-health-force.rules')),
    systemctlLog: read(path.join(stateDir, 'systemctl.log')) || '',
  };
}

test('installs the health script, all three units, the timer and the polkit rule', { skip }, () => {
  const r = runInstaller();
  assert.strictEqual(r.exitCode, 0);
  assert.ok(r.health && r.health.startsWith('#!/bin/bash'), 'health script not installed');
  for (const n of ['display-edid-health.service', 'display-edid-health-resume.service', 'display-edid-health-force.service', 'display-edid-health.timer']) {
    assert.ok(r.unit(n), `${n} not installed`);
  }
  assert.ok(r.polkit && r.polkit.includes('display-edid-health-force.service'), 'polkit rule not installed');
  assert.match(r.systemctlLog, /enable --now display-edid-health\.timer/);
  assert.match(r.systemctlLog, /enable display-edid-health-resume\.service/);
});

test('the resume unit is ordered after the sleep targets, not just wanted by them', { skip }, () => {
  // WantedBy alone pulls the unit in on the way *into* suspend, where the display is about to go
  // away and there is nothing to fix. After= on the same targets is what moves it to the far side.
  const unit = runInstaller().unit('display-edid-health-resume.service');
  const after = unit.match(/^After=(.*)$/m);
  const wantedBy = unit.match(/^WantedBy=(.*)$/m);
  assert.ok(after, 'resume unit has no After=');
  assert.ok(wantedBy, 'resume unit has no WantedBy=');
  for (const target of ['suspend.target', 'hibernate.target', 'hybrid-sleep.target', 'suspend-then-hibernate.target']) {
    assert.ok(after[1].includes(target), `After= is missing ${target}`);
    assert.ok(wantedBy[1].includes(target), `WantedBy= is missing ${target}`);
  }
  // The driver has to have finished resuming before there is any point re-reading an EDID.
  assert.ok(after[1].includes('nvidia-resume.service'), 'After= is missing nvidia-resume.service');
});

test('no unit hardens /sys out of reach of its own recovery', { skip }, () => {
  // Every rung of the recovery writes to /sys/class/drm/<connector>/status, so the sandbox has to
  // leave that path writable. ProtectKernelTunables would mount /sys read-only outright.
  // ProtectSystem=strict is documented as exempting the API filesystems, but the failure mode if
  // that ever changes is silent -- units that run, log, and fix nothing -- so ReadWritePaths
  // names the path rather than relying on the exemption.
  const r = runInstaller();
  for (const n of ['display-edid-health.service', 'display-edid-health-resume.service', 'display-edid-health-force.service']) {
    assert.doesNotMatch(r.unit(n), /ProtectKernelTunables/, `${n} sets ProtectKernelTunables`);
    assert.match(r.unit(n), /^ReadWritePaths=\/sys\/class\/drm$/m, `${n} does not keep /sys/class/drm writable`);
  }
});

test('installs nothing on a machine with no DRM connectors', { skip }, () => {
  const r = runInstaller({ withConnectors: false });
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.health, null);
  assert.strictEqual(r.systemctlLog, '');
});
