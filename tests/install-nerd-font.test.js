const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'home', '.chezmoiscripts', 'os-windows', 'run_onchange_install-nerd-font.ps1.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

// This test renders a chezmoi template; skip cleanly where the binary isn't installed
// (minimal CI / sandbox) rather than failing with a spurious spawn ENOENT.
let toolsOk = true;
try { execFileSync('chezmoi', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'chezmoi not on PATH';

// 1. The whole script is gated to Windows: off Windows chezmoi renders it to nothing (so
//    `chezmoi apply` never runs PowerShell there); on Windows it renders the installer.
test('script is gated to Windows', { skip }, () => {
  const rendered = execFileSync('chezmoi', ['execute-template'], { input: body, encoding: 'utf8' });
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
const SOURCE = path.join(__dirname, '..', 'home');
const LINUX_SRC = path.join(SOURCE, '.chezmoiscripts', 'os-linux', 'run_onchange_install-nerd-font.sh.tmpl');
const linuxBody = fs.readFileSync(LINUX_SRC, 'utf8');

test('Linux script is gated to a non-WSL workstation', { skip }, () => {
  assert.match(linuxBody, /eq \.chezmoi\.os "linux"/);
  assert.match(linuxBody, /eq \.profile "workstation"/, 'a headless server renders no fonts');
  assert.match(linuxBody, /contains "microsoft" \(lower \.chezmoi\.kernel\.osrelease\)/,
    "WSL's terminal uses the font installed on the Windows host");
  if (process.platform !== 'linux') {
    const rendered = execFileSync('chezmoi', ['--source', SOURCE, 'execute-template'],
      { input: linuxBody, encoding: 'utf8' });
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
});
