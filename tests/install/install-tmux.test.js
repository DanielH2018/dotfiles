const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_install-tmux.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

// This test renders a chezmoi template; skip cleanly where the binary isn't installed
// (minimal CI / sandbox) rather than failing with a spurious spawn ENOENT.
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const dirs = [];

// 1. The script is gated to Linux: off Linux it renders to nothing (so `chezmoi apply` never
//    runs it there); on Linux + non-minimal it renders the builder. A minimal profile also
//    renders empty, so on Linux only assert the shape when something rendered.
test('script is gated to Linux', { skip }, () => {
  const rendered = renderTemplate(body, { source: null });
  if (process.platform !== 'linux') {
    assert.strictEqual(rendered.trim(), '', 'script must render empty off Linux');
  } else if (rendered.trim() !== '') {
    assert.match(rendered, /TMUX_VERSION=3\.7b/, 'Linux render carries the builder');
  }
});

// 2. The Linux branch carries the gate, the source-build, and the sudo-less defer (the guard
//    didn't swallow them).
test('Linux branch carries the gate, source-build, and sudo-less defer', { skip }, () => {
  assert.match(body, /if and \(eq \.chezmoi\.os "linux"\) \(ne \.profile "minimal"\)/);
  assert.match(body, /TMUX_VERSION=3\.7b/);
  assert.match(body, /libevent-dev/);
  assert.match(body, /bison/);
  assert.match(body, /releases\/download\/\$\{TMUX_VERSION\}\/tmux-\$\{TMUX_VERSION\}\.tar\.gz/);
  assert.match(body, /\.\/configure --prefix="\$PREFIX".*make install/s);
  assert.match(body, /sudo unavailable; deferring build deps/);
});

// 3. Idempotence: an already-current ~/.local/bin/tmux must short-circuit before any apt/build,
//    so `chezmoi apply` on an up-to-date host is a no-op. Drive the rendered script with a
//    HOME whose .local/bin/tmux reports the target version and assert it skips at exit 0.
test('idempotence: current local tmux skips the rebuild', { skip }, () => {
  const rendered = renderTemplate(body, { source: null });
  if (process.platform === 'linux' && rendered.trim() !== '') {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-inst-'));
    dirs.push(home);
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho "tmux 3.7b"\n', { mode: 0o755 });
    const scriptFile = path.join(home, 'render.sh');
    fs.writeFileSync(scriptFile, rendered);
    // Merge stderr (where the script logs) into stdout so the skip message is captured.
    const out = execFileSync('sh', ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1`], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.match(out, /skipping build/, 'a current local tmux must skip the rebuild');
  }
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
