// The Linux app installer renders one pipe-separated record per app from packages.toml and picks
// a route at runtime (distro package -> Flathub -> upstream tarball). Two failure modes motivate
// most of what follows and both are silent:
//   1. packages.toml is now shared with the Windows installer. Dropping or renaming a field there
//      doesn't error — it just renders an empty column, and the app quietly stops installing on
//      one OS while the other keeps working.
//   2. A `manual` app (no Linux route by design) is indistinguishable at runtime from an app whose
//      route was lost, unless the script is explicitly told the difference.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_install-apps.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');
const packages = fs.readFileSync(srcPath('.chezmoidata', 'packages.toml'), 'utf8');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// --source pins the render to THIS checkout; without it chezmoi reads packages.toml and the
// shared linux-install.sh from ~/.local/share/chezmoi and a branch is tested against main's data.
//
// The Windows script (rendered with its OS guard stripped) goes through the same helper: the
// cache is keyed on the body, so it cannot be served this file's default render.
// Pinned to the workstation profile so the gate below is satisfied on any host; see the
// `profile` note in tests/lib/render.js for why this beats skipping on a server-profile machine.
const render = (file) => renderTemplate(file || body, { source: srcPath(), profile: 'workstation' });

// The script is gated to a non-WSL workstation. With the profile pinned above, only WSL and
// non-Linux hosts still render empty, and those have nothing to assert against.
const rendersHere = () => process.platform === 'linux' && render().trim() !== '';

// Parse the rendered APPS block back into records — this is exactly what the shell `while read`
// loop consumes, so asserting on it tests the real contract rather than the template text.
function records() {
  const out = render();
  const block = out.match(/APPS='\n([\s\S]*?)\n'/);
  assert.ok(block, 'APPS block must render');
  return block[1].split('\n').filter(Boolean).map((line) => {
    const [name, apt, dnf, flatpak, repo, copr, tarball, tarballTag, tarballBin, tarballUrl] = line.split('|');
    return {
      name, apt, dnf, flatpak, repo, copr, tarball, tarballTag, tarballBin, tarballUrl,
      fields: line.split('|').length,
    };
  });
}

// Apps the user deliberately excluded from the Linux set — each is a Windows-shell utility or a
// duplicate of something the Linux desktop already provides. A Linux route appearing on any of
// them means someone "helpfully" filled in a package name that was never wanted.
const EXCLUDED_FROM_LINUX = [
  'HWiNFO', 'WizTree', 'AutoHotkey', 'PowerToys', 'Sysinternals Autoruns',
  'Winaero Tweaker', 'ExplorerPatcher', 'Winget-AutoUpdate', 'Windows Terminal',
];

test('script is gated to a non-WSL Linux workstation', { skip }, () => {
  // The linux/workstation/non-WSL checks themselves now live in the shared is-desktop-linux
  // template (home/.chezmoitemplates/is-desktop-linux), reused by every desktop-only script.
  assert.match(body, /includeTemplate "is-desktop-linux"/,
    'WSL has no desktop of its own and must be excluded');
  const gate = fs.readFileSync(srcPath('.chezmoitemplates', 'is-desktop-linux'), 'utf8');
  assert.match(gate, /eq \.chezmoi\.os "linux"/);
  assert.match(gate, /eq \.profile "workstation"/);
  if (process.platform !== 'linux') {
    assert.strictEqual(render().trim(), '', 'script must render empty off Linux');
  }
});

test('every rendered record has all ten columns', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  for (const r of records()) {
    assert.strictEqual(r.fields, 10, `record for ${r.name} must have 10 columns`);
    assert.ok(r.name.trim(), 'every record must carry a name');
  }
});

test('apps excluded from Linux declare no Linux route', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const byName = new Map(records().map((r) => [r.name, r]));
  for (const name of EXCLUDED_FROM_LINUX) {
    const r = byName.get(name);
    assert.ok(r, `${name} must still be present (it installs on Windows)`);
    assert.strictEqual(r.apt + r.dnf + r.flatpak + r.tarball, '',
      `${name} was excluded from the Linux set but declares an install route`);
  }
});

test('every app either installs on Linux or explains why not', () => {
  // Split packages.toml into per-app blocks and require each to resolve one way or the other, so
  // an app can never fall off the Linux side unnoticed.
  const blocks = packages.split(/\n\[\[apps\.[a-z]+\]\]\n/).slice(1);
  assert.ok(blocks.length > 30, 'sanity: parsed the app blocks');
  for (const b of blocks) {
    const name = (b.match(/^name = "([^"]+)"/m) || [])[1];
    assert.ok(name, 'every app block declares a name');
    // bw_cli and ghostty_deb are routes too — real Linux installs that just don't fit the
    // table, because Bitwarden's cli-v* tags and the ghostty-ubuntu .deb both need bespoke
    // handling in the script rather than a package name.
    const hasLinux = /^(apt|dnf|flatpak|tarball) = "/m.test(b) || /^(bw_cli|ghostty_deb) = true/m.test(b);
    const hasManual = /^manual = "/m.test(b);
    assert.ok(hasLinux || hasManual,
      `${name} has no Linux route and no manual note explaining the absence`);
  }
});

test('the requested Linux apps really do resolve to a route', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const byName = new Map(records().map((r) => [r.name, r]));
  // One assertion per app the user asked for, named individually: a regression that drops exactly
  // one app is the case a bulk "most of them have routes" check would sail straight past.
  const want = [
    '7-Zip', 'Firefox', 'Google Chrome', 'Obsidian', 'Spotify', 'Bitwarden', 'WireGuard',
    'Mullvad VPN', 'OBS Studio', 'VLC', 'Elgato Stream Deck', 'f.lux', 'OpenRGB', 'Solaar',
    'Piper', 'Git', 'Visual Studio Code', 'age', 'scrcpy', 'Ghostty', 'Steam', 'Discord',
    'Prism Launcher', 'Temurin JDK', 'Epic Games Launcher',
  ];
  for (const name of want) {
    const r = byName.get(name);
    assert.ok(r, `${name} must be in the app list`);
    assert.ok(r.apt || r.dnf || r.flatpak || r.tarball, `${name} must declare a Linux route`);
  }
});

test('scrcpy falls back to the upstream tarball on Fedora', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const scrcpy = records().find((r) => r.name === 'scrcpy');
  // Fedora ships no scrcpy package (verified against dist-git), so the dnf column must stay empty
  // and the tarball must cover it. An apt column alone would silently skip Fedora.
  assert.strictEqual(scrcpy.dnf, '', 'Fedora does not package scrcpy');
  assert.strictEqual(scrcpy.apt, 'scrcpy', 'Debian/Ubuntu do package it');
  assert.strictEqual(scrcpy.tarball, 'Genymobile/scrcpy');
  assert.match(scrcpy.tarballUrl, /\{arch\}/, 'the tarball URL must carry an {arch} placeholder');
  assert.doesNotMatch(scrcpy.tarballUrl, /\$\{/, 'shell expansion in TOML would never expand');
});

// install_tarball_app used to follow the releases/latest redirect for its own tag, so which
// scrcpy a Fedora box got was decided by the day it was provisioned. The tag is now a column,
// and the script SKIPS a tarball entry that has none — which is the quiet failure this guards:
// an app with a route that installs nothing looks the same as an app with no route.
test('every tarball entry declares the tag to install', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const withTarball = records().filter((r) => r.tarball);
  assert.ok(withTarball.length >= 1, 'sanity: the census found no tarball entries at all');
  for (const r of withTarball) {
    assert.match(r.tarballTag, /^\S+$/, `${r.name} declares a tarball repo but no tarball_tag`);
  }
  assert.match(body, /\[ -n "\$tb_tag" \]/,
    'the installer must refuse a tarball entry with no pinned tag rather than resolving one');
});

test('Ghostty comes from the COPR that ghostty.org documents', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const ghostty = records().find((r) => r.name === 'Ghostty');
  assert.strictEqual(ghostty.copr, 'scottames/ghostty');
  assert.strictEqual(ghostty.dnf, 'ghostty');
  assert.match(body, /ghostty-ubuntu/, 'Debian/Ubuntu need the .deb route, which has no TOML column');
});

test('the shared packages.toml still feeds the Windows installer', { skip }, () => {
  // packages.toml is now shared, so a Linux-side edit can break Windows in a way nothing else
  // here would catch. Two concrete hazards: a bare `.winget` on a Linux-only entry is a template
  // ERROR (not an empty string), which would abort the whole Windows apply; and a restructure can
  // quietly drop ids. The Windows script is OS-gated and renders empty here, so strip the guard
  // and render the body directly.
  const winSrc = srcPath('.chezmoiscripts', 'os-windows', 'run_onchange_after_install-apps.ps1.tmpl');
  const stripped = fs.readFileSync(winSrc, 'utf8')
    .replace('{{- if eq .chezmoi.os "windows" -}}', '')
    .replace(/{{- end -}}\s*$/, '');
  const rendered = render(stripped);
  const ids = [...rendered.matchAll(/^ {4}'([^']+)'$/gm)].map((m) => m[1]).sort();
  const declared = [...packages.matchAll(/^winget = "([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepStrictEqual(ids, declared, 'every winget id in packages.toml must reach the Windows list');
  assert.ok(ids.length > 35, 'sanity: the Windows list is not near-empty');
  assert.strictEqual(new Set(declared).size, declared.length, 'winget ids must be unique');
});

// ---------------------------------------------------------------------------------------------
// Behavioural runs. Same approach as install-cli-tools.test.js: drive the rendered script against
// a synthetic PATH so no real package manager, sudo or network is reachable.
// ---------------------------------------------------------------------------------------------
const PASSTHROUGH = ['sh', 'mkdir', 'cat', 'rm', 'ln', 'sed', 'head', 'grep', 'mktemp', 'install', 'find', 'tar', 'tee', 'chmod', 'cp'];

// `seed` runs against the throwaway HOME before the script does, for cases that need to look like
// a machine where something is already installed.
function runWithStubs(stubs, seed) {
  const home = scratch(os.tmpdir(), 'linux-apps-');
  if (seed) seed(home);
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, render());
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1 || true`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir },
  });
  return { out, home };
}

// Same tripwire as the CLI-tools suite: a dnf host must never shell out to Debian tooling. dpkg is
// stubbed without stubbing apt-get, so detection still resolves to dnf while dpkg calls are caught.
const DPKG_TRIPWIRE = 'echo "DPKG WAS CALLED" >&2; exit 1';
const SUDO_OK = '[ "$1" = "-v" ] && exit 0; exec "$@"';
// Resolves the scrcpy tarball tag without touching the network; anything else fails.
const CURL_TAG_ONLY = `case "$*" in
  *-fsSLI*) echo "https://github.com/Genymobile/scrcpy/releases/tag/v4.1" ;;
  *) exit 1 ;;
esac`;

// A dnf host where every package and flatpak is already present, scrcpy is already unpacked at the
// current tag, and bw is on PATH. Nothing is left to do, so the run must converge silently.
test('dnf host with everything present converges', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const { out } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 0',                       // every package reads as installed
    flatpak: 'exit 0',                   // every flatpak reads as installed
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: CURL_TAG_ONLY,
    unzip: 'exit 0',
    bw: 'exit 0',                        // Bitwarden CLI already on PATH
    uname: '[ "$1" = "-m" ] && echo x86_64 || echo Linux',
  }, (home) => {
    // scrcpy already unpacked at exactly the tag the curl stub reports, so its tarball route is a
    // no-op too. Without this the run legitimately fails on scrcpy and never reaches convergence.
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(path.join(bin, '.versions'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'scrcpy'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, '.versions', 'scrcpy'), 'v4.1');
  });
  assert.doesNotMatch(out, /DPKG WAS CALLED/, 'a dnf host must never shell out to dpkg');
  assert.doesNotMatch(out, /apt-get/, 'a dnf host must never reach for apt-get');
  assert.doesNotMatch(out, /unknown repo key/, 'every repo key used must be handled');
  assert.doesNotMatch(out, /could not install/, 'nothing was left to install');
  assert.doesNotMatch(out, /re-run 'chezmoi apply'/, 'a converged run must not demand a retry');
  assert.match(out, /app install pass done/, 'must reach the end of the script');
});

test('Flathub-only apps take the flatpak route on a dnf host', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const log = path.join(os.tmpdir(), `flatpak-log-${process.pid}-${Date.now()}`);
  const { out } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 0',
    // `flatpak info` reports not-installed so the install path runs; everything else succeeds.
    flatpak: `[ "$1" = "info" ] && exit 1; echo "flatpak $*" >> ${log}; exit 0`,
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: CURL_TAG_ONLY,
    unzip: 'exit 0',
    bw: 'exit 0',
    uname: '[ "$1" = "-m" ] && echo x86_64 || echo Linux',
  });
  const flatpakLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.match(flatpakLog, /install .*md\.obsidian\.Obsidian/, 'Obsidian is Flathub-only and must install from it');
  assert.match(flatpakLog, /install .*com\.spotify\.Client/, 'Spotify is Flathub-only');
  assert.match(flatpakLog, /remote-add .*flathub/, 'Flathub must be added — Fedora ships only its own remote');
  assert.match(flatpakLog, /--user/, 'Flathub installs must be per-user so a sudo-less run still converges');
  assert.doesNotMatch(out, /DPKG WAS CALLED/);
});

// Steam and Discord declare a distro package AND a Flathub id, where Flathub is the fallback for
// hosts the package route can't serve. Nothing used to retire the fallback once the package route
// started working, so a machine that took Flathub first and got the package later ended up with
// both installed and two entries per app in the desktop's app grid.
test('a flatpak fallback is pruned once the distro package is installed', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const log = path.join(os.tmpdir(), `flatpak-prune-${process.pid}-${Date.now()}`);
  const { out } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 0',                       // every distro package reads as installed
    // `flatpak info` reports installed, so both the prune and the skip paths are reachable.
    flatpak: `[ "$1" = "info" ] && exit 0; echo "flatpak $*" >> ${log}; exit 0`,
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: CURL_TAG_ONLY,
    unzip: 'exit 0',
    bw: 'exit 0',
    uname: '[ "$1" = "-m" ] && echo x86_64 || echo Linux',
  });
  const flatpakLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.match(flatpakLog, /uninstall .*com\.valvesoftware\.Steam/, 'the Steam flatpak is superseded by the steam package');
  assert.match(flatpakLog, /uninstall .*com\.discordapp\.Discord/, 'the Discord flatpak is superseded by the discord package');
  assert.match(flatpakLog, /uninstall --user/, 'only the per-user install is ours to remove');
  assert.doesNotMatch(flatpakLog, /--delete-data/,
    'pruning must leave ~/.var/app intact — an unwanted prune should cost a reinstall, not the app config');
  assert.doesNotMatch(flatpakLog, /uninstall .*md\.obsidian\.Obsidian/,
    'Flathub-only apps have no distro package to supersede them and must never be pruned');
  assert.doesNotMatch(flatpakLog, /uninstall .*com\.spotify\.Client/, 'same for Spotify');
  assert.match(out, /\[prune\] com\.valvesoftware\.Steam/, 'the prune must be reported, not silent');
});

// The mirror image, and the one that actually protects the user's data: on a host with no distro
// package the flatpak IS the install, not a leftover.
test('a flatpak fallback survives when the distro package is absent', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const log = path.join(os.tmpdir(), `flatpak-keep-${process.pid}-${Date.now()}`);
  const { out } = runWithStubs({
    // Nothing is installed and every package install fails, so no app can reach the package route.
    dnf: 'case "$*" in *install*) exit 1 ;; *) exit 0 ;; esac',
    rpm: 'exit 1',
    flatpak: `[ "$1" = "info" ] && exit 0; echo "flatpak $*" >> ${log}; exit 0`,
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: CURL_TAG_ONLY,
    unzip: 'exit 0',
    bw: 'exit 0',
    uname: '[ "$1" = "-m" ] && echo x86_64 || echo Linux',
  });
  const flatpakLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.doesNotMatch(flatpakLog, /uninstall/, 'no package is present, so nothing supersedes a flatpak');
  assert.doesNotMatch(out, /\[prune\]/, 'and nothing may be pruned');
  assert.match(out, /\[skip\] com\.valvesoftware\.Steam already installed \(flatpak\)/,
    'the flatpak must be recognised as the live install and kept');
});

test('a repo that exists but is disabled gets enabled', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  // The bug this pins down, found on a real apply: Fedora's fedora-workstation-repositories ships
  // /etc/yum.repos.d/google-chrome.repo with enabled=0. Guarding the repo writer on "does the file
  // exist" made it short-circuit, so dnf never saw the package and Chrome failed to install with a
  // bare "no match" that pointed nowhere near the cause. Present != usable.
  const script = render();
  assert.match(script, /rpm_repo_enable/, 'the module must ship an enable step');
  assert.match(script, /enabled=0/, 'it must detect the disabled marker');
  // The writers must call it on the file-already-exists path, which is the path that broke.
  const writer = script.match(/rpm_repo_write\(\) \{[\s\S]*?\n\}/);
  assert.ok(writer, 'rpm_repo_write must be present');
  assert.match(writer[0], /rpm_repo_enable/,
    'rpm_repo_write must enable an existing repo instead of assuming it works');
  const adder = script.match(/rpm_repo_add\(\) \{[\s\S]*?\n\}/);
  assert.match(adder[0], /rpm_repo_enable/,
    'rpm_repo_add must do the same — a pre-shipped file is not proof the repo is on');
  // And it must refuse to touch Fedora's own multi-stanza files, where the disabled stanzas are
  // source/debuginfo repos that are off deliberately.
  assert.match(script, /multiple stanzas/, 'must refuse multi-stanza files rather than enable them all');
});

test('a sudo-less run defers packages instead of failing outright', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const { out } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 1',                         // nothing installed yet
    flatpak: 'exit 0',
    sudo: 'exit 1',                        // no sudo at all
    dpkg: DPKG_TRIPWIRE,
    curl: CURL_TAG_ONLY,
    unzip: 'exit 0',
    bw: 'exit 0',
    uname: '[ "$1" = "-m" ] && echo x86_64 || echo Linux',
  });
  assert.match(out, /sudo unavailable/, 'must say why the package phase was skipped');
  assert.match(out, /re-run 'chezmoi apply'/, 'must tell the user how to retry');
  assert.doesNotMatch(out, /DPKG WAS CALLED/);
});

// ---------------------------------------------------------------------------------------------
// Repo helpers, exercised directly against a throwaway REPO_DIR.
//
// Regression cover for a real failure: Google Chrome silently did not install on Fedora. Fedora
// ships /etc/yum.repos.d/google-chrome.repo (from fedora-workstation-repositories) carrying
// enabled=0, and the writer here guarded on "does the file exist" — so it saw the file, returned
// early, never enabled anything, and dnf then failed with a bare "no match" pointing nowhere near
// the cause. Existence is not usability.
// ---------------------------------------------------------------------------------------------
const CHROME_DISABLED = `[google-chrome]
name=google-chrome
baseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64
enabled=0
`;
// Shape of Fedora's own repo files: one live stanza plus disabled source/debuginfo siblings.
const MULTI_STANZA = `[fedora]
name=Fedora
enabled=1

[fedora-source]
name=Fedora Source
enabled=0
`;

// Renders just the shared module and sources it, so the helpers can be called in isolation.
function runModule(shell, { repoFiles = {} } = {}) {
  const home = scratch(os.tmpdir(), 'linux-mod-');
  const repoDir = path.join(home, 'repos');
  fs.mkdirSync(repoDir, { recursive: true });
  for (const [name, content] of Object.entries(repoFiles)) {
    fs.writeFileSync(path.join(repoDir, name), content);
  }
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH.concat(['grep', 'uname'])) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real && !fs.existsSync(path.join(binDir, name))) fs.symlinkSync(real, path.join(binDir, name));
  }
  // dnf + rpm on PATH (and no apt-get) is what makes the module resolve PM=dnf.
  for (const [name, script] of Object.entries({ dnf: 'exit 0', rpm: 'exit 0', sudo: SUDO_OK, sed: null })) {
    if (script === null) continue;
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const modulePath = path.join(home, 'module.sh');
  fs.writeFileSync(modulePath, renderTemplate('{{ includeTemplate "linux-install.sh" . }}'));
  const runner = path.join(home, 'run.sh');
  fs.writeFileSync(runner, `. ${JSON.stringify(modulePath)}\n${shell}\n`);
  // PATH is the stub dir ALONE. With /usr/bin:/bin appended, the host's own package manager
  // leaked in and decided the test: PM resolves by probing apt-get first, so on a Debian or
  // Ubuntu machine every rpm_repo_* function below took its `[ "$PM" = dnf ] || return 0` exit
  // and did nothing, while the assertions read as a broken module. install-cli-tools.test.js
  // already carries the mirror image of this note — there the real dnf leaked in and silently
  // tested the dnf path instead of the unsupported-distro one. The stubs must be the only
  // package managers on PATH, in both directions.
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(runner)} 2>&1 || true`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, REPO_DIR: repoDir, TAG: 'test' },
  });
  return { out, repoDir };
}

test('a pre-installed but disabled vendor repo gets enabled', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('module targets Linux');
  const { out, repoDir } = runModule(
    `rpm_repo_write google-chrome <<'EOF'\n[google-chrome]\nenabled=1\nEOF`,
    { repoFiles: { 'google-chrome.repo': CHROME_DISABLED } });
  const after = fs.readFileSync(path.join(repoDir, 'google-chrome.repo'), 'utf8');
  assert.match(after, /^enabled=1$/m, 'the disabled repo must be switched on');
  assert.doesNotMatch(after, /^enabled=0$/m, 'no disabled line may survive');
  assert.match(out, /enabling the pre-installed but disabled google-chrome repo/,
    'the fix must announce itself — this failure was previously silent');
});

test('a multi-stanza repo file is never blanket-rewritten', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('module targets Linux');
  const { out, repoDir } = runModule('rpm_repo_enable fedora', { repoFiles: { 'fedora.repo': MULTI_STANZA } });
  const after = fs.readFileSync(path.join(repoDir, 'fedora.repo'), 'utf8');
  // Enabling one thing must not quietly switch on the source/debuginfo siblings.
  assert.match(after, /\[fedora-source\][\s\S]*enabled=0/, 'the disabled sibling stanza must be left alone');
  assert.match(out, /multiple stanzas/, 'it must say why it declined');
});

test('a repo file that is absent is written', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('module targets Linux');
  const { repoDir } = runModule(`rpm_repo_write vscode <<'EOF'\n[code]\nenabled=1\nEOF`);
  assert.ok(fs.existsSync(path.join(repoDir, 'vscode.repo')), 'a missing repo file must be created');
  assert.match(fs.readFileSync(path.join(repoDir, 'vscode.repo'), 'utf8'), /\[code\]/);
});

