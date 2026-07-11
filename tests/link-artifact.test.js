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

// 6. symlink resolution is gated to in-container (mirrors ~/.claude/artifacts -> /artifacts).
//    A symlinked ~/.claude/artifacts dir: on the host (env unset) the path is emitted
//    verbatim; in-container (CLAUDE_STATE_HOST_DIR set) readlink -f collapses it to the
//    real target first, so it no longer matches an artifacts branch here (in a real
//    container it would resolve to /artifacts and hit case 1's translation).
// Creating a symlink needs privilege on Windows (EPERM), so this Unix-host case is skipped there.
if (process.platform !== 'win32') {
  const fs = require('node:fs');
  const os = require('node:os');
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'la-real-'));
  fs.writeFileSync(path.join(real, 'report.html'), '<html>');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'la-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(real, path.join(home, '.claude', 'artifacts')); // ~/.claude/artifacts -> real
  const linked = path.join(home, '.claude', 'artifacts', 'report.html');

  assert.ok(run(linked).includes(`file://${linked}`),
    'host mode emits the ~/.claude/artifacts path verbatim (no resolution)');
  assert.strictEqual(run(linked, { CLAUDE_STATE_HOST_DIR: '/Users/d/.claude/sandbox/state' }), '',
    'container mode resolves the symlink before matching');

  fs.rmSync(real, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('ALL PASS');
