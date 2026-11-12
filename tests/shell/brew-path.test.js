// shell/brew.sh owns Homebrew's PATH entries for bash and zsh, and the login files source it.
// A scratch HOMEBREW_PREFIX stands in for a Mac, so the suite runs on Linux, where no brew is.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const BREW_SH = srcPath('dot_config', 'shell', 'brew.sh');

function fakePrefix() {
  const prefix = scratch(os.tmpdir(), 'brew-prefix-');
  for (const d of ['bin', 'sbin', 'opt/python@3.14/libexec/bin', 'opt/coreutils/libexec/gnubin',
    'opt/util-linux/bin']) {
    fs.mkdirSync(path.join(prefix, d), { recursive: true });
  }
  return prefix;
}

function expectedPath(prefix, middle) {
  return [
    `${prefix}/opt/coreutils/libexec/gnubin`,
    `${prefix}/opt/python@3.14/libexec/bin`,
    `${prefix}/bin`,
    `${prefix}/sbin`,
    ...middle,
    `${prefix}/opt/util-linux/bin`,
  ].join(':');
}

for (const shell of ['sh', 'bash', 'zsh']) {
  test(`${shell}: sourcing brew.sh twice moves the brew entries to the front once each`, {
    skip: !have(shell) && `${shell} unavailable`,
  }, () => {
    const prefix = fakePrefix();
    const out = execFileSync(shell, ['-c', `. "${BREW_SH}"; . "${BREW_SH}"; printf %s "$PATH"`], {
      encoding: 'utf8',
      env: { HOME: os.tmpdir(), HOMEBREW_PREFIX: prefix, PATH: `/usr/bin:${prefix}/bin:/bin` },
    });
    assert.strictEqual(out, expectedPath(prefix, ['/usr/bin', '/bin']));
  });
}

test('a non-interactive login bash, the Bash tool\'s snapshot shell, gets the brew entries', {
  skip: !have('bash') && 'bash unavailable',
}, () => {
  const home = scratch(os.tmpdir(), 'brew-home-');
  fs.mkdirSync(path.join(home, '.config', 'shell'), { recursive: true });
  for (const f of ['env.sh', 'brew.sh']) {
    fs.copyFileSync(srcPath('dot_config', 'shell', f), path.join(home, '.config', 'shell', f));
  }
  fs.copyFileSync(srcPath('dot_bash_profile.tmpl'), path.join(home, '.bash_profile'));
  const prefix = fakePrefix();
  const out = execFileSync('bash', ['-l', '-c', 'printf %s "$PATH"'], {
    encoding: 'utf8',
    env: { HOME: home, HOMEBREW_PREFIX: prefix, PATH: '/usr/bin:/bin' },
  });
  const entries = out.split(':');
  assert.deepStrictEqual(entries.slice(0, 4), expectedPath(prefix, []).split(':').slice(0, 4), out);
  assert.strictEqual(entries.at(-1), `${prefix}/opt/util-linux/bin`, out);
});
