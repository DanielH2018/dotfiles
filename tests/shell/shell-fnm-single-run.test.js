// D12: an interactive bash LOGIN shell ran `fnm env` twice -- once in
// dot_bash_profile.tmpl (needed so a non-interactive login shell, `bash -lc` /
// `ssh host cmd`, which never reaches .bashrc/common.sh, still gets node on PATH),
// and again in common.sh (reached via .bashrc, for zsh's sake). The second run
// prepended a second fnm multishell directory to PATH.
//
// _FNM_ENV_LOADED, set right after dot_bash_profile.tmpl's own call, tells
// common.sh's call it already ran -- so an interactive bash login shell gets fnm
// exactly once, a non-interactive one (bash -lc) still gets it at all (only
// dot_bash_profile.tmpl's call fires, since .bashrc returns early), and zsh --
// which has no earlier call, only .zshenv's env.sh -- is untouched and still gets
// exactly one call via common.sh.
//
// Drives a STUB fnm (not the real one): the property under test is the call
// COUNT, which a real fnm's actual PATH-prepending behavior would not make any
// easier to observe.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const BASH_PROFILE = srcPath('dot_bash_profile.tmpl');
const BASHRC = srcPath('dot_bashrc');
const COMMON = srcPath('dot_config', 'shell', 'common.sh');
const ENV_SH = srcPath('dot_config', 'shell', 'env.sh');

const skipBash = !have('bash') && 'bash unavailable';
const skipZsh = !have('zsh') && 'zsh unavailable';

function makeHome() {
  const home = scratch(os.tmpdir(), 'fnm-single-run-');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // Logs one line per invocation; prints ":" so the eval'd result is a harmless no-op.
  fs.writeFileSync(path.join(bin, 'fnm'), '#!/bin/bash\necho called >> "$FNM_CALL_LOG"\necho ":"\n', { mode: 0o755 });
  // .bash_profile/.bashrc/common.sh resolve these by $HOME, so copy them in place.
  fs.mkdirSync(path.join(home, '.config', 'shell'), { recursive: true });
  fs.copyFileSync(COMMON, path.join(home, '.config', 'shell', 'common.sh'));
  fs.copyFileSync(ENV_SH, path.join(home, '.config', 'shell', 'env.sh'));
  fs.copyFileSync(BASHRC, path.join(home, '.bashrc'));
  fs.copyFileSync(BASH_PROFILE, path.join(home, '.bash_profile'));
  return { home, bin };
}

function callCount(log) {
  if (!fs.existsSync(log)) return 0;
  return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() === 'called').length;
}

test('bash -lc (non-interactive login) still gets fnm, exactly once', { skip: skipBash }, () => {
  const { home, bin } = makeHome();
  const log = path.join(home, 'fnm-calls.log');
  execFileSync('bash', ['-lc', 'true'], {
    env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, FNM_CALL_LOG: log },
    encoding: 'utf8',
  });
  assert.strictEqual(callCount(log), 1);
});

test('an interactive bash login shell gets fnm exactly once, not twice', { skip: skipBash }, () => {
  const { home, bin } = makeHome();
  const log = path.join(home, 'fnm-calls.log');
  // -il: a real login+interactive shell, which sources .bash_profile once on its own
  // startup (which itself sources .bashrc once) -- unlike `bash -i -c '. .bash_profile'`,
  // which would ALSO auto-source .bashrc on -i's own startup before the -c command runs
  // its own explicit sourcing, double-counting an artifact of the test rather than this
  // fix. .bashrc does not return early at its "interactive shells only" guard here, so
  // it reaches common.sh, same as a real interactive bash login shell would.
  execFileSync('bash', ['-il', '-c', 'true'], {
    env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, FNM_CALL_LOG: log },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], // silence bash's job-control-without-a-tty noise
  });
  assert.strictEqual(callCount(log), 1);
});

test('zsh still gets exactly one fnm call (env.sh then common.sh)', { skip: skipZsh }, () => {
  const { home, bin } = makeHome();
  const log = path.join(home, 'fnm-calls.log');
  execFileSync('zsh', ['-c', '. "$HOME/.config/shell/env.sh"; . "$HOME/.config/shell/common.sh"'], {
    env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, FNM_CALL_LOG: log },
    encoding: 'utf8',
  });
  assert.strictEqual(callCount(log), 1);
});
