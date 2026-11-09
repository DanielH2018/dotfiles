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
