// Regression guard for home/dot_local/bin/executable_stdio-blocking.
//
// The script exists to clear O_NONBLOCK on fds 0, 1 and 3 without landing on the
// `Bash(python3 -c:*)` ask rule the inline fixup it replaces used to match. Two
// properties matter: it takes no arguments, and it actually leaves the targeted fds
// blocking (tolerating fd 3 being closed, which is the common case for a bare
// `stdio-blocking;` prefix with no fd redirection of its own).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_stdio-blocking');

let hasPython = true;
try { execFileSync('bash', ['-c', 'command -v python3'], { stdio: 'ignore' }); } catch { hasPython = false; }
const skip = hasPython ? false : 'python3 unavailable';

test('takes no arguments', { skip }, () => {
  assert.throws(() => execFileSync('python3', [SCRIPT, 'unexpected'], { stdio: 'pipe' }));
  // No arguments at all must succeed.
  assert.doesNotThrow(() => execFileSync('python3', [SCRIPT], { stdio: 'pipe' }));
});

test('clears O_NONBLOCK on fd 1, with fd 3 absent tolerated', { skip }, () => {
  // Run the script with stdout put into non-blocking mode beforehand, then read the
  // flag back with the stdlib in the SAME process the script touched. fd 3 is never
  // opened by this invocation at all -- the script must not raise or exit non-zero
  // over that, which is the "tolerate a missing fd 3" behavior this test pins.
  const probe = [
    'import os, subprocess, sys, fcntl',
    `fl = fcntl.fcntl(1, fcntl.F_GETFL)`,
    'fcntl.fcntl(1, fcntl.F_SETFL, fl | os.O_NONBLOCK)',
    'assert not os.get_blocking(1)',
    `r = subprocess.run(["${SCRIPT}"])`,
    'assert r.returncode == 0, r.returncode',
    'assert os.get_blocking(1), "fd 1 still non-blocking after stdio-blocking"',
    'print("OK")',
  ].join('\n');
  const out = execFileSync('python3', ['-c', probe], { encoding: 'utf8' });
  assert.strictEqual(out.trim(), 'OK');
});

test('structure: targets fds 0, 1 and 3 and tolerates a missing one', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(/for fd in \(0, 1, 3\):/.test(src), 'expected the fixup to target fds 0, 1 and 3');
  assert.ok(/suppress\(OSError\)/.test(src), 'expected a missing fd to be tolerated, not raised');
});
