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
