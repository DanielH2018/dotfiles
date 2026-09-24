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
// A real source dir, because the shared managed-set cache is keyed on it (#613).
fs.mkdirSync(SRC, { recursive: true });
fs.writeFileSync(path.join(SRC, 'dot_gitconfig'), 'x\n');
// source-path maps by target, the way chezmoi v2.71.1 answers for these shapes. CALLS
// records each verb, and EXTRA lists targets that became managed after the first call.
const CALLS = path.join(BIN, 'calls.log');
const EXTRA = path.join(BIN, 'extra-managed');
fs.writeFileSync(path.join(BIN, 'chezmoi'), `#!/bin/bash
echo "$1" >> ${JSON.stringify(CALLS)}
case "$1" in
  managed) [ -n "\${CZ_STUB_SLOW_MANAGED:-}" ] && sleep 30
           printf '%s\\n' "$HOME/.claude/settings.json" "$HOME/.claude/CLAUDE.md" \\
             "$HOME/.claude/hooks/notify.sh" "$HOME/.gitconfig" "$HOME/.config/once"
           cat ${JSON.stringify(EXTRA)} 2>/dev/null || true ;;
  source-path)
    [ -n "\${CZ_STUB_SLOW_LOOKUP:-}" ] && sleep 30
    grep -qxF "$2" ${JSON.stringify(EXTRA)} 2>/dev/null && { echo "${SRC}/dot_new.tmpl"; exit 0; }
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

const callCount = (verb) => (fs.existsSync(CALLS)
  ? fs.readFileSync(CALLS, 'utf8').split('\n').filter((l) => l === verb).length
  : 0);
const reset = () => {
  fs.rmSync(CALLS, { force: true });
  fs.rmSync(path.join(HOME, '.cache', 'claude-hooks'), { recursive: true, force: true });
};

function decide(file_path, extraEnv = {}, hook = HOOK) {
  const out = execFileSync('bash', [hook], {
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

// ---- the managed-set cache, shared with chezmoi-guard.sh (#613) ------------------------

test('a cache chezmoi-guard.sh wrote answers this hook without a second lookup', { skip }, () => {
  reset();
  const f = path.join(HOME, 'scratch.txt');
  const postHook = srcPath('private_dot_claude', 'hooks', 'executable_chezmoi-guard.sh');
  assert.strictEqual(decide(f, {}, postHook), null);
  assert.strictEqual(decide(f), null);
  assert.strictEqual(callCount('managed'), 1, 'both hooks must read one cache');
  assert.strictEqual(callCount('source-path'), 0);
});

test('a target that becomes managed is denied on the next call, not after a TTL', { skip }, (t) => {
  reset();
  const f = path.join(HOME, '.config', 'new');
  assert.strictEqual(decide(f), null);
  const added = path.join(SRC, 'dot_config', 'new.tmpl');
  fs.mkdirSync(path.dirname(added), { recursive: true });
  fs.writeFileSync(added, 'x\n');
  fs.writeFileSync(EXTRA, `${f}\n`);
  t.after(() => [added, EXTRA].forEach((p) => fs.rmSync(p, { force: true })));
  assert.strictEqual(decide(f).permissionDecision, 'deny');
});

// ---- every chezmoi call is bounded, and a lookup that cannot finish asks (#657) ---------
//
// source-path used to run bare behind `|| exit 0`, so a chezmoi that hung or failed read
// exactly like an unmanaged file: no decision, and the edit to a template's output went
// through. A lookup that does not finish is now an ask that names it. The accepting half of
// each pair is 'passes a plain managed file, a create_ target and an unmanaged file' above.
// run_bounded needs timeout(1), and without one every lookup reports not evaluated.
const skipBounded = skipUnless('bash', 'jq', 'timeout');

function timed(file, env) {
  const started = Date.now();
  const d = decide(file, env);
  return { d, seconds: (Date.now() - started) / 1000 };
}

test('a hung source-path lookup asks, naming what did not finish', { skip: skipBounded }, () => {
  const { d, seconds } = timed(path.join(HOME, '.claude', 'CLAUDE.md'), {
    CZ_STUB_SLOW_LOOKUP: '1', CHEZMOI_EDIT_GUARD_TIMEOUT_S: '1', CHEZMOI_GUARD_CACHE: '0',
  });
  assert.ok(seconds < 10, `took ${seconds}s`);
  assert.strictEqual(d && d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /source-path.*did not answer within 1s \(timeout\).*not evaluated/s);
});

test('a hung chezmoi managed is cut off and leaves no cache behind', { skip: skipBounded }, () => {
  reset();
  const { d, seconds } = timed(path.join(HOME, 'scratch.txt'), {
    CZ_STUB_SLOW_MANAGED: '1', CHEZMOI_MANAGED_TIMEOUT_S: '1',
  });
  assert.ok(seconds < 10, `took ${seconds}s`);
  // With no cache the authority answers: scratch.txt is unmanaged, so no decision.
  assert.strictEqual(d, null);
  assert.strictEqual(callCount('source-path'), 1);
  assert.ok(!fs.existsSync(path.join(HOME, '.cache', 'claude-hooks', 'chezmoi-managed')));
});

test('a missing run-bounded.sh asks rather than running chezmoi unbounded', { skip }, () => {
  reset();
  const d = decide(path.join(HOME, 'scratch.txt'), { RUN_BOUNDED_LIB: path.join(BIN, 'no-such-lib.sh') });
  assert.strictEqual(d && d.permissionDecision, 'ask');
  assert.match(d.permissionDecisionReason, /cannot load .*not evaluated/);
  assert.strictEqual(callCount('source-path') + callCount('managed'), 0);
});
