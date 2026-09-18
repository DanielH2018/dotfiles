// The Fedora codec installer replaces or supplements four sets of packages, and three of the
// decisions it makes are silent when wrong:
//   1. ffmpeg needs `swap` (shared sonames with ffmpeg-free); the GStreamer freeworld packages
//      need plain `install` (disjoint element sets). Getting either backwards either aborts the
//      transaction or erases plugins the machine still uses.
//   2. The VA-API driver is chosen by GPU vendor id. Swapping Mesa's VA drivers on an NVIDIA box
//      replaces a driver that card never loads — a destructive no-op.
//   3. RPM Fusion must be enabled by THIS script, not inherited from install-apps: a machine with
//      no NVIDIA card that installs neither game launcher never runs the other two enablers.
//
// Driven as a RENDERED script under a PATH-shim sandbox, the same way install-linux-apps.test.js
// works: PATH is fully replaced with stub executables that log their argv, and every mutating step
// goes through a sudo stub, so no real dnf transaction can reach the system down any branch.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_install-codecs.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// --source pins the render to THIS checkout, so a branch is not tested against main's copy of the
// shared linux-install.sh.
const render = () => renderTemplate(body, { source: srcPath() });

// Gated to a non-WSL Linux workstation, so it renders empty on a server/minimal profile or under
// WSL. Those hosts have nothing to assert against.
const rendersHere = () => process.platform === 'linux' && render().trim() !== '';

const PASSTHROUGH = ['sh', 'mkdir', 'cat', 'rm', 'sed', 'head', 'grep', 'mktemp', 'chmod'];

function runWithStubs(stubs) {
  const home = scratch(os.tmpdir(), 'linux-codecs-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }
  const log = path.join(home, 'calls.log');
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, render());
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, CALL_LOG: log },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const exitCode = Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]);
  return { out, calls, exitCode };
}

// An rpm stub that reports exactly `installed` as present and nothing else. `rpm -E %fedora` has
// to answer too — the RPM Fusion release URLs are built from it.
const rpmStub = (installed) => `
INSTALLED="${installed.join(' ')}"
[ "$1" = "-E" ] && { echo 44; exit 0; }
if [ "$1" = "-q" ]; then
  shift
  for p in "$@"; do
    case " $INSTALLED " in *" $p "*) ;; *) exit 1 ;; esac
  done
  exit 0
fi
exit 1`;

const DNF_LOG = 'echo "dnf $*" >> "$CALL_LOG"; exit 0';
const SUDO_OK = '[ "$1" = "-v" ] && exit 0; exec "$@"';
// A dnf host must never shell out to Debian tooling. dpkg is stubbed without apt-get, so PM still
// resolves to dnf while any dpkg call is caught.
const DPKG_TRIPWIRE = 'echo "DPKG WAS CALLED" >&2; exit 1';
const UNAME = '[ "$1" = "-m" ] && echo x86_64 || echo Linux';
const lspciStub = (vendorIds) =>
  vendorIds.map((id, i) => `echo "0${i}:00.0 VGA compatible controller [0300]: Vendor [${id}:1234] (rev a1)"`).join('\n') || 'exit 0';

// Everything the codec pass installs, for the converged case.
const ALL_PRESENT = [
  'rpmfusion-free-release', 'rpmfusion-nonfree-release', 'ffmpeg',
  'gstreamer1-plugins-bad-freeworld', 'gstreamer1-plugins-ugly', 'libva-nvidia-driver',
];

const nvidiaHost = (installed) => ({
  dnf: DNF_LOG,
  rpm: rpmStub(installed),
  sudo: SUDO_OK,
  dpkg: DPKG_TRIPWIRE,
  lspci: lspciStub(['10de']),
  uname: UNAME,
});

test('script is gated to a non-WSL Linux workstation', { skip }, () => {
  assert.match(body, /includeTemplate "is-desktop-linux"/,
    'codecs are a desktop concern; the Pi and WSL must not run this');
  if (process.platform !== 'linux') {
    assert.strictEqual(render().trim(), '', 'script must render empty off Linux');
  }
});

test('a fully provisioned NVIDIA host converges without a transaction', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const { out, calls, exitCode } = runWithStubs(nvidiaHost(ALL_PRESENT));
  assert.doesNotMatch(calls, /dnf (install|swap)/, 'nothing was left to do; dnf must not be called');
  assert.doesNotMatch(out, /DPKG WAS CALLED/, 'a dnf host must never shell out to dpkg');
  assert.match(out, /codec pass done/, 'must reach the end of the script');
  assert.strictEqual(exitCode, 0, 'a converged run exits clean');
});

test('a stock Fedora host swaps ffmpeg-free and installs the freeworld plugins', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  // What Fedora actually ships out of the box: RPM Fusion already on (Steam pulled it), the
  // codec-stripped ffmpeg and GStreamer packages installed, no VA-API shim.
  const { calls, exitCode } = runWithStubs(nvidiaHost([
    'rpmfusion-free-release', 'rpmfusion-nonfree-release',
    'ffmpeg-free', 'gstreamer1-plugins-bad-free', 'gstreamer1-plugins-ugly-free',
  ]));
  assert.match(calls, /dnf swap -y --allowerasing ffmpeg-free ffmpeg/,
    'ffmpeg-free shares sonames with the full build, so this must be a swap, not an install');
  assert.match(calls, /dnf install -y gstreamer1-plugins-bad-freeworld/,
    'bad-freeworld adds elements alongside bad-free and must be a plain install');
  assert.match(calls, /dnf install -y gstreamer1-plugins-ugly\b/,
    'ugly and ugly-free carry disjoint elements; installing must not erase ugly-free');
  assert.doesNotMatch(calls, /swap .*gstreamer/, 'the GStreamer packages must never be swapped');
  assert.doesNotMatch(calls, /libavcodec-freeworld/,
    'libavcodec-freeworld patches ffmpeg-free and is redundant once the full ffmpeg is in');
  assert.strictEqual(exitCode, 0);
});

test('RPM Fusion is enabled by this script rather than inherited', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  // The case that motivates the third copy of the enabler: no NVIDIA card, no game launchers, so
  // neither install-apps nor install-gpu-driver ever enabled the repo.
  const { calls } = runWithStubs({ ...nvidiaHost([]), lspci: lspciStub([]) });
  assert.match(calls, /rpmfusion-free-release-44\.noarch\.rpm/, 'free must be enabled');
  assert.match(calls, /rpmfusion-nonfree-release-44\.noarch\.rpm/, 'nonfree too — akmod and Steam live there');
  assert.match(calls, /%fedora|-44\./, 'the release version must come from rpm -E, not be hardcoded');
});

test('an already-enabled RPM Fusion is not re-added', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const { calls } = runWithStubs(nvidiaHost(ALL_PRESENT));
  assert.doesNotMatch(calls, /rpmfusion-free-release-44\.noarch\.rpm/,
    're-installing the release rpm on every apply would be pointless network traffic');
});

test('VA-API driver follows the GPU vendor id', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const base = ['rpmfusion-free-release', 'rpmfusion-nonfree-release', 'ffmpeg',
    'gstreamer1-plugins-bad-freeworld', 'gstreamer1-plugins-ugly'];

  const nvidia = runWithStubs({ ...nvidiaHost(base), lspci: lspciStub(['10de']) });
  assert.match(nvidia.calls, /dnf install -y libva-nvidia-driver/, 'NVIDIA gets the NVDEC shim');
  assert.doesNotMatch(nvidia.calls, /mesa-va-drivers/,
    'swapping Mesa VA drivers on an NVIDIA box replaces a driver the card never loads');
  assert.doesNotMatch(nvidia.calls, /intel-media-driver/, 'no Intel GPU present');

  // mesa-va-drivers installed, so the AMD path must take the swap branch.
  const amd = runWithStubs({
    ...nvidiaHost([...base, 'mesa-va-drivers', 'mesa-vdpau-drivers']),
    lspci: lspciStub(['1002']),
  });
  assert.match(amd.calls, /dnf swap -y --allowerasing mesa-va-drivers mesa-va-drivers-freeworld/,
    'the freeworld Mesa driver replaces its counterpart, so AMD is a swap');
  assert.doesNotMatch(amd.calls, /mesa-vdpau-drivers-freeworld/,
    'RPM Fusion does not build the VDPAU freeworld package on F44; asking for it fails every apply');
  assert.doesNotMatch(amd.calls, /libva-nvidia-driver/, 'no NVIDIA GPU present');

  const intel = runWithStubs({ ...nvidiaHost(base), lspci: lspciStub(['8086']) });
  assert.match(intel.calls, /dnf install -y intel-media-driver/);
  assert.doesNotMatch(intel.calls, /libva-nvidia-driver|mesa-va-drivers/);

  // A hybrid laptop must get both of its drivers, which is why the vendors are tested
  // independently rather than as one case with three arms.
  const hybrid = runWithStubs({ ...nvidiaHost(base), lspci: lspciStub(['8086', '10de']) });
  assert.match(hybrid.calls, /intel-media-driver/, 'hybrid: the iGPU driver must not be skipped');
  assert.match(hybrid.calls, /libva-nvidia-driver/, 'hybrid: the dGPU driver must not be skipped');
});

test('AMD host with Mesa VA drivers already erased installs freeworld directly', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  // dnf swap needs the outgoing package present, so a half-migrated machine must not try to swap
  // away something that is already gone.
  const { calls, exitCode } = runWithStubs({
    ...nvidiaHost(['rpmfusion-free-release', 'rpmfusion-nonfree-release', 'ffmpeg',
      'gstreamer1-plugins-bad-freeworld', 'gstreamer1-plugins-ugly']),
    lspci: lspciStub(['1002']),
  });
  assert.match(calls, /dnf install -y mesa-va-drivers-freeworld/);
  assert.doesNotMatch(calls, /dnf swap/, 'nothing to swap away');
  assert.strictEqual(exitCode, 0);
});

test('every dnf swap puts its options before the positionals', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  // dnf5's grammar is `dnf5 [GLOBAL OPTIONS] swap [OPTIONS] [ARGUMENTS]` — unlike dnf4 it does not
  // accept `--allowerasing` trailing the two package names. The stubs in this file ignore their
  // argv, so no behavioural test can catch a misordered flag; it would fail on the real box at
  // apply time, mid-transaction, with RPM Fusion already enabled. Assert on the source instead.
  for (const line of render().split('\n')) {
    if (!/\bdnf swap\b/.test(line)) continue;
    const args = line.slice(line.indexOf('dnf swap') + 'dnf swap'.length).trim().split(/\s+/);
    const firstPositional = args.findIndex((a) => !a.startsWith('-'));
    const trailingOption = args.slice(firstPositional).find((a) => a.startsWith('--'));
    assert.strictEqual(trailingOption, undefined,
      `dnf5 rejects options after the package names: ${line.trim()}`);
  }
});

test('a non-dnf host exits early instead of half-converging', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const { out, calls, exitCode } = runWithStubs({
    'apt-get': 'echo "apt-get $*" >> "$CALL_LOG"; exit 0',
    dpkg: 'exit 0',
    sudo: SUDO_OK,
    lspci: lspciStub(['1002']),
    uname: UNAME,
  });
  assert.match(out, /Fedora-only/, 'must say why an apt host is skipped');
  assert.strictEqual(calls.trim(), '', 'no package transaction may run on an apt host');
  assert.strictEqual(exitCode, 0, 'skipping a distro this does not cover is not a failure');
});

test('a sudo-less run defers instead of reporting success', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const { out, calls, exitCode } = runWithStubs({ ...nvidiaHost([]), sudo: 'exit 1' });
  assert.strictEqual(calls.trim(), '', 'nothing may be attempted without sudo');
  assert.match(out, /re-run 'chezmoi apply'/, 'must tell the user how to finish the job');
  assert.strictEqual(exitCode, 1, 'exit non-zero so chezmoi retries rather than recording success');
});

test('a failed install exits non-zero and names the package', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  // A stale RPM Fusion mirror: the repo is enabled, but the package will not install.
  const { out, exitCode } = runWithStubs({
    ...nvidiaHost(['rpmfusion-free-release', 'rpmfusion-nonfree-release', 'ffmpeg', 'libva-nvidia-driver']),
    dnf: 'echo "dnf $*" >> "$CALL_LOG"; exit 1',
  });
  assert.match(out, /could not install:.*gstreamer1-plugins-bad-freeworld/);
  assert.match(out, /gstreamer1-plugins-ugly/, 'one failure must not stop the rest of the pass');
  assert.strictEqual(exitCode, 1);
});

