// shell/askpass.sh picks SUDO_ASKPASS. A login shell reaches it through env.sh; a Bash tool
// command reaches it only through the BASH_ENV that settings.base.json sets, because it runs
// as `bash -c` on a snapshot that reads no startup file and exports PATH alone. The headless
// branch is the one a scratch HOME can stand up: tmux-askpass in ~/.local/bin and a tmux on
// PATH, with no graphical session.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have, skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

function headlessHome() {
  const home = scratch(os.tmpdir(), 'askpass-home-');
  fs.mkdirSync(path.join(home, '.config', 'shell'), { recursive: true });
  for (const f of ['env.sh', 'askpass.sh']) {
    fs.copyFileSync(srcPath('dot_config', 'shell', f), path.join(home, '.config', 'shell', f));
  }
  fs.copyFileSync(srcPath('dot_bash_profile.tmpl'), path.join(home, '.bash_profile'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['tmux-askpass', 'tmux']) {
    fs.writeFileSync(path.join(bin, f), '#!/bin/sh\n', { mode: 0o755 });
  }
  return { home, bin };
}

test('a Bash tool command, a bash -c with the snapshot\'s PATH, gets SUDO_ASKPASS via BASH_ENV', {
  skip: skipUnless('bash', 'chezmoi'),
}, () => {
  const { home, bin } = headlessHome();
  const settings = JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { os: 'darwin', hostname: 'MacBook-Pro-2', homeDir: home } }),
  ], { input: fs.readFileSync(srcPath('.chezmoitemplates', 'settings.base.json'), 'utf8'), encoding: 'utf8' }));
  const out = execFileSync('bash', ['-c', 'printf %s "$SUDO_ASKPASS"'], {
    encoding: 'utf8',
    // SHLVL as a Claude Code started from a shell has it. Without it, Debian's bash takes a
    // socket stdin (node's pipes are socketpairs) for an sshd launch, reads /etc/bash.bashrc
    // and skips BASH_ENV.
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHLVL: '1', BASH_ENV: settings.env.BASH_ENV },
  });
  assert.strictEqual(out, path.join(bin, 'tmux-askpass'));
});

test('a non-interactive login bash gets SUDO_ASKPASS through env.sh', {
  skip: !have('bash') && 'bash unavailable',
}, () => {
  const { home, bin } = headlessHome();
  // env.sh puts ~/.local/bin on PATH, which survives a distro /etc/profile that resets PATH.
  const out = execFileSync('bash', ['-l', '-c', 'printf %s "$SUDO_ASKPASS"'], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin' },
  });
  assert.strictEqual(out, path.join(bin, 'tmux-askpass'));
});

test('askpass.sh keeps an inherited helper that exists, and replaces one that does not', {
  skip: !have('bash') && 'bash unavailable',
}, () => {
  const { home, bin } = headlessHome();
  const inherited = path.join(bin, 'other-askpass');
  fs.writeFileSync(inherited, '#!/bin/sh\n', { mode: 0o755 });
  const script = `. "${home}/.config/shell/askpass.sh"; printf %s "$SUDO_ASKPASS"`;
  const keep = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SUDO_ASKPASS: inherited },
  });
  assert.strictEqual(keep, inherited);
  const replace = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SUDO_ASKPASS: path.join(bin, 'gone') },
  });
  assert.strictEqual(replace, path.join(bin, 'tmux-askpass'));
});

// The display variables are read only once /usr/bin/ksshaskpass exists, which it does on no
// headless host, so the copy points that path at a scratch helper.
test('askpass.sh survives a caller\'s set -u with SUDO_ASKPASS and the display variables unset', {
  skip: !have('bash') && 'bash unavailable',
}, () => {
  const { home, bin } = headlessHome();
  const kssh = path.join(bin, 'ksshaskpass');
  fs.writeFileSync(kssh, '#!/bin/sh\n', { mode: 0o755 });
  const askpass = path.join(home, '.config', 'shell', 'askpass.sh');
  const seamed = fs.readFileSync(askpass, 'utf8').replaceAll('/usr/bin/ksshaskpass', kssh);
  assert.ok(seamed.includes(`[ -x ${kssh} ]`));
  fs.writeFileSync(askpass, seamed);
  const run = (env) => execFileSync('bash', ['-c', `set -u; . "${askpass}"; printf %s "$SUDO_ASKPASS"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  assert.strictEqual(run({}), path.join(bin, 'tmux-askpass'));
  assert.strictEqual(run({ DISPLAY: ':0' }), kssh);
});
