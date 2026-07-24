// Regression guard for executable_statusline-command.sh (the per-turn status line).
// Feeds fixture stdin JSON through the ACTUAL script and asserts the rendered segments.
// Offline. Skips cleanly if bash/jq are unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'private_dot_claude', 'executable_statusline-command.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function run(input) {
  const r = spawnSync('bash', [SCRIPT], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('full fixture renders cwd, model, and cost/usage segments', { skip }, () => {
  const fixture = {
    workspace: { current_dir: '/tmp/fixture-project/alpha/beta/gamma' },
    model: { id: 'claude-sonnet-4-6-20250514', display_name: 'Claude Sonnet 4.6' },
    context_window: { used_percentage: 42 },
    session_name: 'my-session',
    vim: { mode: 'NORMAL' },
    worktree: { name: 'feature-branch' },
    effort: { level: 'high' },
    rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } },
    cost: { total_cost_usd: 1.23, total_lines_added: 10, total_lines_removed: 2, total_duration_ms: 65000 },
    transcript_path: '',
    session_id: '',
  };
  const { status, stdout, stderr } = run(fixture);
  assert.strictEqual(status, 0);
  assert.ok(!stderr.includes('jq:'), `no jq error text on stderr: ${stderr}`);
  assert.ok(stdout.includes('…/alpha/beta/gamma'), 'truncated cwd (last 3 segments) present');
  assert.ok(stdout.includes('sonnet4.6'), 'model id mapped to compact label');
  assert.ok(stdout.includes('my-session'), 'session name segment present');
  assert.ok(stdout.includes('NORMAL'), 'vim mode segment present');
  assert.ok(stdout.includes('feature-branch'), 'worktree name segment present');
  assert.ok(stdout.includes('high'), 'non-default effort level segment present');
  assert.ok(stdout.includes('ctx:42%'), 'context usage segment present');
  assert.ok(stdout.includes('5h:10%'), '5-hour rate limit segment present');
  assert.ok(stdout.includes('7d:20%'), '7-day rate limit segment present');
  assert.ok(stdout.includes('$1.23'), 'session cost segment present');
  assert.ok(stdout.includes('+10') && stdout.includes('-2'), 'lines-changed segment present');
  assert.ok(stdout.includes('1m'), 'session duration segment present');
});

test('minimal/missing-fields JSON does not crash and falls back sanely', { skip }, () => {
  const { status, stdout, stderr } = run({});
  assert.strictEqual(status, 0, `script should exit 0 even with no fields: ${stderr}`);
  assert.ok(!stderr.includes('jq:'), `no jq error text on stderr: ${stderr}`);
  assert.ok(stdout.includes('Claude'), 'falls back to the default model label "Claude"');
  // Segments gated on optional fields (ctx usage, cost, lines changed, duration) must be
  // omitted rather than crash when their inputs are absent.
  assert.ok(!stdout.includes('ctx:'), 'context usage segment omitted without context_window');
  assert.ok(!stdout.includes('$'), 'cost segment omitted without cost.total_cost_usd');
});

test('branch segment appears when cwd is inside a real git repo', { skip }, () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-git-'));
  try {
    execFileSync('git', ['-C', repoDir, 'init', '-q']);
    const branch = execFileSync('git', ['-C', repoDir, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

    const { status, stdout, stderr } = run({ workspace: { current_dir: repoDir }, model: { id: 'claude-opus-4-6' } });
    assert.strictEqual(status, 0, `script should exit 0 inside a git repo: ${stderr}`);
    assert.ok(stdout.includes(branch), `branch name "${branch}" surfaced in the status line`);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
