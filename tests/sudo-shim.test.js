// Behavioral tests for the `sudo` shim (executable_sudo).
//
// The shim exists because sudo on Ubuntu 24.04 ignores SUDO_ASKPASS unless -A is passed,
// so a `!` command with no terminal cannot reach the askpass helper on its own. What
// matters is that it adds the flag in exactly one situation and is otherwise invisible:
// shadowing `sudo` in PATH is only tolerable if every other invocation is byte-identical
// to what the user typed.
//
// Seam: SUDO_SHIM_REAL points at a recorder instead of /usr/bin/sudo, so no test ever
// invokes the real thing.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHIM = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_sudo');

const dirs = [];
function scratch(p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// runTty below needs util-linux script(1), not just any script(1): macOS ships the BSD one,
// which takes a different command form and tcgetattr's its own stdin, so from a node child with
// piped stdio it cannot allocate a pty at all -- `script: illegal option -- c` followed by an
// exit the assertion reads as the shim mangling argv. ptyAvailable() is the flavour probe the
// TUI suites already gate on. (The shim itself is Linux-only anyway: .chezmoiignore deploys
// .local/bin/sudo to the three headless hosts and nowhere else.)
const { ptyAvailable } = require('./lib/pty');

const hasScript = ptyAvailable();

// Records argv one per line, so the assertions read like the command line.
const RECORDER = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done
`;

function shim({ askpass = '/home/u/.local/bin/tmux-askpass' } = {}) {
  const home = scratch('sudoshim-');
  const real = path.join(home, 'recorder');
  fs.writeFileSync(real, RECORDER, { mode: 0o755 });
  const deployed = path.join(home, 'sudo');
  fs.copyFileSync(SHIM, deployed);
  fs.chmodSync(deployed, 0o755);

  const env = { ...process.env, SUDO_SHIM_REAL: real };
  if (askpass === null) delete env.SUDO_ASKPASS; else env.SUDO_ASKPASS = askpass;

  return {
    // No tty: stdin from a pipe and /dev/tty unavailable to the child is the `!` case.
    run: (args) => execFileSync(deployed, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .trim().split('\n').filter(Boolean),
    // Under a pty, so has_tty() succeeds — the interactive case.
    runTty: (args) => execFileSync('script', ['-qec', `${deployed} ${args.join(' ')}`, '/dev/null'],
      { env, encoding: 'utf8' }).trim().split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean),
  };
}

test('adds -A when there is no terminal and an askpass helper is configured', () => {
  assert.deepEqual(shim().run(['ls']), ['-A', 'ls']);
});

test('leaves the command alone when no askpass helper is configured', () => {
  assert.deepEqual(shim({ askpass: null }).run(['ls']), ['ls']);
});

test('does not double up when -A was already given', () => {
  assert.deepEqual(shim().run(['-A', 'ls']), ['-A', 'ls']);
});

test('respects an invocation that chose its own input method', () => {
  assert.deepEqual(shim().run(['-S', 'ls']), ['-S', 'ls']);
  assert.deepEqual(shim().run(['-n', 'true']), ['-n', 'true']);
  assert.deepEqual(shim().run(['--stdin', 'ls']), ['--stdin', 'ls']);
  assert.deepEqual(shim().run(['--non-interactive', 'true']), ['--non-interactive', 'true']);
});

test('sees the flag inside a bundle', () => {
  assert.deepEqual(shim().run(['-kS', 'ls']), ['-kS', 'ls']);
});

// --preserve-env contains an "n"; a naive bundle match would read it as --non-interactive
// and silently skip the flag the whole shim exists to add.
test('does not mistake a long option for a bundled -n', () => {
  assert.deepEqual(shim().run(['--preserve-env', 'ls']), ['-A', '--preserve-env', 'ls']);
});

test('inserts the flag ahead of options that take a value', () => {
  assert.deepEqual(shim().run(['-u', 'postgres', 'psql']), ['-A', '-u', 'postgres', 'psql']);
});

test('stops looking at options once the command begins', () => {
  // `-n` here is an argument to ls, not a sudo flag, so the shim must still add -A.
  assert.deepEqual(shim().run(['ls', '-n']), ['-A', 'ls', '-n']);
});

test('preserves arguments containing spaces', () => {
  assert.deepEqual(shim().run(['sh', '-c', 'echo a b']), ['-A', 'sh', '-c', 'echo a b']);
});

test('passes through untouched when a terminal is available', { skip: hasScript ? false : 'no util-linux script(1) for a pty (macOS ships the BSD one)' }, () => {
  assert.deepEqual(shim().runTty(['ls']), ['ls']);
});
