const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const dirs = [];

const HOOK = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_link-artifact.sh');

// A host-mode artifact link is platform-dependent: a Linux host (VS Code Remote / WSL,
// where file:// can't reach the client) gets http://127.0.0.1:PORT/<rel> served by
// serve-artifacts.sh; macOS gets file://<abs>. Mirror the hook's `uname` split.
// The literal 127.0.0.1 is load-bearing — see the hook for why `localhost` hangs on
// the Windows side of WSL.
const PORT = process.env.CLAUDE_ARTIFACTS_PORT || '8181';
const hostLink = (absPath, rel) =>
  process.platform === 'linux' ? `http://127.0.0.1:${PORT}/${rel}` : `file://${absPath}`;

// The hook registers every .html it links as the repo's tracked artifact. Without an
// override that lands in the real ~/.claude/logs/artifact-state, so a test run would
// point the live registry at a /tmp fixture that is deleted moments later — and
// clobber a genuine entry for whichever repo the suite ran in.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'la-state-'));
dirs.push(STATE_DIR);

// Runs the hook with a Write payload for `filePath`; returns the emitted
// additionalContext string ('' when the hook no-ops / exits without output).
function run(filePath, env = {}) {
  const input = JSON.stringify({ tool_input: { file_path: filePath } });
  const e = { ...process.env };
  // Start from a clean slate for every var the hook keys off of. CLAUDE_ARTIFACTS_BASE_URL
  // matters most: it is SET in the environment on daniel-box and daniel-server, so leaving it
  // through would make the loopback and file:// cases below assert against the cluster URL on
  // exactly the machines this suite usually runs on.
  delete e.CLAUDE_ARTIFACTS_HOST_DIR;
  delete e.CLAUDE_STATE_HOST_DIR;
  delete e.CLAUDE_ARTIFACTS_BASE_URL;
  delete e.CLAUDE_ARTIFACTS_HOST;
  e.CLAUDE_ARTIFACT_STATE_DIR = STATE_DIR;
  Object.assign(e, env);
  const r = spawnSync('bash', [HOOK], { input, env: e, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  const out = (r.stdout || '').trim();
  if (!out) return '';
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

test('container /artifacts -> translated via CLAUDE_ARTIFACTS_HOST_DIR', () => {
  const ctx = run('/artifacts/plan.html', { CLAUDE_ARTIFACTS_HOST_DIR: '/Users/d/.claude/sandbox/artifacts/repo-abc' });
  assert.ok(ctx.includes('file:///Users/d/.claude/sandbox/artifacts/repo-abc/plan.html'),
    `translates /artifacts to host bind-mount source; got: ${ctx}`);
});

test('container ~/.claude/artifacts -> translated via CLAUDE_STATE_HOST_DIR (the bug fix)', () => {
  const ctx = run('/home/claudebot/.claude/artifacts/proc-review.html',
    { CLAUDE_STATE_HOST_DIR: '/Users/d/.claude/sandbox/state' });
  assert.ok(ctx.includes('file:///Users/d/.claude/sandbox/state/artifacts/proc-review.html'),
    `translates container-home artifact to host state dir; got: ${ctx}`);
  assert.ok(!ctx.includes('/home/claudebot'), 'never leaks the in-container /home path');
});

test('host ~/.claude/artifacts, no sandbox env -> the platform\'s clickable link', () => {
  const ctx = run('/Users/d/.claude/artifacts/local.html');
  assert.ok(ctx.includes(hostLink('/Users/d/.claude/artifacts/local.html', 'local.html')),
    `host path emitted as the platform's clickable link; got: ${ctx}`);
  if (process.platform === 'linux') {
    // Both modifiers, or the instruction is unfollowable: Shift bypasses the TUI's mouse
    // capture, Ctrl is Ghostty's open-link modifier on Linux. Shift alone does nothing.
    assert.match(ctx, /Shift\+Ctrl\+click/,
      `linux message names the full Shift+Ctrl+click gesture; got: ${ctx}`);
  }
});

// ── the homelab cluster URL (CLAUDE_ARTIFACTS_BASE_URL) ────────────────────────────────
// On daniel-box / daniel-server the artifacts trees are also served in-cluster behind
// Authelia (server repo, roles/k8s/artifacts), so the link is a real hostname instead of a
// loopback port only that host's own terminal can reach. Every machine WITHOUT the var must
// keep the file:// and 127.0.0.1 behaviour the tests above pin.
const BASE = 'https://artifacts.local.example.com';

test('base URL set -> host-scoped cluster link', () => {
  const ctx = run('/home/ubuntu/.claude/artifacts/plan.html',
    { CLAUDE_ARTIFACTS_BASE_URL: BASE, CLAUDE_ARTIFACTS_HOST: 'daniel-box' });
  assert.ok(ctx.includes(`${BASE}/a/daniel-box/plan.html`),
    `emits the cluster URL under the writing host; got: ${ctx}`);
  assert.ok(!ctx.includes('127.0.0.1'), 'the loopback link is replaced, not appended');
});

test('base URL host segment defaults to the short hostname', () => {
  const expected = require('node:os').hostname().split('.')[0];
  const ctx = run('/home/ubuntu/.claude/artifacts/plan.html', { CLAUDE_ARTIFACTS_BASE_URL: BASE });
  assert.ok(ctx.includes(`${BASE}/a/${expected}/plan.html`),
    `falls back to hostname -s, which is the name the peer-sync directory uses; got: ${ctx}`);
});

test('base URL with a trailing slash does not double it', () => {
  const ctx = run('/home/ubuntu/.claude/artifacts/plan.html',
    { CLAUDE_ARTIFACTS_BASE_URL: `${BASE}/`, CLAUDE_ARTIFACTS_HOST: 'daniel-box' });
  assert.ok(ctx.includes(`${BASE}/a/daniel-box/plan.html`), `strips the trailing slash; got: ${ctx}`);
});

test('base URL preserves a nested relative path', () => {
  const ctx = run('/home/ubuntu/.claude/artifacts/2026/plan.html',
    { CLAUDE_ARTIFACTS_BASE_URL: BASE, CLAUDE_ARTIFACTS_HOST: 'daniel-box' });
  assert.ok(ctx.includes(`${BASE}/a/daniel-box/2026/plan.html`),
    `keeps the path below the artifacts root; got: ${ctx}`);
});

test('base URL is ignored in the sandbox, which has no route to the cluster', () => {
  const ctx = run('/home/claudebot/.claude/artifacts/plan.html',
    { CLAUDE_ARTIFACTS_BASE_URL: BASE, CLAUDE_STATE_HOST_DIR: '/Users/d/.claude/sandbox/state' });
  assert.ok(!ctx.includes(BASE), `container mode keeps its host translation; got: ${ctx}`);
  assert.ok(ctx.includes('file:///Users/d/.claude/sandbox/state/artifacts/plan.html'), ctx);
});

test('base URL does not suppress the missing-HTML-companion nudge', () => {
  const dir = artifactsDir(['findings.md']);
  const ctx = run(path.join(dir, 'findings.md'), { CLAUDE_ARTIFACTS_BASE_URL: BASE });
  assert.match(ctx, /AUTO-ARTIFACT/, `still nudges for the HTML companion; got: ${ctx}`);
});

test('non-openable extension -> no-op', () => {
  assert.strictEqual(run('/artifacts/data.json', { CLAUDE_ARTIFACTS_HOST_DIR: '/Users/d/x' }), '',
    'non-openable extension is a no-op');
});

test('write outside any artifacts dir -> no-op', () => {
  assert.strictEqual(run('/workspace/src/index.html'), '', 'non-artifact write is a no-op');
});

// symlink resolution is gated to in-container (mirrors ~/.claude/artifacts -> /artifacts).
//    A symlinked ~/.claude/artifacts dir: on the host (env unset) the path is emitted
//    verbatim; in-container (CLAUDE_STATE_HOST_DIR set) readlink -f collapses it to the
//    real target first, so it no longer matches an artifacts branch here (in a real
//    container it would resolve to /artifacts and hit case 1's translation).
// Creating a symlink needs privilege on Windows (EPERM), so this Unix-host case is skipped there.
test('symlink resolution gated to in-container', () => {
  if (process.platform !== 'win32') {
    const fs = require('node:fs');
    const os = require('node:os');
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'la-real-'));
    dirs.push(real);
    fs.writeFileSync(path.join(real, 'report.html'), '<html>');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'la-home-'));
    dirs.push(home);
    fs.mkdirSync(path.join(home, '.claude'));
    fs.symlinkSync(real, path.join(home, '.claude', 'artifacts')); // ~/.claude/artifacts -> real
    const linked = path.join(home, '.claude', 'artifacts', 'report.html');

    assert.ok(run(linked).includes(hostLink(linked, 'report.html')),
      'host mode emits the platform link for the ~/.claude/artifacts path (no resolution)');
    assert.strictEqual(run(linked, { CLAUDE_STATE_HOST_DIR: '/Users/d/.claude/sandbox/state' }), '',
      'container mode resolves the symlink before matching');
  }
});

// A Markdown artifact with no HTML companion gets an extra nudge appended after the
// link. suggest-artifact.sh was meant to cover this but is gated on ExitPlanMode, which
// is never called here, so this hook is the only trigger that actually fires.
// Builds a real ~/.claude/artifacts dir because the hook stats the companion on disk.
function artifactsDir(files) {
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'la-nudge-'));
  dirs.push(home);
  const dir = path.join(home, '.claude', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

test('.md artifact with no .html companion -> nudge to render one', () => {
  const dir = artifactsDir(['findings.md']);
  const ctx = run(path.join(dir, 'findings.md'));
  assert.match(ctx, /AUTO-ARTIFACT/, `nudges when the companion is missing; got: ${ctx}`);
  assert.match(ctx, /artifact-design/, 'names the skill to load');
  assert.match(ctx, /not instead of it/, 'keeps the Markdown as well as the HTML');
  assert.match(ctx, /do not publish to claude\.ai/i, 'keeps the artifact local');
});

test('.md artifact that already has its .html companion -> no nudge', () => {
  const dir = artifactsDir(['plan.md', 'plan.html']);
  const ctx = run(path.join(dir, 'plan.md'));
  assert.ok(ctx.length > 0, 'still emits the link');
  assert.ok(!ctx.includes('AUTO-ARTIFACT'), `stays quiet once the companion exists; got: ${ctx}`);
});

test('.html artifact write -> no nudge', () => {
  const dir = artifactsDir(['review.html']);
  const ctx = run(path.join(dir, 'review.html'));
  assert.ok(ctx.length > 0, 'still emits the link');
  assert.ok(!ctx.includes('AUTO-ARTIFACT'), `nudge is Markdown-only; got: ${ctx}`);
});

// Guards the isolation above: if CLAUDE_ARTIFACT_STATE_DIR ever stops being set here,
// the suite starts writing into the developer's live registry and nothing else notices.
test('registration is confined to the test state dir', () => {
  const dir = artifactsDir(['reg.html']);
  run(path.join(dir, 'reg.html'));

  // Drop the override and the entry lands in the real registry instead, leaving this
  // empty — which is exactly the regression, verified by mutating the line away.
  const written = fs.readdirSync(STATE_DIR);
  assert.ok(written.some((f) => f.endsWith('.current')),
    `registration landed in the test state dir; got: ${JSON.stringify(written)}`);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
