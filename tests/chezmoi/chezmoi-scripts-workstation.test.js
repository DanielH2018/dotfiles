// Behavior tests for the os-linux bootstrap scripts gated on the workstation profile or on
// is-desktop-linux (bt-hid-recovery, setup-inotify-limits), driven under the PATH-shim sandbox.
//
// The suite is split by the guard each script renders behind, so a file's skip gate is the
// one its scripts share: chezmoi-scripts.test.js (the render sweep and the os-unix scripts),
// chezmoi-scripts-wsl.test.js (os-linux/wsl), chezmoi-scripts-linux.test.js (os-linux, any
// profile) and chezmoi-scripts-workstation.test.js (os-linux, workstation and desktop only).
// The sandbox helpers, the skip gates and the shared sudo stub are tests/lib/chezmoi-scripts.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderFile } = require('../lib/render');
const {
  SCRIPTS_DIR, skipWorkstation, skipDesktop, tmpdir, realBin, readLog, runSh,
} = require('../lib/chezmoi-scripts');

// 2h. os-linux/run_onchange_after_setup-bt-hid-recovery.sh.tmpl ------------------------------
{
  const BT_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_setup-bt-hid-recovery.sh.tmpl');

  // This script's entire effect is four files written through `sudo tee` plus a systemd and a
  // udev reload, so unlike the sandboxes above its sudo stub execs a REAL tee, redirected under
  // $FAKE_ROOT. Asserting on argv alone would prove almost nothing here: every interesting
  // detail (the --no-block restart, the rate limit, the VID/PID) lives inside a heredoc, so the
  // tests need the bytes that would have landed in /etc. Any sudo verb the stub does not
  // recognise is logged as REFUSED rather than run, so a later `sudo mv` added to the script
  // fails these tests instead of silently escaping the sandbox.
  const BT_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then exit "${SUDO_PROBE_EXIT:-0}"; fi',
    'case "$1" in',
    '  tee)',
    '    out="$FAKE_ROOT$2"',
    '    mkdir -p "$(dirname "$out")"',
    '    exec tee "$out" ;;',
    '  chmod|systemctl|udevadm|restorecon) exit 0 ;;',
    'esac',
    'echo "sudo REFUSED $*" >> "$STUB_LOG"',
    'exit 99',
    '',
  ].join('\n');

  const BT_PATHS = {
    script: 'usr/local/bin/bt-hid-health',
    service: 'etc/systemd/system/bt-hid-health.service',
    forceService: 'etc/systemd/system/bt-hid-health-force.service',
    polkit: 'etc/polkit-1/rules.d/49-bt-hid-health-force.rules',
    timer: 'etc/systemd/system/bt-hid-health.timer',
    udev: 'etc/udev/rules.d/50-bt500-no-autosuspend.rules',
  };

  function btSandbox({ bluetoothctl = true, btUnit = true } = {}) {
    const dir = tmpdir('bt-hid-');
    const fakeRoot = path.join(dir, 'root');
    fs.mkdirSync(fakeRoot);
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), BT_SUDO_STUB, { mode: 0o755 });
    // Only `list-unit-files` decides the gate; every other systemctl call here is unprivileged
    // and irrelevant, so it just succeeds.
    fs.writeFileSync(
      path.join(dir, 'systemctl'),
      `#!/bin/sh\n[ "$1" = list-unit-files ] || exit 0\nexit ${btUnit ? 0 : 1}\n`,
      { mode: 0o755 },
    );
    if (bluetoothctl) fs.writeFileSync(path.join(dir, 'bluetoothctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'restorecon'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // dnf+rpm so linux-install.sh detects a PM and the run matches the Fedora box it targets.
    for (const bin of ['dnf', 'rpm']) {
      fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    for (const bin of ['tee', 'mkdir', 'dirname', 'grep', 'sed', 'awk', 'cat', 'rm', 'uname', 'tr', 'mktemp', 'cp', 'install', 'chmod']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const scriptFile = path.join(dir, 'rendered.sh');
    // Workstation profile: this script is gated behind is-desktop-linux and renders to zero bytes
    // on a server-profile host. See the `profile` note in tests/lib/render.js.
    fs.writeFileSync(scriptFile, renderFile(BT_SRC, { profile: 'workstation' }));
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, FAKE_ROOT: fakeRoot };
    return { scriptFile, env, logFile, fakeRoot };
  }

  const btRead = (fakeRoot, key) => fs.readFileSync(path.join(fakeRoot, BT_PATHS[key]), 'utf8');

  test('bt-hid-recovery.sh.tmpl: fresh box -> writes every artifact, enables the timer, reloads udev', { skip: skipDesktop }, () => {
    const { scriptFile, env, logFile, fakeRoot } = btSandbox();
    const { status } = runSh(scriptFile, env);
    const log = readLog(logFile);
    assert.strictEqual(status, 0, `expected success, log:\n${log}`);
    assert.ok(!log.includes('REFUSED'), `an unrecognised sudo verb escaped the sandbox:\n${log}`);

    for (const key of Object.keys(BT_PATHS)) {
      assert.ok(fs.existsSync(path.join(fakeRoot, BT_PATHS[key])), `${BT_PATHS[key]} was not written`);
    }

    // The watchdog is ordered After=bluetooth.service, so a blocking restart of that unit from
    // inside its own Type=oneshot can deadlock until TimeoutStartSec. --no-block is the fix and
    // dropping it would reintroduce a hang that only shows up during a real recovery.
    const watchdog = btRead(fakeRoot, 'script');
    assert.match(watchdog, /systemctl restart --no-block bluetooth/, 'the restart must not block');
    assert.match(watchdog, /MIN_RESTART_INTERVAL=600/, 'the restart-loop guard must survive');
    assert.match(watchdog, /00001812-0000-1000-8000-00805f9b34fb/, 'the HoG UUID filter must survive');

    const service = btRead(fakeRoot, 'service');
    assert.match(service, /After=bluetooth\.service/);
    assert.match(service, /StateDirectory=bt-hid-health/, 'systemd must own the stamp directory');
    assert.match(service, /TimeoutStartSec=/, 'the unit needs a bound so it can never hang forever');
    assert.match(btRead(fakeRoot, 'timer'), /OnUnitActiveSec=2min/);
    // One VID/PID keeps the rule inert on any machine without this dongle.
    assert.match(btRead(fakeRoot, 'udev'), /idVendor}=="0b05".*idProduct}=="190e"/);

    // The manual path. The plain unit honours MIN_RESTART_INTERVAL, so a key bound to it no-ops
    // for up to ten minutes in exactly the situation it would be pressed -- the forced unit is
    // what makes the Stream Deck key mean anything, and --force is the whole of the difference.
    const forceService = btRead(fakeRoot, 'forceService');
    assert.match(forceService, /ExecStart=\/usr\/local\/bin\/bt-hid-health --force/);
    assert.match(watchdog, /FORCE=1/, 'the watchdog must understand --force');
    assert.match(watchdog, /\[ "\$FORCE" -eq 0 \] && \[ -r "\$STAMP" \]/, '--force must bypass the rate limit');

    // The grant is permanent and authorises restarting a system service, so its scope is the
    // thing to pin: one unit, one verb, one named user. Widening any of those hands out control
    // of every unit on the box.
    const polkit = btRead(fakeRoot, 'polkit');
    assert.match(polkit, /action\.lookup\("unit"\) == "bt-hid-health-force\.service"/);
    assert.match(polkit, /action\.lookup\("verb"\) == "start"/);
    assert.match(polkit, /subject\.user == "[^"{}]+"/, 'the username must be rendered, not left as a template');
    assert.doesNotMatch(polkit, /isInGroup|subject\.user == "root"/, 'the grant must not widen past one user');

    assert.ok(log.includes('sudo chmod 0755 /usr/local/bin/bt-hid-health'), `watchdog left non-executable:\n${log}`);
    assert.ok(log.includes('sudo systemctl daemon-reload'), `units not reloaded:\n${log}`);
    assert.ok(log.includes('sudo systemctl enable --now bt-hid-health.timer'), `timer not enabled:\n${log}`);
    assert.ok(log.includes('sudo udevadm control --reload'), `udev not reloaded:\n${log}`);
  });

  test('bt-hid-recovery.sh.tmpl: no bluetoothctl -> exits without writing or probing sudo', { skip: skipDesktop }, () => {
    const { scriptFile, env, logFile, fakeRoot } = btSandbox({ bluetoothctl: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(path.join(fakeRoot, BT_PATHS.service)), 'nothing should be written without a BT stack');
    assert.strictEqual(readLog(logFile), '', 'the gate must run before sudo is probed');
  });

  test('bt-hid-recovery.sh.tmpl: systemd does not know bluetooth.service -> exits without probing sudo', { skip: skipDesktop }, () => {
    const { scriptFile, env, logFile, fakeRoot } = btSandbox({ btUnit: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(path.join(fakeRoot, BT_PATHS.service)));
    assert.strictEqual(readLog(logFile), '');
  });

  test('bt-hid-recovery.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipDesktop }, () => {
    const { scriptFile, env, fakeRoot } = btSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    // exit 0 here would be worse than a failed apply: run_onchange records success by hash, so
    // the watchdog would stay uninstalled until this script next changes.
    assert.strictEqual(status, 1);
    assert.ok(!fs.existsSync(path.join(fakeRoot, BT_PATHS.service)), 'nothing should be written without sudo');
  });
}

// 2i. os-linux/run_onchange_after_setup-inotify-limits.sh.tmpl -------------------------------
{
  const IN_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_setup-inotify-limits.sh.tmpl');

  // Like dnf-speedups, this script's whole job is the resulting file, so its sudo stub DOES exec
  // the write -- asserting on argv alone would prove nothing about the config that comes out.
  // The whitelist is narrow in the same way, with one addition that matters more here than there:
  // `sysctl` is logged and NEVER exec'd. It is the one wrapped command that would change the real
  // machine (it writes /proc/sys), and the temp-dir redirection that makes install safe does not
  // protect it -- `sysctl -p <tempfile>` still applies the setting system-wide. Refusing to exec
  // it is the whole reason this stub is not simply dnf-speedups' one reused.
  const IN_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
    '  exit "${SUDO_PROBE_EXIT:-0}"',
    'fi',
    'for dest; do :; done',      // POSIX idiom for the last positional arg
    'if [ "$1" = mkdir ] && [ "$dest" = "$SYSCTL_DIR" ]; then',
    '  exec "$@"',
    'fi',
    'if [ "$1" = install ] && [ "$dest" = "$SYSCTL_CONF" ]; then',
    '  exec "$@"',
    'fi',
    // Logged above, deliberately not exec'd: see the note on this stub.
    'if [ "$1" = sysctl ]; then',
    '  exit "${SYSCTL_APPLY_EXIT:-0}"',
    'fi',
    'echo "stub sudo refused: $*" >&2',
    'exit 99',
    '',
  ].join('\n');

  function inSandbox({ seed = null } = {}) {
    const dir = tmpdir('inotify-');
    const sysctlDir = path.join(dir, 'sysctl.d');
    fs.mkdirSync(sysctlDir);
    const confFile = path.join(sysctlDir, '99-inotify.conf');
    if (seed !== null) fs.writeFileSync(confFile, seed);
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), IN_SUDO_STUB, { mode: 0o755 });
    for (const bin of ['cat', 'cmp', 'install', 'mkdir', 'mktemp', 'rm']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, renderFile(IN_SRC));
    // SYSCTL_CONF is read by the stub, not by the script -- the script derives its own from
    // SYSCTL_DIR. The two must agree or the stub refuses the write the script actually makes.
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, SYSCTL_DIR: sysctlDir, SYSCTL_CONF: confFile };
    return { scriptFile, env, logFile, confFile };
  }

  const readConf = (f) => fs.readFileSync(f, 'utf8');

  test('setup-inotify-limits.sh.tmpl: no drop-in -> writes it through sudo and applies it', { skip: skipWorkstation }, () => {
    const { scriptFile, env, logFile, confFile } = inSandbox();
    const { status, stdout } = runSh(scriptFile, env);
    assert.strictEqual(status, 0, `expected success, log:\n${readLog(logFile)}`);
    assert.ok(fs.existsSync(confFile), 'the drop-in should have been written');
    const log = readLog(logFile);
    assert.ok(log.includes('sudo install -m 0644'), `the write should go through sudo:\n${log}`);
    // Without this the new ceiling waits for a reboot while the starved app keeps failing.
    assert.ok(log.includes(`sudo sysctl -p ${confFile}`), `the value should be applied now:\n${log}`);
    // A process that already failed inotify_init() does not retry, so the restart notice is part
    // of the script's contract rather than decoration.
    assert.ok(/need restarting/.test(stdout), `expected the restart notice:\n${stdout}`);
  });

  test('setup-inotify-limits.sh.tmpl: sets max_user_instances to 1024, and does not set max_user_watches', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.ok(/^fs\.inotify\.max_user_instances\s*=\s*1024$/m.test(out), `expected the instance ceiling:\n${out}`);
    // The entire diagnosis was that instances are exhausted (119/128) while watches sit at 2392 of
    // 272131. Raising max_user_watches is the fix every guide to this symptom suggests and it fixes
    // nothing here, so a future edit that "helpfully" adds it should fail rather than pass quietly.
    // Matched as an assignment, not a substring: the header comment names it on purpose.
    assert.ok(!/^\s*fs\.inotify\.max_user_watches\s*=/m.test(out), `must not set the watch limit:\n${out}`);
  });

  test('setup-inotify-limits.sh.tmpl: second run over a converged file writes nothing and never probes sudo', { skip: skipWorkstation }, () => {
    const { scriptFile, env, logFile, confFile } = inSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const afterFirst = readConf(confFile);
    fs.writeFileSync(logFile, '');
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), afterFirst, 'a converged file must not be rewritten');
    // `sudo -v` prompts for a password, so a no-op apply that probes it is a regression even
    // though the file is unchanged.
    assert.strictEqual(readLog(logFile), '', 'converged run must not touch sudo at all');
  });

  test('setup-inotify-limits.sh.tmpl: a stale value is rewritten', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox({ seed: 'fs.inotify.max_user_instances = 256\n' });
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.ok(out.includes('1024'), `the new ceiling should replace the old:\n${out}`);
    assert.ok(!/=\s*256$/m.test(out), `the stale value should not survive:\n${out}`);
  });

  test('setup-inotify-limits.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    // exit 0 here would be worse than a failed apply: run_onchange records success by hash, so the
    // limit would stay unraised until this script next changes.
    assert.strictEqual(status, 1);
    assert.ok(!fs.existsSync(confFile), 'nothing should be written without sudo');
  });

  test('setup-inotify-limits.sh.tmpl: sysctl -p fails -> the file still lands and the failure is reported', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox();
    env.SYSCTL_APPLY_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    // The drop-in is the durable half and is correct on disk regardless; a failed apply costs a
    // reboot's delay, not the change. Failing the whole script here would strand the write it
    // already made, since run_onchange would retry a file that is already converged.
    assert.strictEqual(status, 0);
    assert.ok(fs.existsSync(confFile), 'the drop-in should survive a failed apply');
  });
}
