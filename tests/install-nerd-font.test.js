const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'home', 'run_onchange_install-nerd-font.ps1.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

// This test renders a chezmoi template; skip cleanly where the binary isn't installed
// (minimal CI / sandbox) rather than failing with a spurious spawn ENOENT.
try { execFileSync('chezmoi', ['--version'], { stdio: 'ignore' }); }
catch { console.log('SKIP: chezmoi not on PATH'); process.exit(0); }

// 1. The whole script is gated to Windows: on this (non-Windows) host chezmoi renders it
//    to nothing, so `chezmoi apply` never executes PowerShell off Windows.
const rendered = execFileSync('chezmoi', ['execute-template'], { input: body, encoding: 'utf8' });
assert.strictEqual(rendered.trim(), '', 'script must render empty on non-Windows');

// 2. The Windows branch still carries the install + VS Code wiring (the guard didn't swallow it).
assert.match(body, /if eq \.chezmoi\.os "windows"/);
assert.match(body, /IosevkaTerm Nerd Font Mono/);
assert.match(body, /Invoke-WebRequest/);
assert.match(body, /terminal\.integrated\.fontFamily/);

console.log('ALL PASS');
