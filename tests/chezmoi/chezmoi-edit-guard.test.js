// Regression guard for executable_chezmoi-edit-guard.sh (PreToolUse/Edit|Write, #574).
// Drives the ACTUAL hook with a STUB `chezmoi` on PATH and a scratch HOME. The pair that
// matters: an edit to a deployed file whose source is a template or script is denied and
// names that source, while an edit to a plain managed file gets no decision, because
// chezmoi-guard.sh's PostToolUse resync is the right handling for it.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_chezmoi-edit-guard.sh');

const skip = skipUnless('bash', 'jq');

const HOME = scratch(os.tmpdir(), 'czeg-home-');
const BIN = scratch(os.tmpdir(), 'czeg-bin-');
const SRC = path.join(HOME, '.local', 'share', 'chezmoi', 'home');
// source-path maps by target, the way chezmoi v2.71.1 answers for these shapes.
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
case "$1" in
  managed) printf '%s\\n' "$HOME/.claude/settings.json" "$HOME/.claude/CLAUDE.md" \\
             "$HOME/.claude/hooks/notify.sh" "$HOME/.gitconfig" "$HOME/.config/once" ;;
  source-path)
    case "$2" in
      "$HOME/.claude/settings.json") echo "${SRC}/private_dot_claude/modify_settings.json.sh.tmpl" ;;
      "$HOME/.claude/CLAUDE.md") echo "${SRC}/private_dot_claude/CLAUDE.md.tmpl" ;;
      "$HOME/.claude/hooks/notify.sh") echo "${SRC}/private_dot_claude/hooks/executable_notify.sh" ;;
      "$HOME/.gitconfig") echo "${SRC}/modify_dot_gitconfig" ;;
      "$HOME/.config/once") echo "${SRC}/dot_config/create_once" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

function decide(file_path, extraEnv = {}) {
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { file_path } }),
    encoding: 'utf8',
    env: {
      ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`,
      XDG_CACHE_HOME: path.join(HOME, '.cache'), CHEZMOI_EDIT_GUARD: '', ...extraEnv,
    },
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput : null;
}

test('denies an edit to the generated settings.json, naming settings.base.json', { skip }, () => {
  const d = decide(path.join(HOME, '.claude', 'settings.json'));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes(
    path.join(SRC, '.chezmoitemplates', 'settings.base.json')));
});

test('denies an edit to a template or modify_ output, printing its source', { skip }, () => {
  const d = decide(path.join(HOME, '.claude', 'CLAUDE.md'));
  assert.strictEqual(d.permissionDecision, 'deny');
  assert.ok(d.permissionDecisionReason.includes(path.join(SRC, 'private_dot_claude', 'CLAUDE.md.tmpl')));
  assert.strictEqual(decide(path.join(HOME, '.gitconfig')).permissionDecision, 'deny');
});

test('passes an edit to the source itself', { skip }, () => {
  assert.strictEqual(decide(path.join(SRC, '.chezmoitemplates', 'settings.base.json')), null);
});

test('passes a plain managed file, a create_ target and an unmanaged file', { skip }, () => {
  assert.strictEqual(decide(path.join(HOME, '.claude', 'hooks', 'notify.sh')), null);
  assert.strictEqual(decide(path.join(HOME, '.config', 'once')), null);
  assert.strictEqual(decide(path.join(HOME, 'scratch.txt')), null);
  assert.strictEqual(decide('/etc/hosts'), null);
});

test('the session-level override turns it off', { skip }, () => {
  assert.strictEqual(decide(path.join(HOME, '.claude', 'CLAUDE.md'), { CHEZMOI_EDIT_GUARD: 'off' }), null);
});
