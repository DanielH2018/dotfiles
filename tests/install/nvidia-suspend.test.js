// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-nvidia-suspend.sh.tmpl.
//
// The value in this file is one string, and getting it wrong is a kernel panic on every resume
// rather than a warning — so the assertions are about the path being the one SELinux allows, and
// about the two things that would make the fix silently not apply: a missing target directory,
// and a directory created without its policy label.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-nvidia-suspend.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const PASSTHROUGH = ['sh', 'cat', 'cmp', 'mktemp', 'mkdir', 'install', 'rm', 'dirname', 'printf', 'echo'];

const SUDO_OK = 'echo "$@" >> "$STATE_DIR/sudo.log"; [ "$1" = "-v" ] && exit 0; exec "$@"';

function run({ state, sleepDirExists = false, restorecon = true } = {}) {
  const home = scratch(os.tmpdir(), 'nvidia-suspend-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const stateDir = state || path.join(home, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const root = state ? path.dirname(stateDir) : home;
  const modprobeConf = path.join(root, 'etc', 'modprobe.d', 'nvidia-power.conf');
  fs.mkdirSync(path.dirname(modprobeConf), { recursive: true });
  const sleepDir = path.join(root, 'var', 'lib', 'systemd', 'sleep');
  if (sleepDirExists) fs.mkdirSync(sleepDir, { recursive: true });

  const stubs = { sudo: SUDO_OK };
  // Presence on PATH is what the script tests, so a box without SELinux userspace is one where
  // this stub is simply absent.
  if (restorecon) stubs.restorecon = 'echo "$@" >> "$STATE_DIR/restorecon.log"; exit 0';
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderFile(SRC));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, STATE_DIR: stateDir, MODPROBE_CONF: modprobeConf, SLEEP_DIR: sleepDir },
  });

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    stateDir,
    conf: read(modprobeConf),
    sleepDir,
    sleepDirMade: fs.existsSync(sleepDir),
    sudoLog: read(path.join(stateDir, 'sudo.log')) || '',
    restoreconLog: read(path.join(stateDir, 'restorecon.log')) || '',
  };
}

const linux = process.platform === 'linux';
// /proc/driver/nvidia is the script's own gate and is a real path rather than an overridable
// one, so without it every assertion below would be about the no-op path instead.
const hasNvidia = fs.existsSync('/proc/driver/nvidia');

test('renders empty off Linux', { skip }, () => {
  if (!linux) assert.strictEqual(renderFile(SRC).trim(), '', 'must render empty off Linux');
});

// The whole fix. /var/tmp is tmp_t, which systemd_sleep_t may not write; the sleep directory is
// systemd_sleep_var_lib_t, which it may.
test('points the temporary file path at the sleep directory, not /var/tmp', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasNvidia) return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.conf, /^options nvidia NVreg_TemporaryFilePath=.*\/var\/lib\/systemd\/sleep$/m);
  assert.doesNotMatch(r.conf, /NVreg_TemporaryFilePath=\/var\/tmp\b/,
    '/var/tmp is the path that panicked the box');
});

// Pinning preservation would change behaviour the fix has no evidence about: the live value of 2
// is the driver's default, not something the old file set.
test('sets only the temporary file path', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasNvidia) return;
  const r = run();
  assert.doesNotMatch(r.conf, /PreserveVideoMemoryAllocations/,
    'preservation is the driver default and must not be pinned here');
  assert.strictEqual((r.conf.match(/^options nvidia /gm) || []).length, 1);
});

// systemd creates the directory lazily, so a box that has never slept may not have one — and the
// driver will not create it. Without the label it would be var_lib_t and denied exactly as
// /var/tmp was, which is why restorecon is the assertion rather than mkdir alone.
test('creates the sleep directory and gives it its policy label', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasNvidia) return;
  const r = run({ sleepDirExists: false });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.ok(r.sleepDirMade, 'the sleep directory must exist after the run');
  assert.match(r.restoreconLog, /-F/, 'a directory made by mkdir must be relabelled from file_contexts');
});

test('leaves an existing sleep directory alone', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasNvidia) return;
  const r = run({ sleepDirExists: true });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.restoreconLog, '', 'an existing directory already has its label');
});

// The file being right is not the same as the fix being live: the module reads this at load time
// and cannot be reloaded under a running display server.
test('says a reboot is needed', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasNvidia) return;
  const r = run();
  assert.match(r.out, /reboot/i, 'a fix that needs a reboot must say so');
});

test('a converged apply changes nothing and never probes sudo', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasNvidia) return;
  const first = run();
  assert.strictEqual(first.exitCode, 0, first.out);
  const second = run({ state: first.stateDir });
  assert.strictEqual(second.exitCode, 0, second.out);
  // The log persists across both runs by design, so "no new lines" is the assertion.
  assert.strictEqual(second.sudoLog, first.sudoLog, 'a converged apply must not touch sudo');
  assert.strictEqual(second.conf, first.conf);
});

