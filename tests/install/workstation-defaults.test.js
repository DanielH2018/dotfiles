// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-workstation-defaults.sh.tmpl.
//
// The hostname is the part with teeth. This repo templates on `.chezmoi.hostname` in four
// places — `.chezmoiignore` decides whether ~/.ssh/config deploys at all, and settings.base.json
// picks CLAUDE_ARTIFACTS_PORT — and every one of those tests membership of
// (daniel-box, daniel-server, daniel-pi). Naming this box one of those three would silently move
// its artifacts port and stop deploying its ssh config, so that is asserted directly rather than
// left to review.
//
// The other assertion that matters is the guard: this must only ever fire on a machine with no
// static hostname, because keying a hostname change on the hostname is circular and because the
// rest of the fleet already has theirs.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-workstation-defaults.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const PASSTHROUGH = ['sh', 'rm', 'echo', 'printf', 'cat'];

const SUDO_OK = 'echo "$@" >> "$STATE_DIR/sudo.log"; [ "$1" = "-v" ] && exit 0; exec "$@"';

// systemctl over a state directory, so "enabled" is a fact the test sets rather than one the
// stub assumes, and a disable is observable.
const SYSTEMCTL = `
case "$1" in
  is-enabled) [ -f "$STATE_DIR/enabled/$2" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  disable)    rm -f "$STATE_DIR/enabled/$2"; echo "$2" >> "$STATE_DIR/disable.log"; exit 0 ;;
esac
exit 0`;

const HOSTNAMECTL = 'echo "$@" >> "$STATE_DIR/hostnamectl.log"; exit 0';

const dirs = [];

function run({ state, hostnameSet = false, waitEnabled = true, rpmsave = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workstation-defaults-'));
  dirs.push(home);
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const stateDir = state || path.join(home, 'state');
  fs.mkdirSync(path.join(stateDir, 'enabled'), { recursive: true });
  if (waitEnabled) fs.writeFileSync(path.join(stateDir, 'enabled', 'NetworkManager-wait-online.service'), '');

  const root = state ? path.dirname(stateDir) : home;
  const hostnameFile = path.join(root, 'etc', 'hostname');
  const rpmsaveFile = path.join(root, 'etc', 'sysconfig', 'livesys.rpmsave');
  fs.mkdirSync(path.dirname(rpmsaveFile), { recursive: true });
  if (hostnameSet) fs.writeFileSync(hostnameFile, 'already-named\n');
  if (rpmsave) fs.writeFileSync(rpmsaveFile, 'debris\n');

  for (const [name, script] of Object.entries({ sudo: SUDO_OK, systemctl: SYSTEMCTL, hostnamectl: HOSTNAMECTL })) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderFile(SRC));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, STATE_DIR: stateDir, HOSTNAME_FILE: hostnameFile, RPMSAVE_FILE: rpmsaveFile },
  });

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    stateDir,
    rpmsaveExists: fs.existsSync(rpmsaveFile),
    hostnamectlLog: read(path.join(stateDir, 'hostnamectl.log')) || '',
    disableLog: read(path.join(stateDir, 'disable.log')) || '',
    sudoLog: read(path.join(stateDir, 'sudo.log')) || '',
  };
}

const linux = process.platform === 'linux';

test('renders empty off Linux', { skip }, () => {
  if (!linux) assert.strictEqual(renderFile(SRC).trim(), '', 'must render empty off Linux');
});

test('does all three when all three are needed', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.hostnamectlLog, /set-hostname daniel-desktop/);
  assert.match(r.disableLog, /NetworkManager-wait-online\.service/);
  assert.strictEqual(r.rpmsaveExists, false, 'the rpmsave leftover must be removed');
});

// The load-bearing one. Any of these three names moves CLAUDE_ARTIFACTS_PORT off 8181 and stops
// ~/.ssh/config deploying to this box, because .chezmoiignore keys on exactly this list.
test('never takes a name the repo templates branch on', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const rendered = renderFile(SRC);
  for (const reserved of ['daniel-box', 'daniel-server', 'daniel-pi']) {
    assert.doesNotMatch(rendered, new RegExp(`HOSTNAME=${reserved}\\b`),
      `${reserved} is branched on in .chezmoiignore and settings.base.json`);
  }
});

// Keying a hostname change on the hostname would be circular, so the guard is "none set" — which
// is also what keeps this from renaming the rest of the fleet.
test('leaves an existing static hostname alone', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ hostnameSet: true });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.hostnamectlLog, '', 'a machine that already has a name must keep it');
});

test('does not re-disable an already-disabled unit', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ waitEnabled: false, hostnameSet: true, rpmsave: false });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.disableLog, '');
  assert.strictEqual(r.sudoLog, '', 'nothing to do means no sudo at all');
});

test('a converged apply changes nothing and never probes sudo', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const first = run();
  assert.strictEqual(first.exitCode, 0, first.out);
  // The hostname file is not written by the stub, so the second run is told it is set — which is
  // what the real hostnamectl would have done.
  const second = run({ state: first.stateDir, hostnameSet: true, waitEnabled: false, rpmsave: false });
  assert.strictEqual(second.exitCode, 0, second.out);
  assert.strictEqual(second.sudoLog, first.sudoLog, 'a converged apply must not touch sudo');
});

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
