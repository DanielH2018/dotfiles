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

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'home');
const SRC = path.join(SOURCE, '.chezmoiscripts', 'os-linux', 'run_onchange_after_install-apps.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');
const packages = fs.readFileSync(path.join(SOURCE, '.chezmoidata', 'packages.toml'), 'utf8');

let toolsOk = true;
try { execFileSync('chezmoi', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'chezmoi not on PATH';

// --source pins the render to THIS checkout; without it chezmoi reads packages.toml and the
// shared linux-install.sh from ~/.local/share/chezmoi and a branch is tested against main's data.
//
// Memoised for the same reason install-cli-tools.test.js is: every `chezmoi execute-template`
// opens chezmoi's bolt-backed state, and this file renders in nearly every test plus once per
// sandbox run. Rendering each time contends with the rest of the suite running in parallel, which
// is exactly what made that file flake.
// Memoisation covers the default body only: callers that render a DIFFERENT template (the Windows
// script, with its OS guard stripped) must not be served this file's cached render.
let rendered;
const renderTemplate = (text) =>
  execFileSync('chezmoi', ['--source', SOURCE, 'execute-template'], { input: text, encoding: 'utf8' });
const render = (file) =>
  (file && file !== body ? renderTemplate(file) : (rendered ??= renderTemplate(body)));

// The script is gated to a non-WSL workstation, so it renders empty on a server/minimal profile
// or under WSL. Those hosts have nothing to assert against.
const rendersHere = () => process.platform === 'linux' && render().trim() !== '';

// Parse the rendered APPS block back into records — this is exactly what the shell `while read`
// loop consumes, so asserting on it tests the real contract rather than the template text.
function records() {
  const out = render();
  const block = out.match(/APPS='\n([\s\S]*?)\n'/);
  assert.ok(block, 'APPS block must render');
  return block[1].split('\n').filter(Boolean).map((line) => {
    const [name, apt, dnf, flatpak, repo, copr, tarball, tarballBin, tarballUrl] = line.split('|');
    return { name, apt, dnf, flatpak, repo, copr, tarball, tarballBin, tarballUrl, fields: line.split('|').length };
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
  assert.match(body, /eq \.chezmoi\.os "linux"/);
  assert.match(body, /eq \.profile "workstation"/);
  assert.match(body, /contains "microsoft" \(lower \.chezmoi\.kernel\.osrelease\)/,
    'WSL has no desktop of its own and must be excluded');
  if (process.platform !== 'linux') {
    assert.strictEqual(render().trim(), '', 'script must render empty off Linux');
  }
});

test('every rendered record has all nine columns', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  for (const r of records()) {
    assert.strictEqual(r.fields, 9, `record for ${r.name} must have 9 columns`);
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
  const winSrc = path.join(SOURCE, '.chezmoiscripts', 'os-windows', 'run_onchange_after_install-apps.ps1.tmpl');
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
const dirs = [];

// `seed` runs against the throwaway HOME before the script does, for cases that need to look like
// a machine where something is already installed.
function runWithStubs(stubs, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-apps-'));
  dirs.push(home);
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-mod-'));
  dirs.push(home);
  const repoDir = path.join(home, 'repos');
  fs.mkdirSync(repoDir, { recursive: true });
  for (const [name, content] of Object.entries(repoFiles)) {
    fs.writeFileSync(path.join(repoDir, name), content);
  }
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH.concat(['grep'])) {
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
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(runner)} 2>&1 || true`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: `${binDir}:/usr/bin:/bin`, REPO_DIR: repoDir, TAG: 'test' },
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

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
