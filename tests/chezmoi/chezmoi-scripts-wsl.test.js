// Behavior tests for the os-linux/wsl bootstrap scripts, driven under the PATH-shim sandbox.
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
  SCRIPTS_DIR, skipWsl, tmpdir, realBin, readLog, runSh, SUDO_STUB,
} = require('../lib/chezmoi-scripts');

// 2b. os-linux/wsl/run_once_after_configure-wsl.sh.tmpl ---------------------------------------
// Only the sudo guard is safely sandboxable: every mutating step (wl-clipboard install,
// /etc/wsl.conf edits) is wrapped in sudo (never really executed by the stub below) but also
// gated on reads of hardcoded absolute /etc paths with no script-level override, so exercising
// those branches deterministically isn't possible without touching real host state.
{
  const CW_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_configure-wsl.sh.tmpl');

  test('configure-wsl.sh.tmpl: sudo unavailable -> defers with exit 1, nothing else attempted', { skip: skipWsl }, () => {
    const dir = tmpdir('configure-wsl-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), SUDO_STUB, { mode: 0o755 });
    const rendered = renderFile(CW_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, SUDO_PROBE_EXIT: '1' };
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readLog(logFile).trim(), 'sudo -v');
  });
}

// 2c. os-linux/wsl/run_once_after_debloat-wsl.sh.tmpl -----------------------------------------
{
  const DW_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_debloat-wsl.sh.tmpl');

  const SYSTEMCTL_STUB = [
    '#!/bin/sh',
    'case "$1" in',
    '  is-enabled)',
    '    unit="$2"',
    '    case " ${MASKED_UNITS:-} " in',
    '      *" $unit "*) echo masked; exit 0 ;;',
    '    esac',
    '    echo enabled; exit 0',
    '    ;;',
    '  cat)',
    '    unit="$2"',
    '    case " ${MISSING_UNITS:-} " in',
    '      *" $unit "*) exit 1 ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n');

  function dwSandbox({ maskedUnits = '', missingUnits = '' } = {}) {
    const dir = tmpdir('debloat-wsl-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), SUDO_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'systemctl'), SYSTEMCTL_STUB, { mode: 0o755 });
    fs.symlinkSync(realBin('grep'), path.join(dir, 'grep'));
    const rendered = renderFile(DW_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = {
      PATH: dir, HOME: dir, STUB_LOG: logFile,
      MASKED_UNITS: maskedUnits, MISSING_UNITS: missingUnits,
    };
    return { scriptFile, env, logFile };
  }

  // The convergence fast-path (masked snapd.service + both /etc drop-ins present) and the
  // MOTD/sysctl/journald writes all key off hardcoded absolute /etc paths with no override --
  // left unasserted (though harmless either way, since sudo never really executes anything);
  // the sudo guard and the systemctl mask/skip decision loop below are fully sandboxed.
  test('debloat-wsl.sh.tmpl: sudo unavailable -> defers with exit 1 before masking anything', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = dwSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readLog(logFile).trim(), 'sudo -v');
  });

  test('debloat-wsl.sh.tmpl: masks an existing unmasked unit, skips missing/already-masked units', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = dwSandbox({
      maskedUnits: 'landscape-client.service',
      missingUnits: 'snapd.socket snapd.seeded.service wsl-pro.service motd-news.timer',
    });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    const log = readLog(logFile);
    assert.ok(log.includes('sudo systemctl mask --now snapd.service'), `existing unmasked unit should be masked:\n${log}`);
    for (const unit of ['snapd.socket', 'snapd.seeded.service', 'wsl-pro.service', 'motd-news.timer', 'landscape-client.service']) {
      assert.ok(!log.includes(`mask --now ${unit}`), `${unit} should not have been masked:\n${log}`);
    }
  });
}

// 2e. os-linux/wsl/run_once_after_install-wslg-audio.sh.tmpl ---------------------------------
// Installs pulseaudio-utils so play-sound.sh uses WSLg's PulseAudio instead of powershell.exe
// interop (which leaks a spinning CPU thread per launch, microsoft/WSL#41173). Both mutating
// steps are `sudo apt-get ...` and the sudo stub never execs them, so no real apt call happens.
{
  const WA_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_install-wslg-audio.sh.tmpl');

  // Materializes paplay in STUB_DIR on `apt-get install` so the script's post-install
  // `command -v paplay` probe resolves exactly as it would after a real install.
  // APT_INSTALL_FAILS=1 simulates apt exiting non-zero and leaving nothing behind.
  const APT_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
    '  exit "${SUDO_PROBE_EXIT:-0}"',
    'fi',
    'if [ "$2" = "install" ]; then',
    '  [ "${APT_INSTALL_FAILS:-0}" = "0" ] || exit 100',
    '  printf "#!/bin/sh\\n" > "$STUB_DIR/paplay" && chmod 755 "$STUB_DIR/paplay"',
    'fi',
    'exit "${SUDO_EXIT:-0}"',
    '',
  ].join('\n');

  function waSandbox({ paplayPresent = false } = {}) {
    const dir = tmpdir('wslg-audio-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), APT_SUDO_STUB, { mode: 0o755 });
    if (paplayPresent) fs.writeFileSync(path.join(dir, 'paplay'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(realBin('chmod'), path.join(dir, 'chmod')); // used by the sudo stub itself
    // apt-get and dpkg only have to EXIST. linux-install.sh picks its package manager with
    // `command -v apt-get && command -v dpkg`, and PATH is replaced wholesale by this dir, so
    // without them the module finds no package manager at all: pkg_install becomes a no-op, the
    // post-install `command -v paplay` probe fails, and the script exits 1 having logged nothing
    // past `sudo -v`. That reads as a broken script rather than a sandbox missing two stubs.
    // They are never executed — the sudo stub logs its argv and returns without exec'ing.
    for (const name of ['apt-get', 'dpkg']) {
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const rendered = renderFile(WA_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, STUB_DIR: dir };
    return { scriptFile, env, logFile };
  }

  test('install-wslg-audio.sh.tmpl: paplay already present -> exits 0 without invoking sudo', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox({ paplayPresent: true });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readLog(logFile), '', 'converged run must not probe or invoke sudo');
  });

  test('install-wslg-audio.sh.tmpl: sudo unavailable -> defers with exit 1 before touching apt', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1, 'must exit 1 so chezmoi does not record success');
    assert.strictEqual(readLog(logFile).trim(), 'sudo -v', 'no apt call should follow a failed sudo probe');
  });

  test('install-wslg-audio.sh.tmpl: paplay missing + sudo available -> installs pulseaudio-utils and nothing else', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox();
    const { status, stdout } = runSh(scriptFile, env);
    const log = readLog(logFile);
    assert.strictEqual(status, 0, `expected success, log:\n${log}`);
    assert.ok(log.includes('sudo apt-get update -qq'), `apt index should be refreshed first:\n${log}`);
    assert.ok(log.includes('sudo apt-get install -y pulseaudio-utils'), `pulseaudio-utils should be installed:\n${log}`);
    // Guards against a future edit quietly widening this into a general audio-stack install.
    const installs = log.split('\n').filter((l) => l.includes('apt-get install'));
    assert.deepStrictEqual(installs, ['sudo apt-get install -y pulseaudio-utils'], `exactly one package expected:\n${log}`);
    assert.match(stdout, /pulseaudio-utils installed/);
  });

  test('install-wslg-audio.sh.tmpl: apt fails to provide paplay -> exit 1 so the next apply retries', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox();
    env.APT_INSTALL_FAILS = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1, 'a silent fallback to interop must not be recorded as success');
    assert.ok(readLog(logFile).includes('apt-get install -y pulseaudio-utils'), 'the install should have been attempted');
  });
}
