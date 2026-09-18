// Behavior checks for the WezTerm-only shell-integration block in shell/common.sh
// (OSC 133 prompt marks + OSC 777 command-finish notify — the Ghostty parity shims).
// The block is extracted by its marker comment and exercised directly in bash and zsh,
// so a regression in the $WEZTERM_PANE gate, the 10s threshold, or the emitted escape
// bytes fails here instead of surfacing live on the Windows box. Whole-file `-n` parse
// checks run too, since common.sh is sourced by both shells.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const COMMON = srcPath('dot_config', 'shell', 'common.sh');

// Slice the gated block out of common.sh: marker comment through the column-0 `fi`.
function wzBlock() {
  const lines = fs.readFileSync(COMMON, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('# --- WezTerm-only:'));
  assert.notStrictEqual(start, -1, 'marker comment found in common.sh');
  const end = lines.findIndex((l, i) => i > start && l === 'fi');
  assert.notStrictEqual(end, -1, 'closing fi found after marker');
  return lines.slice(start, end + 1).join('\n');
}

// Replays a session: a 12s command (start time backdated), then an instant one.
// `|` separates the two prompts in the captured output.
const DRIVER = `
__wz_preexec 'sleep 15'
__wz_t0=$((SECONDS - 12))
__wz_precmd
printf '|'
__wz_preexec 'ls'
__wz_precmd
`;

const MARK = '\x1b]133;A\x1b\\';
const NOTIFY = '\x1b]777;notify;Done in 12s;sleep 15\x1b\\';

for (const shell of ['bash', 'zsh']) {
  const skip = !have(shell) && `${shell} unavailable`;

  test(`${shell}: whole common.sh parses (-n)`, { skip }, () => {
    execFileSync(shell, ['-n', COMMON], { stdio: 'pipe' });
  });

  test(`${shell}: marks every prompt, notifies only for commands >= 10s`, { skip }, () => {
    const out = execFileSync(shell, ['-c', wzBlock() + DRIVER], {
      encoding: 'utf8', env: { ...process.env, WEZTERM_PANE: '1' },
    });
    const [slow, fast] = out.split('|');
    assert.ok(slow.includes(MARK), 'prompt mark emitted');
    assert.ok(slow.includes(NOTIFY), `notify for the 12s command: ${JSON.stringify(slow)}`);
    assert.ok(fast.includes(MARK), 'second prompt mark emitted');
    assert.ok(!fast.includes(']777;'), 'no notify for an instant command');
  });

  test(`${shell}: inert without $WEZTERM_PANE (Ghostty/tmux shells)`, { skip }, () => {
    const env = { ...process.env };
    delete env.WEZTERM_PANE;
    const script = wzBlock() + '\ntype __wz_precmd >/dev/null 2>&1 && echo defined; exit 0';
    const out = execFileSync(shell, ['-c', script], { encoding: 'utf8', env });
    assert.ok(!out.includes('defined'), 'hooks not defined when the gate is closed');
  });
}
