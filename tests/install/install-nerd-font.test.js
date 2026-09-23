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

test('Linux script is gated to a non-WSL workstation', { skip }, () => {
  // The linux/workstation/non-WSL checks themselves now live in the shared is-desktop-linux
  // template (home/.chezmoitemplates/is-desktop-linux), reused by every desktop-only script.
  assert.match(linuxBody, /includeTemplate "is-desktop-linux"/,
    "WSL's terminal uses the font installed on the Windows host");
  const gate = fs.readFileSync(srcPath('.chezmoitemplates', 'is-desktop-linux'), 'utf8');
  assert.match(gate, /eq \.chezmoi\.os "linux"/);
  assert.match(gate, /eq \.profile "workstation"/, 'a headless server renders no fonts');
  if (process.platform !== 'linux') {
    const rendered = renderTemplate(linuxBody, { source: srcPath() });
    assert.strictEqual(rendered.trim(), '', 'script must render empty off Linux');
  }
});

test('Linux script installs per-user and rebuilds the font cache', { skip }, () => {
  assert.match(linuxBody, /\.local\/share\/fonts/, 'per-user install needs no elevation');
  assert.match(linuxBody, /fc-cache/, 'fontconfig will not see the font until the cache is rebuilt');
  assert.match(linuxBody, /Mono\*\.ttf/,
    'only the Mono faces — the proportional faces would win font matching and break cell alignment');
  // Reuses the shared module rather than re-implementing tag tracking, so a re-apply upgrades the
  // font in place instead of skipping it forever once the directory exists.
  assert.match(linuxBody, /includeTemplate "linux-install\.sh"/);
  assert.match(linuxBody, /recorded_tag iosevkaterm-font/);
  // The tag is the pin from tools.toml, taken through pinned_tag. It used to follow the
  // releases/latest redirect at apply time, so which font build a machine got was decided by
  // the day it was provisioned. The asset URL moved off `releases/latest/download/` for the
  // same reason: that path serves the current release whatever tag gets recorded beside it.
  assert.match(linuxBody, /pinned_tag ryanoasis\/nerd-fonts '\{\{ \(index \.releases "nerd-fonts"\)\.tag \}\}'/);
  assert.doesNotMatch(linuxBody, /releases\/latest\/download/);
});
