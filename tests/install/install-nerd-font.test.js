const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-windows', 'run_onchange_install-nerd-font.ps1.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

// This test renders a chezmoi template; skip cleanly where the binary isn't installed
// (minimal CI / sandbox) rather than failing with a spurious spawn ENOENT.
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// 1. The whole script is gated to Windows: off Windows chezmoi renders it to nothing (so
//    `chezmoi apply` never runs PowerShell there); on Windows it renders the installer.
test('script is gated to Windows', { skip }, () => {
  const rendered = renderTemplate(body, { source: null });
  if (process.platform === 'win32') {
    assert.match(rendered, /IosevkaTerm Nerd Font Mono/, 'on Windows the guard renders the installer');
  } else {
    assert.strictEqual(rendered.trim(), '', 'script must render empty on non-Windows');
  }
});

// 2. The Windows branch still carries the install + VS Code wiring (the guard didn't swallow it).
//    Stays a source read: there is no PowerShell interpreter here to actually run this branch
//    against (chezmoi_available/skip above only gates the render, not execution), so unlike the
//    Linux counterpart below, nothing behavioural can reach it.
test('Windows branch carries the install + VS Code wiring', { skip }, () => {
  assert.match(body, /if eq \.chezmoi\.os "windows"/);
  assert.match(body, /IosevkaTerm Nerd Font Mono/);
  assert.match(body, /Invoke-WebRequest/);
  assert.match(body, /terminal\.integrated\.fontFamily/);
});

// ---------------------------------------------------------------------------------------------
// The Linux counterpart. Same font, different mechanics: per-user ~/.local/share/fonts + fc-cache
// instead of a system-wide install behind UAC.
// ---------------------------------------------------------------------------------------------
const LINUX_SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_install-nerd-font.sh.tmpl');
const linuxBody = fs.readFileSync(LINUX_SRC, 'utf8');

// Renders the REAL script (not the extracted is-desktop-linux template in isolation), so this
// proves the wiring the script actually gets, not just that the shared gate template itself
// would say the right thing in a vacuum. `profile` and `source` are exactly the render.js knobs
// documented for this: pin the profile a real desktop-only script would otherwise inherit from
// the host running the test, so the same assertion holds on a workstation, a server and CI alike.
test('Linux script is gated to a non-WSL workstation', { skip }, () => {
  const workstation = renderTemplate(linuxBody, { source: srcPath(), profile: 'workstation' });
  assert.notStrictEqual(workstation.trim(), '', 'a workstation profile must render the installer');
  for (const profile of ['server', 'minimal']) {
    const rendered = renderTemplate(linuxBody, { source: srcPath(), profile });
    assert.strictEqual(rendered.trim(), '', `a ${profile} profile must render no fonts`);
  }
  // The WSL half of the gate is not covered above: is-wsl reads the live kernel release
  // (os.release()/.chezmoi.kernel.osrelease), which render.js's profile/data overrides do not
  // reach, so spoofing "this machine is WSL" would need a fake chezmoi config this suite does
  // not otherwise carry. WSL's terminal uses the font installed on the Windows host, which is
  // the property this line still pins by name.
  assert.match(linuxBody, /includeTemplate "is-desktop-linux"/);
});

test('Linux script installs per-user and rebuilds the font cache', { skip }, () => {
  assert.match(linuxBody, /\.local\/share\/fonts/, 'per-user install needs no elevation');
  assert.match(linuxBody, /fc-cache/, 'fontconfig will not see the font until the cache is rebuilt');
  assert.match(linuxBody, /Mono\*\.ttf/,
    'only the Mono faces — the proportional faces would win font matching and break cell alignment');
  // The four checks below stay source reads rather than a real run: proving them behaviourally
  // means actually fetching and unpacking a nerd-fonts release (or standing up a fixture archive
  // and a stub curl/unzip for it, the way linux-install-lib.test.js does for a single binary),
  // which is a bigger lift than this cleanup covers. Reuses the shared module rather than
  // re-implementing tag tracking, so a re-apply upgrades the font in place instead of skipping
  // it forever once the directory exists.
  assert.match(linuxBody, /includeTemplate "linux-install\.sh"/);
  assert.match(linuxBody, /recorded_tag iosevkaterm-font/);
  // The tag is the pin from tools.toml, taken through pinned_tag. It used to follow the
  // releases/latest redirect at apply time, so which font build a machine got was decided by
  // the day it was provisioned. The asset URL moved off `releases/latest/download/` for the
  // same reason: that path serves the current release whatever tag gets recorded beside it.
  assert.match(linuxBody, /pinned_tag ryanoasis\/nerd-fonts '\{\{ \(index \.releases "nerd-fonts"\)\.tag \}\}'/);
  assert.doesNotMatch(linuxBody, /releases\/latest\/download/);
});
