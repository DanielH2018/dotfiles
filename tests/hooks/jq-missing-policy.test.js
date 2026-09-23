// The jq-missing policy for the three hooks that build their output with `jq -n`.
//
// hook-input.sh's hook_require_jq is the one place that policy is expressed: `ask` for a
// PreToolUse gate that must not fail open silently, `noop` for a reminder or a banner. These
// three carried no policy at all -- post-compact.sh and worktree-context.sh ran `jq -n` with
// nothing in front of it, and voice-reminder.sh hand-rolled `command -v jq`.
//
// Without the guard, bash exits 127 and writes `jq: command not found` to the harness's
// hook-stderr channel: once per compaction, and once per prompt in a worktree. That is the
// half a test only ever sees if it removes jq, so each hook gets a PAIR here -- one input it
// must answer, and one it must stay silent on. A guard asserted only from the jq-present side
// is indistinguishable from no guard at all.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const HOOKS = srcPath('private_dot_claude', 'hooks');
const LIB = path.join(HOOKS, 'hook-input.sh');

const skip = skipUnless('bash', 'jq', 'git');

// A PATH that holds bash and git and nothing else, so jq is absent the way it is on a
// machine that never installed it. Emptying PATH outright would take git with it and
// worktree-context.sh would bail for the wrong reason -- and bash with it, which makes the
// hook fail to spawn at all rather than fail its guard.
const which = (cmd) => execFileSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim();
const BASH = skip ? null : which('bash');
const NOJQ = skip ? null : (() => {
  const dir = scratch(os.tmpdir(), 'jq-policy-path-');
  for (const cmd of ['bash', 'git']) fs.symlinkSync(which(cmd), path.join(dir, cmd));
  return dir;
})();

function run(hook, { cwd, env = {}, withJq }) {
  const base = { ...process.env, HOOK_INPUT_LIB: LIB, ...env };
  if (!withJq) base.PATH = NOJQ;
  const r = spawnSync(BASH, [path.join(HOOKS, hook)], {
    cwd, env: base, input: '{}', encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Every hook here is a no-op on a missing jq: exit 0, nothing on stdout, and nothing on
// stderr either. The stderr assertion is the one that would have caught the old behaviour --
// `jq -n` with no guard exits 127 AND reports itself.
function assertSilent(r, name) {
  assert.strictEqual(r.status, 0, `${name}: expected exit 0, got ${r.status}`);
  assert.strictEqual(r.stdout.trim(), '', `${name}: expected no stdout, got ${r.stdout}`);
  assert.strictEqual(r.stderr.trim(), '', `${name}: expected no stderr, got ${r.stderr}`);
}

test('post-compact prints its reminder when jq is present', { skip }, () => {
  const r = run('executable_post-compact.sh', { cwd: os.tmpdir(), withJq: true });
  assert.strictEqual(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /Post-compact/);
});

test('post-compact is silent when jq is missing', { skip }, () => {
  assertSilent(run('executable_post-compact.sh', { cwd: os.tmpdir(), withJq: false }), 'post-compact');
});

// worktree-context only speaks from inside a LINKED worktree, so the jq-present half needs a
// real one -- in a plain checkout it is silent whether or not jq exists, and the pair would
// prove nothing.
const WT = skip ? null : (() => {
  const root = scratch(os.tmpdir(), 'jq-policy-repo-');
  const repo = path.join(root, 'repo');
  const g = (args, cwd) => execFileSync('git', args, {
    cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  fs.mkdirSync(repo);
  g(['init', '-q', '-b', 'main', '.'], repo);
  g(['config', 'user.email', 't@t'], repo);
  g(['config', 'user.name', 't'], repo);
  fs.writeFileSync(path.join(repo, 'a'), 'a\n');
  g(['add', 'a'], repo);
  g(['commit', '-qm', 'init'], repo);
  const wt = path.join(root, 'wt');
  g(['worktree', 'add', '-q', '-b', 'feature-branch', wt], repo);
  return wt;
})();

test('worktree-context names the branch when jq is present', { skip }, () => {
  const r = run('executable_worktree-context.sh', { cwd: WT, withJq: true });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(
    JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
    '[Worktree: feature-branch]',
  );
});

test('worktree-context is silent in that same worktree when jq is missing', { skip }, () => {
  assertSilent(run('executable_worktree-context.sh', { cwd: WT, withJq: false }), 'worktree-context');
});

// voice-reminder speaks only under the daniel-voice output style, which it reads from a
// settings file. The project-level file has the highest precedence, so pointing
// CLAUDE_PROJECT_DIR at one decides the answer whatever the host's own config says.
const VOICE = skip ? null : (() => {
  const dir = scratch(os.tmpdir(), 'jq-policy-voice-');
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({ outputStyle: 'daniel-voice' }),
  );
  return dir;
})();

test('voice-reminder re-asserts the style when jq is present', { skip }, () => {
  const r = run('executable_voice-reminder.sh', {
    cwd: os.tmpdir(), withJq: true, env: { CLAUDE_PROJECT_DIR: VOICE, HOME: VOICE },
  });
  assert.strictEqual(r.status, 0);
  assert.match(
    JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
    /daniel-voice is active/,
  );
});

test('voice-reminder is silent under that same style when jq is missing', { skip }, () => {
  assertSilent(run('executable_voice-reminder.sh', {
    cwd: os.tmpdir(), withJq: false, env: { CLAUDE_PROJECT_DIR: VOICE, HOME: VOICE },
  }), 'voice-reminder');
});

// The policy is only shared if the hooks actually reach the shared expression of it. A hook
// that grew its own `command -v jq` back would pass every pair above.
test('all three take their jq policy from hook_require_jq', { skip }, () => {
  for (const hook of [
    'executable_post-compact.sh',
    'executable_worktree-context.sh',
    'executable_voice-reminder.sh',
  ]) {
    const src = fs.readFileSync(path.join(HOOKS, hook), 'utf8');
    assert.match(src, /hook_require_jq noop \|\| exit 0/, `${hook} does not call hook_require_jq`);
  }
});
