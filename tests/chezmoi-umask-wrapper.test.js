// Regression guard for the recurring chezmoi directory-mode drift.
//
// chezmoi's `umask = 0o022` config feeds its target-MODE COMPUTATION only -- it does not
// affect the mkdir syscall, so newly created dirs land under the *process* umask. On a host
// with a 0007 login umask that is 0755 &^ 0007 = 0750, which never matches the 0755 chezmoi
// recorded as written. Result: a permanent `MM` in `chezmoi status` plus a "has changed since
// chezmoi last wrote it?" prompt that needs a TTY -- which aborts any non-interactive apply
// (cron, systemd --user, `ssh host cmd`, an agent shell).
//
// The fix is a wrapper that runs chezmoi under a pinned 0022. It MUST live in a file that
// NON-interactive shells source: for zsh that is .zshenv (.zshrc and common.sh are
// interactive-only, so a wrapper there silently misses exactly the invocations that reintroduce
// the drift). It was once in dot_zshrc.tmpl and was dropped by the bash+zsh consolidation,
// which is what made the drift recur -- hence this test.
//
// Offline. Skips cleanly if zsh is unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const ZSHENV = path.join(REPO, 'home', 'dot_zshenv');
const BASH_PROFILE = path.join(REPO, 'home', 'dot_bash_profile.tmpl');

// Absolute path: the behavioral test replaces PATH with just the stub dir, so `zsh` itself
// would no longer resolve by name.
const ZSH = ['/usr/bin/zsh', '/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh']
  .find((p) => fs.existsSync(p)) || null;
const skip = ZSH ? false : 'zsh unavailable';

// A chezmoi wrapper pinning 0022, in whatever spelling: `chezmoi() { ( umask 0022; ... ) }`.
function hasUmaskWrapper(src) {
  return /chezmoi\s*\(\)\s*\{[^}]*umask\s+0?022/s.test(src);
}

test('dot_zshenv defines the chezmoi umask wrapper (non-interactive zsh coverage)', () => {
  assert.ok(
    hasUmaskWrapper(fs.readFileSync(ZSHENV, 'utf8')),
    'dot_zshenv must wrap chezmoi in a 0022 umask: .zshrc/common.sh are interactive-only, so a '
      + 'wrapper there misses cron/systemd/ssh/agent applies -- the ones that recreate the 0750 drift',
  );
});

test('dot_bash_profile.tmpl keeps the chezmoi umask wrapper (bash parity)', () => {
  assert.ok(
    hasUmaskWrapper(fs.readFileSync(BASH_PROFILE, 'utf8')),
    'dot_bash_profile.tmpl must keep its chezmoi 0022 wrapper so bash login shells match zsh',
  );
});

// Behavioral: source the real dot_zshenv in a zsh started at umask 0007 and confirm the
// wrapper actually pins 0022 for the chezmoi process. HOME is a temp dir so dot_zshenv's
// `[ -d "$HOME/.local/bin" ]` PATH prepend finds nothing and cannot shadow the stub with the
// real chezmoi binary; PATH is replaced outright by the stub dir.
test('sourcing dot_zshenv runs chezmoi under umask 0022, and does not leak it', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'czumask-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const stub = path.join(bin, 'chezmoi');
    fs.writeFileSync(stub, '#!/bin/sh\numask\n');
    fs.chmodSync(stub, 0o755);

    const run = (script) => execFileSync(ZSH, ['-c', script], {
      env: { HOME: tmp, PATH: bin, SHELL: '/usr/bin/zsh' },
      encoding: 'utf8',
    }).trim();

    // Shells disagree on width (`zsh` prints 007, dash prints 0022), so compare numerically.
    const octal = (s) => parseInt(s, 8);

    const inner = run(`umask 0007; . ${JSON.stringify(ZSHENV)}; chezmoi`);
    assert.strictEqual(octal(inner), 0o022, `chezmoi ran under umask ${inner}, expected 0022 (0755 dirs)`);

    // The pin lives in a subshell, so the caller's private 0007 default must survive.
    const outer = run(`umask 0007; . ${JSON.stringify(ZSHENV)}; chezmoi >/dev/null; umask`);
    assert.strictEqual(octal(outer), 0o007, `wrapper leaked umask ${outer} into the calling shell`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
