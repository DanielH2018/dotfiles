// Behavior check for the routing in claude() in home/dot_config/shell/common.sh: plain `claude`
// starts as the dedicated `claude` UNIX user, but only from an interactive shell with TTYs
// inside ~/server. Everything else must behave as before, because a Claude Code Bash tool call
// sources this function from its shell snapshot and a sudo prompt there would hang.
//
// The TTY condition is the one a pipe-based harness cannot fake, so the cases that need a TTY
// run under util-linux `script`, which gives the shell a pty for stdin and stdout. getent, id,
// sudo and claude are stubs on PATH, so machinectl never runs.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const COMMON = fs.readFileSync(srcPath('dot_config', 'shell', 'common.sh'), 'utf8');
const FN = COMMON.match(/^claude\(\) \{[\s\S]*?^\}$/m)[0];
const UBUNTU = COMMON.match(/^claude-ubuntu\(\) \{[\s\S]*?^\}$/m)[0];
const GATE = COMMON.match(/^if getent passwd claude[\s\S]*?^fi$/m)[0];
const SRC = `${GATE}\n${FN}\n${UBUNTU}`;

const skipPty = skipUnless('script');

// sudo and claude each print one tagged line; getent succeeds, id names a non-claude user.
function makeBin() {
  const bin = scratch(os.tmpdir(), 'cdefault-');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('getent', 'exit 0');
  stub('id', 'echo operator');
  stub('sudo', 'echo "AGENT $*"');
  stub('claude', 'echo "LOCAL $*"');
  return bin;
}

// Run `cmd` in `shell` with the given interactive flag and TTY-ness, from `cwd`. Returns
// stdout and stderr merged for the pty case (a pty has one stream) and separately otherwise.
function run(shell, cmd, { interactive, tty, rel = 'server', env = {} }) {
  const bin = makeBin();
  const home = scratch(os.tmpdir(), 'cdefault-home-');
  const cwd = path.join(home, rel);
  fs.mkdirSync(cwd, { recursive: true });
  const flags = interactive ? '-fi' : '-f';
  const script = `${SRC}\n${cmd}`;
  const e = { ...process.env, ...env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PWD: cwd };
  delete e.CLAUDE_AS_OPERATOR;
  Object.assign(e, env);
  const argv = tty
    ? ['script', ['-qec', `${shell} ${flags} -c '${script.replace(/'/g, `'\\''`)}'`, '/dev/null']]
    : [shell, [flags, '-c', script]];
  const r = spawnSync(argv[0], argv[1], { cwd, env: e, encoding: 'utf8', timeout: 15000, input: '' });
  return (r.stdout + r.stderr).replace(/\r/g, '');
}

for (const shell of ['bash', 'zsh']) {
  const skip = skipUnless(shell) || skipPty;

  test(`${shell}: routes to the claude user in ~/server when interactive on a TTY`, { skip }, () => {
    const out = run(shell, `claude --resume 'a b'`, { interactive: true, tty: true });
    assert.match(out, /AGENT machinectl shell claude@ \/bin\/bash -lc cd ~\/server && exec claude "\$@" claude --resume a b/);
    assert.match(out, /starting as the 'claude' user/);
    assert.doesNotMatch(out, /LOCAL/);
  });

  test(`${shell}: routes from a worktree under ~/server`, { skip }, () => {
    const out = run(shell, 'claude', { interactive: true, tty: true, rel: 'server/.claude/worktrees/x' });
    assert.match(out, /AGENT machinectl/);
  });

  test(`${shell}: does not route outside ~/server (a sibling with the same prefix included)`, { skip }, () => {
    for (const rel of ['dev', 'server-old']) {
      const out = run(shell, 'claude', { interactive: true, tty: true, rel });
      assert.match(out, /LOCAL/, rel);
      assert.doesNotMatch(out, /AGENT/, rel);
    }
  });

  test(`${shell}: does not route from a non-interactive shell, TTY or not`, { skip }, () => {
    for (const tty of [true, false]) {
      const out = run(shell, 'claude', { interactive: false, tty });
      assert.match(out, /LOCAL/, `tty=${tty}`);
      assert.doesNotMatch(out, /AGENT/, `tty=${tty}`);
    }
  });

  test(`${shell}: does not route without a TTY even when interactive`, { skip }, () => {
    const out = run(shell, 'claude', { interactive: true, tty: false });
    assert.match(out, /LOCAL/);
    assert.doesNotMatch(out, /AGENT/);
  });

  test(`${shell}: CLAUDE_AS_OPERATOR=1 and claude-ubuntu both bypass the routing`, { skip }, () => {
    const viaEnv = run(shell, 'claude', { interactive: true, tty: true, env: { CLAUDE_AS_OPERATOR: '1' } });
    assert.match(viaEnv, /LOCAL/);
    assert.doesNotMatch(viaEnv, /AGENT/);
    // The second call proves claude-ubuntu's opt-out did not leak into the shell.
    const viaFn = run(shell, 'claude-ubuntu one; claude two', { interactive: true, tty: true });
    assert.match(viaFn, /LOCAL one/);
    assert.match(viaFn, /AGENT .* claude two/);
  });
}
