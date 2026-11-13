// shell/env.sh picks SUDO_ASKPASS, and a non-interactive login bash (the Bash tool's snapshot
// shell) reaches it through .bash_profile. The headless branch is the one a scratch HOME can
// stand up: tmux-askpass in ~/.local/bin and a tmux on PATH, with no graphical session.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

test('a non-interactive login bash on a headless host gets SUDO_ASKPASS from env.sh', {
  skip: !have('bash') && 'bash unavailable',
}, () => {
  const home = scratch(os.tmpdir(), 'askpass-home-');
  fs.mkdirSync(path.join(home, '.config', 'shell'), { recursive: true });
  fs.copyFileSync(srcPath('dot_config', 'shell', 'env.sh'),
    path.join(home, '.config', 'shell', 'env.sh'));
  fs.copyFileSync(srcPath('dot_bash_profile.tmpl'), path.join(home, '.bash_profile'));
  // env.sh puts ~/.local/bin on PATH, which survives a distro /etc/profile that resets PATH.
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['tmux-askpass', 'tmux']) {
    fs.writeFileSync(path.join(bin, f), '#!/bin/sh\n', { mode: 0o755 });
  }
  const out = execFileSync('bash', ['-l', '-c', 'printf %s "$SUDO_ASKPASS"'], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin' },
  });
  assert.strictEqual(out, path.join(bin, 'tmux-askpass'));
});
