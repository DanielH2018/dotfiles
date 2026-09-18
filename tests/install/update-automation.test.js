// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-update-automation.sh.tmpl.
//
// Two things here are worth a test and the rest is content assertion. The first is that a
// converged apply never probes sudo: this script runs on every apply that changes it, and a
// password prompt for a no-op is how a "background" chezmoi apply turns into a hung terminal.
// The second is that `systemctl mask` is honoured. The script enables two timers, so without
// that carve-out there is no way to turn unattended updates off that survives the next apply —
// `disable` would be undone silently, which is a worse state than never having automated it.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-update-automation.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// Real binaries the script needs; PATH is replaced wholesale by the stub dir, so anything not
// listed here and not stubbed simply won't exist — which is also how the no-package-manager
// case is set up (omit dnf and rpm and linux-install.sh resolves PM="").
const PASSTHROUGH = ['sh', 'cat', 'cmp', 'mktemp', 'mkdir', 'install', 'rm', 'dirname', 'printf', 'echo', 'sed', 'grep', 'uname', 'find', 'head'];

const SUDO_OK = 'echo "$@" >> "$STATE_DIR/sudo.log"; [ "$1" = "-v" ] && exit 0; exec "$@"';

// systemctl over a state directory, so "enabled" after an enable is real rather than assumed
// and the mask carve-out has something to read.
const SYSTEMCTL = `
case "$1" in
  is-enabled)
    [ -f "$STATE_DIR/masked/$2" ] && { echo masked; exit 1; }
    [ -f "$STATE_DIR/enabled/$2" ] && { echo enabled; exit 0; }
    echo disabled; exit 1 ;;
  enable)
    shift
    for a in "$@"; do
      case "$a" in
        --now) ;;
        *) : > "$STATE_DIR/enabled/$a"; echo "$a" >> "$STATE_DIR/enable.log" ;;
      esac
    done
    exit 0 ;;
esac
exit 0`;

// One run of the rendered script against throwaway paths. `state` persists across runs when the
// caller passes one back in, which is what the converged-apply test needs.
function run({ stubs = {}, state, installed = ['dnf5-plugin-automatic', 'fwupd'], pm = true, mullvad = true } = {}) {
  const home = scratch(os.tmpdir(), 'update-automation-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const stateDir = state || path.join(home, 'state');
  for (const d of ['enabled', 'masked']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });

  const etc = state ? path.dirname(stateDir) : home;
  const automaticConf = path.join(etc, 'etc', 'dnf', 'automatic.conf');
  const overrideDir = path.join(etc, 'etc', 'dnf', 'repos.override.d');
  const tmpfilesDir = path.join(etc, 'etc', 'tmpfiles.d');
  const unitDir = path.join(etc, 'etc', 'systemd', 'system');
  const motdDir = path.join(etc, 'etc', 'motd.d');
  const reportBin = path.join(etc, 'usr', 'local', 'bin', 'dnf-update-report');

  const all = { sudo: SUDO_OK, systemctl: SYSTEMCTL, 'systemd-tmpfiles': 'exit 0', ...stubs };
  // Presence on PATH is what the script tests, so a machine without Mullvad is one where this
  // stub is simply absent.
  if (mullvad) all['mullvad-exclude'] = all['mullvad-exclude'] || 'exec "$@"';
  if (pm) {
    all.dnf = all.dnf || 'exit 0';
    all.rpm = all.rpm || `[ "$1" = "-q" ] && { for p in ${installed.join(' ')}; do [ "$p" = "$2" ] && exit 0; done; exit 1; }\nexit 0`;
  }
  for (const [name, script] of Object.entries(all)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderFile(SRC));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: binDir,
      STATE_DIR: stateDir,
      AUTOMATIC_CONF: automaticConf,
      REPO_OVERRIDE_DIR: overrideDir,
      TMPFILES_DIR: tmpfilesDir,
      SYSTEMD_UNIT_DIR: unitDir,
      MOTD_DIR: motdDir,
      REPORT_BIN: reportBin,
    },
  });

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    stateDir,
    automaticConf: read(automaticConf),
    override: read(path.join(overrideDir, '20-vendor-skip-if-unavailable.repo')),
    tmpfiles: read(path.join(tmpfilesDir, 'dnf-package-cache.conf')),
    splitTunnel: read(path.join(unitDir, 'dnf5-automatic.service.d', '10-split-tunnel.conf')),
    reportDropin: read(path.join(unitDir, 'dnf5-automatic.service.d', '20-report.conf')),
    report: read(reportBin),
    reportPath: reportBin,
    sudoLog: read(path.join(stateDir, 'sudo.log')) || '',
    enableLog: read(path.join(stateDir, 'enable.log')) || '',
  };
}

const linux = process.platform === 'linux';

// 1. The OS gate, matching every other os-linux script.
test('renders empty off Linux', { skip }, () => {
  if (!linux) assert.strictEqual(renderFile(SRC).trim(), '', 'must render empty off Linux');
});

// 2. The policy the operator chose. apply_updates is the whole point of the script, and the
//    exclusions are what makes applying safe on a box that builds its NVIDIA module via akmod —
//    if either drifts, the change stops being the one that was agreed.
test('applies updates but holds back the kernel and the NVIDIA stack', { skip }, () => {
  const rendered = renderFile(SRC);
  if (!linux || rendered.trim() === '') return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.automaticConf, /^apply_updates = yes$/m);
  assert.match(r.automaticConf, /^reboot = never$/m);
  assert.match(r.automaticConf, /^emit_via = motd, stdio$/m);
  for (const held of ['kernel*', 'kmod-nvidia*', 'akmod-nvidia*', 'xorg-x11-drv-nvidia*', 'nvidia-*']) {
    assert.ok(r.automaticConf.includes(held), `excludepkgs must hold back ${held}`);
  }
});

// 3. The other two files, keyed on what they are for rather than on their exact text: five
//    vendor repos that must not fail an unrelated transaction, and an age bound on the cache
//    keepcache=True would otherwise grow forever.
test('writes the vendor repo overrides and the cache age bound', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  for (const repo of ['code', 'google-chrome', 'warpdotdev', 'mullvad-stable', 'rpmfusion-nonfree-nvidia-driver']) {
    assert.match(r.override, new RegExp(`^\\[${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`, 'm'));
  }
  assert.strictEqual((r.override.match(/skip_if_unavailable = true/g) || []).length, 5);
  assert.doesNotMatch(r.override, /^\[fedora/m, 'a Fedora mirror outage must still fail loudly');
  assert.match(r.tmpfiles, /^e \/var\/cache\/libdnf5\/\*\/packages - - - 14d$/m);
});

// 3b. The reboot signal. `apply_updates = yes` with `reboot = never` and no restart handling is
//     how a box ends up patched on disk and unpatched in every running process, so the drop-in
//     that reports it is load-bearing rather than cosmetic. Asserted on the wiring — the drop-in
//     names the helper and the helper is executable — because the helper's own output depends on
//     a live dnf5 that these stubs do not model.
test('wires a post-run report onto the unattended update service', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.ok(r.reportDropin, 'the report drop-in must be written');
  assert.match(r.reportDropin, /^ExecStartPost=.*dnf-update-report$/m);
  assert.ok(r.report, 'the report helper must be installed');
  assert.match(r.report, /needs-restarting -r/, 'the helper must ask dnf whether a reboot is due');
  assert.ok((fs.statSync(r.reportPath).mode & 0o111) !== 0, 'the helper must be executable');
  // The held-back set is invisible to the unattended run by construction, so the helper is the
  // only thing that can surface it; keeping the two lists in step is the point of the assertion.
  for (const held of ['kernel*', 'akmod-nvidia*']) {
    assert.ok(r.report.includes(held), `the helper must count ${held} as held back`);
  }
  // ExecStartPost returning non-zero would mark a successful update run as failed.
  assert.match(r.report, /^exit 0$/m, 'the helper must not fail the unit');
});

// 4. Both timers get enabled from a cold start.
test('enables the automatic and firmware-refresh timers', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  assert.match(r.enableLog, /dnf5-automatic\.timer/);
  assert.match(r.enableLog, /fwupd-refresh\.timer/);
});

// 5. The invariant that keeps `chezmoi apply` non-interactive: a second run over the state the
//    first one produced must decide it has nothing to do WITHOUT asking for a password.
test('a converged apply changes nothing and never probes sudo', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const first = run();
  assert.strictEqual(first.exitCode, 0, first.out);
  assert.match(first.sudoLog, /-v/, 'the first run must probe sudo — it has work to do');

  fs.writeFileSync(path.join(first.stateDir, 'sudo.log'), '');
  const second = run({ state: first.stateDir });
  assert.strictEqual(second.exitCode, 0, second.out);
  assert.strictEqual(second.sudoLog, '', 'a converged apply must not probe sudo');
  assert.strictEqual(second.out.trim(), 'EXIT:0', 'a converged apply must be silent');
});

// 6. The off switch. `disable` is indistinguishable from never-enabled so the script re-enables
//    it; `mask` is the state it must leave alone, or unattended updates cannot be turned off.
test('leaves a masked timer alone', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const home = scratch(os.tmpdir(), 'update-automation-mask-');
  const stateDir = path.join(home, 'state');
  fs.mkdirSync(path.join(stateDir, 'masked'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'masked', 'dnf5-automatic.timer'), '');

  const r = run({ state: stateDir });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.doesNotMatch(r.enableLog, /dnf5-automatic\.timer/, 'a masked timer must not be re-enabled');
  assert.match(r.enableLog, /fwupd-refresh\.timer/, 'masking one timer must not stop the other');
});

// 7. fwupd absent is not a missing timer — the script must not try to enable a unit no package
//    on the box owns, and must not install a firmware daemon nobody asked for.
test('skips the firmware timer when fwupd is not installed', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ installed: ['dnf5-plugin-automatic'] });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.doesNotMatch(r.enableLog, /fwupd-refresh\.timer/);
  assert.doesNotMatch(r.sudoLog, /install -y fwupd/);
});

// 8. The split-tunnel drop-in. The empty ExecStart is the part that matters: without it systemd
//    appends rather than replaces, and a oneshot would run the upgrade twice — once through the
//    tunnel, defeating the whole point, and once outside it.
test('writes a split-tunnel drop-in that replaces the unit ExecStart', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.splitTunnel, /^ExecStart=$/m, 'must clear the unit ExecStart before adding one');
  assert.match(r.splitTunnel, /mullvad-exclude \/usr\/bin\/dnf5 automatic --timer/);
  // The fallback: whatever happens with Mullvad, an ordinary run still has to be reachable.
  assert.match(r.splitTunnel, /exec \/usr\/bin\/dnf5 automatic --timer'$/m);
  assert.match(r.sudoLog, /systemctl daemon-reload/, 'a drop-in systemd has not re-read is inert');
});

// 9. No Mullvad, no drop-in — writing a file about routing around a VPN that is not installed
//    would be noise, and the unit is already correct without it.
test('writes no split-tunnel drop-in without mullvad-exclude', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ mullvad: false });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.splitTunnel, null, 'no Mullvad means no drop-in');
  assert.match(r.automaticConf, /^apply_updates = yes$/m, 'the rest must still be applied');
});

// 10. A Debian box (or anything without dnf) has nothing here to do and must say so by exiting
//    clean rather than writing dnf config into /etc.
test('does nothing without dnf', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ pm: false });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.automaticConf, null, 'must not write dnf config on a non-dnf host');
  assert.strictEqual(r.sudoLog, '', 'must not probe sudo on a non-dnf host');
});

