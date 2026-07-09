const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_link-artifact.sh');

// Runs the hook with a Write payload for `filePath`; returns the emitted
// additionalContext string ('' when the hook no-ops / exits without output).
function run(filePath, env = {}) {
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
  const e = { ...process.env };
  // Start from a clean slate for the two vars the hook keys off of.
  delete e.CLAUDE_ARTIFACTS_HOST_DIR;
  delete e.CLAUDE_STATE_HOST_DIR;
  Object.assign(e, env);
  const r = spawnSync('bash', [HOOK], { input, env: e, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  if (!out) return '';
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

// 1. container /artifacts -> translated via CLAUDE_ARTIFACTS_HOST_DIR
{
  const ctx = run('/artifacts/plan.html', { CLAUDE_ARTIFACTS_HOST_DIR: '/Users/d/.claude/sandbox/artifacts/repo-abc' });
  assert.ok(ctx.includes('file:///Users/d/.claude/sandbox/artifacts/repo-abc/plan.html'),
    `translates /artifacts to host bind-mount source; got: ${ctx}`);
}

// 2. container ~/.claude/artifacts -> translated via CLAUDE_STATE_HOST_DIR (the bug fix)
{
  const ctx = run('/home/claudebot/.claude/artifacts/proc-review.html',
    { CLAUDE_STATE_HOST_DIR: '/Users/d/.claude/sandbox/state' });
  assert.ok(ctx.includes('file:///Users/d/.claude/sandbox/state/artifacts/proc-review.html'),
    `translates container-home artifact to host state dir; got: ${ctx}`);
  assert.ok(!ctx.includes('/home/claudebot'), 'never leaks the in-container /home path');
}

// 3. host ~/.claude/artifacts, no sandbox env -> emitted verbatim
{
  const ctx = run('/Users/d/.claude/artifacts/local.html');
  assert.ok(ctx.includes('file:///Users/d/.claude/artifacts/local.html'),
    `host path emitted verbatim; got: ${ctx}`);
}

// 4. non-openable extension -> no-op
assert.strictEqual(run('/artifacts/data.json', { CLAUDE_ARTIFACTS_HOST_DIR: '/Users/d/x' }), '',
  'non-openable extension is a no-op');

// 5. write outside any artifacts dir -> no-op
assert.strictEqual(run('/workspace/src/index.html'), '', 'non-artifact write is a no-op');

console.log('ALL PASS');
