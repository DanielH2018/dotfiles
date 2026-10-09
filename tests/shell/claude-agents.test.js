// Behavior check for claude-agents in home/dot_config/shell/common.sh: the launcher that
// starts `claude agents` as the dedicated `claude` UNIX user. Lifted verbatim from the source
// and driven in bash and zsh with getent and sudo stubbed, so machinectl never runs.
// Two properties: it exists only where the claude user does, and it sends the exact machinectl
// command with a caller's arguments as separate argv entries.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const COMMON = srcPath('dot_config', 'shell', 'common.sh');
const BLOCK = fs.readFileSync(COMMON, 'utf8').match(/^if getent passwd claude[\s\S]*?^fi$/m);
assert.ok(BLOCK, 'the claude-agents gate exists in common.sh');
const SRC = BLOCK[0];

// getent succeeds only when GETENT_HAS_CLAUDE=1; sudo prints one argv entry per line.
function makeBin() {
  const bin = scratch(os.tmpdir(), 'cagents-');
  fs.writeFileSync(path.join(bin, 'getent'), '#!/bin/bash\n[ "$GETENT_HAS_CLAUDE" = 1 ]\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  return bin;
}

function run(shell, script, { hasClaude }) {
  const bin = makeBin();
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GETENT_HAS_CLAUDE: hasClaude ? '1' : '0' };
  return execFileSync(shell, ['-c', `${SRC}\n${script}`], { env, encoding: 'utf8', timeout: 10000 });
}

for (const shell of ['bash', 'zsh']) {
  const skip = have(shell) ? false : `${shell} unavailable`;

  test(`${shell}: no function where the claude user is absent`, { skip }, () => {
    const out = run(shell, 'type claude-agents >/dev/null 2>&1 && echo defined || echo absent', { hasClaude: false });
    assert.strictEqual(out.trim(), 'absent');
  });

  test(`${shell}: sudo receives the machinectl command with arguments as separate argv`, { skip }, () => {
    const out = run(shell, `claude-agents --resume 'a b' "it's"`, { hasClaude: true });
    assert.deepStrictEqual(out.trimEnd().split('\n'), [
      'machinectl', 'shell', 'claude@', '/bin/bash', '-lc',
      'cd ~/server && exec claude agents "$@"', 'claude-agents',
      '--resume', 'a b', "it's",
    ]);
  });
}
