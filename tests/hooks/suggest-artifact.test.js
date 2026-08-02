const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

// One source of truth for host + sandbox; the artifact dir is parameterized by
// ARTIFACT_DIR (container sets /artifacts; host defaults to $HOME/.claude/artifacts).
const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_suggest-artifact.sh');

function run({ home = '/home/tester', artifactDir } = {}) {
  const env = { ...process.env, HOME: home };
  if (artifactDir === undefined) delete env.ARTIFACT_DIR;
  else env.ARTIFACT_DIR = artifactDir;
  const r = spawnSync('bash', [HOOK], { input: '{"tool_name":"ExitPlanMode"}', env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  return JSON.parse(r.stdout).hookSpecificOutput;
}

test('emits a valid PostToolUse payload', () => {
  const h = run();
  assert.strictEqual(h.hookEventName, 'PostToolUse', 'emits PostToolUse');
  assert.match(h.additionalContext, /AUTO-ARTIFACT/, 'carries the artifact nudge');
});

test('host default: ARTIFACT_DIR unset -> $HOME/.claude/artifacts', () => {
  const h = run({ home: '/home/tester' });
  assert.ok(h.additionalContext.includes('/home/tester/.claude/artifacts/'),
    'defaults to $HOME/.claude/artifacts on host');
  assert.ok(!h.additionalContext.includes(' /artifacts/'),
    'does not leak the bare container path on host');
});

test('container: ARTIFACT_DIR=/artifacts overrides the default', () => {
  const h = run({ artifactDir: '/artifacts' });
  assert.ok(h.additionalContext.includes('/artifacts/ (create it if needed)'),
    'uses ARTIFACT_DIR (container bind-mount) when set');
  assert.ok(!h.additionalContext.includes('.claude/artifacts/'),
    'does not fall back to the host default when ARTIFACT_DIR is set');
});
