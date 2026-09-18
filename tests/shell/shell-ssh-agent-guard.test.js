// The ssh-agent autostart block in shell/common.sh spawns a DETACHED agent, so anything it
// starts outlives the shell that sourced the file. That is what we want for an interactive
// pane and a disaster everywhere else: a non-interactive `sh -c '. common.sh'` with a scratch
// HOME and no inherited SSH_AUTH_SOCK spawned one agent per invocation, none of which ever
// exited. The test suite does exactly that — tests/shell/shell-clipimg.test.js builds its env
// from scratch and a fresh mkdtemp HOME per case — and accumulated 1,033 orphaned agents
// (983 MB) in four hours, each holding a socket whose directory the test had already deleted.
//
// So both directions are pinned here: no agent from a non-interactive source, still an agent
// from an interactive one. Uses a unique scratch HOME per case (never $TMPDIR itself, which is
// the shared path shell-init-slice5.test.js leaks onto) and reaps anything it starts.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');

const COMMON = path.join(__dirname, '..', '..', 'home', 'dot_config', 'shell', 'common.sh');

const SHELLS = ['bash', 'zsh'].filter(have);
const skip = SHELLS.length ? false : 'no bash or zsh available';

const strays = [];

// A scratch HOME with no SSH_AUTH_SOCK and no XDG_RUNTIME_DIR — the combination that arms the
// autostart. PATH keeps /usr/bin because that is where ssh-agent lives: stripping PATH down to
// the fixture's own bin is what shell-clipimg.test.js believed made this block a no-op, and it
// does not.
function scratchHome() {
  const dir = scratch(os.tmpdir(), 'agentguard-');
  return dir;
}

function sourceCommon(shell, home, { interactive }) {
  execFileSync(shell, [interactive ? '-ic' : '-c', `. "${COMMON}" 2>/dev/null; :`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin', SHELL: shell },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ssh-agent daemonizes, so the socket file appears before the process is reachable and its
// absence is not proof either way. Match on the process holding this exact socket path.
function agentPidsFor(sock) {
  try {
    const out = execFileSync('pgrep', ['-f', `ssh-agent -a ${sock}`], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function sockFor(home) {
  return path.join(home, '.ssh-agent.sock');
}

for (const shell of SHELLS) {
  test(`[${shell}] a non-interactive source of common.sh starts no ssh-agent`, { skip }, () => {
    const home = scratchHome();
    sourceCommon(shell, home, { interactive: false });
    const pids = agentPidsFor(sockFor(home));
    strays.push(...pids);
    assert.deepStrictEqual(pids, [], `non-interactive source leaked ssh-agent pid(s) ${pids}`);
    assert.strictEqual(fs.existsSync(sockFor(home)), false, 'no agent socket should be created');
  });

  test(`[${shell}] an interactive source of common.sh still starts one ssh-agent`, { skip }, () => {
    const home = scratchHome();
    sourceCommon(shell, home, { interactive: true });
    const pids = agentPidsFor(sockFor(home));
    strays.push(...pids);
    assert.strictEqual(pids.length, 1, `expected exactly one agent for an interactive shell, got ${pids.length}`);
  });
}

process.on('exit', () => {
  for (const pid of strays) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
});
