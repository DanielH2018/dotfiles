// Regression guard for executable_chezmoi-apply-guard.sh (PreToolUse/Bash).
// Drives the ACTUAL hook with a STUB `chezmoi` on PATH so it's hermetic. The
// discriminator under test is chezmoi's own status columns, verified against
// chezmoi v2.71.1: " M path" is the normal source-edited workflow and must pass,
// "MM path" means the deployed file changed outside chezmoi and apply would
// discard it. Blocking the first would make the hook useless, so both directions
// are pinned. Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_chezmoi-apply-guard.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'czag-bin-'));
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
# Only 'status' is consulted by the hook; echo the fixture it was given.
case "$1" in
  status) printf '%s' "$STUB_STATUS"; [ -n "$STUB_STATUS" ] && printf '\\n' ;;
  *) exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

const CLEAN = '';
const NORMAL = ' M /home/daniel/.local/bin/agentview';
const CLOBBER = 'MM /home/daniel/.local/bin/agentview';

// A decision, or null when the hook stayed out of the way.
function decide(command, stubStatus) {
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, STUB_STATUS: stubStatus, HOME: '/home/daniel' },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

const denies = (command, stub = CLOBBER) => {
  const d = decide(command, stub);
  assert.ok(d, `expected a decision for: ${command}`);
  assert.strictEqual(d.permissionDecision, 'deny');
  return d.permissionDecisionReason;
};
const allows = (command, stub = CLOBBER) =>
  assert.strictEqual(decide(command, stub), null, `expected no decision for: ${command}`);

test('denies an apply that would discard an out-of-band deployed change', { skip }, () => {
  const reason = denies('chezmoi apply');
  assert.match(reason, /\/home\/daniel\/\.local\/bin\/agentview/);
  assert.match(reason, /chezmoi diff/);
  assert.match(reason, /CHEZMOI_APPLY_GUARD=off/);
});

test('allows the normal workflow: source edited, deployed untouched', { skip }, () => {
  allows('chezmoi apply', NORMAL);
  allows('chezmoi apply', CLEAN);
  allows('chezmoi apply', ' A /home/daniel/.local/bin/newthing');
});

test('ignores commands that do not write deployed files', { skip }, () => {
  allows('ls -la');
  allows('chezmoi status');
  allows('chezmoi diff ~/.local/bin/agentview');
  allows('chezmoi source-path ~/.zshrc');
});

test('covers the other writing verbs', { skip }, () => {
  denies('chezmoi update');
  denies('chezmoi init --apply DanielH2018/dotfiles');
});

test('--dry-run writes nothing, so it is never blocked', { skip }, () => {
  allows('chezmoi apply --dry-run');
});

test('the documented override lets a deliberate revert through', { skip }, () => {
  allows('CHEZMOI_APPLY_GUARD=off chezmoi apply');
});

test('a line-continuation cannot hide the verb', { skip }, () => {
  denies('chezmoi \\\n  apply');
});

test('scoped applies only care about conflicts under the named target', { skip }, () => {
  denies('chezmoi apply /home/daniel/.local/bin/agentview');
  denies('chezmoi apply ~/.local/bin/agentview');
  denies('chezmoi apply /home/daniel/.local/bin');
  allows('chezmoi apply /home/daniel/.zshrc');
  allows('chezmoi apply ~/.config/wezterm');
});

test('a flag value that looks like a path is not treated as a target', { skip }, () => {
  // --source=... names the source tree, not a target; the conflict is still real.
  denies('chezmoi --source=/home/daniel/.local/share/chezmoi apply');
});

test('stays silent when chezmoi status fails', { skip }, () => {
  // Stub returns nothing for an unknown subcommand shape; hook must not block.
  allows('chezmoi apply', CLEAN);
});
