// Behavioral + structural tests for the in-container Agent View state hook
// (executable_agent-view-state-hook.sh, Phase 2). It sources the shared register helper
// and does an update-if-exists-only state flip keyed by AGENT_VIEW_KEY. It must NEVER
// create or delete a row — the HOST launcher owns identity + lifecycle (resurrection
// guard). Real bash+jq against the ACTUAL helper; skips without them.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX_DIR = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox');
const HOOK = path.join(SANDBOX_DIR, 'executable_agent-view-state-hook.sh');
const HELPER = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks', 'executable_agent-view-register.sh');
const SRC = fs.readFileSync(HOOK, 'utf8');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// A fake in-container HOME: the real helper copied to ~/.claude/hooks/ (mirrors how
// entrypoint.sh syncs it), plus the registry dir the RW bind mount exposes.
function fakeEnv() {
  const home = scratch('av-hook-home-');
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.copyFileSync(HELPER, path.join(hooks, 'agent-view-register.sh'));
  const reg = path.join(home, '.claude', 'agent-view');
  fs.mkdirSync(reg, { recursive: true });
  return { home, reg };
}
function runHook(state, { home, reg, key, input = '{"session_id":"x"}' }) {
  const env = { ...process.env, HOME: home, AGENT_VIEW_DIR: reg };
  if (key !== undefined) env.AGENT_VIEW_KEY = key; else delete env.AGENT_VIEW_KEY;
  delete env.TMUX; delete env.WEZTERM_PANE;
  // Send a realistic payload by default. The hook takes its state from argv, but Claude
  // writes the event JSON to its stdin regardless, so a test that sends nothing stops
  // modelling the real call. Passing '' here did silence the `spawnSync bash EPIPE`
  // flake, but only by removing the write that lost the race -- the deployed hook still
  // raced Claude's. The fix is in the hook, which now drains stdin before it exits.
  return execFileSync('bash', [HOOK, state], {
    env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function writeRow(reg, key, state) {
  execFileSync('bash', ['-c',
    `source "${HELPER}"; av_write_full "${key}" "${state}" "/c/p" "h" 100 "sandbox" "t" "wezterm:5" "5" "run-9"`],
    { env: { ...process.env, AGENT_VIEW_DIR: reg } });
}
const readRow = (reg, key) => JSON.parse(fs.readFileSync(path.join(reg, `${key}.json`), 'utf8'));

// ---- structural: update-only, keyed by AGENT_VIEW_KEY, no create/delete ----
test('sources the shared helper and calls av_update_state, keyed by AGENT_VIEW_KEY', () => {
  assert.match(SRC, /agent-view-register\.sh/);
  assert.match(SRC, /AGENT_VIEW_KEY/);
  assert.match(SRC, /av_update_state "\$key"/);
});
test('never creates or deletes a row (launcher owns lifecycle)', () => {
  assert.doesNotMatch(SRC, /av_write_full/, 'must not write a full record');
  assert.doesNotMatch(SRC, /av_guarded_remove|rm -f/, 'must not delete a row');
});

// ---- behavioral ----
test('flips an existing row’s state, preserving launcher-owned fields', { skip }, () => {
  const { home, reg } = fakeEnv();
  writeRow(reg, 'airflow-x', 'working');
  runHook('needs-input', { home, reg, key: 'airflow-x' });
  const r = readRow(reg, 'airflow-x');
  assert.strictEqual(r.state, 'needs-input');
  assert.strictEqual(r.kind, 'sandbox');
  assert.strictEqual(r.locator, 'wezterm:5');
  assert.strictEqual(r.run, 'run-9');
});
test('no AGENT_VIEW_KEY -> no-op (exec/shell container, key never set)', { skip }, () => {
  const { home, reg } = fakeEnv();
  writeRow(reg, 'k', 'working');
  runHook('completed', { home, reg });                 // key undefined
  assert.strictEqual(readRow(reg, 'k').state, 'working', 'must not touch any row');
});
// Regression: the hook must consume the event JSON Claude writes to its stdin. Exiting
// without draining leaves the caller's write racing a pipe the hook already closed, which
// showed up here as an intermittent `spawnSync bash EPIPE` (~4% of runs, worst on the
// no-key path -- the earliest exit). A payload past the 64KiB pipe buffer can't be absorbed
// by an undraining child at all, so it turns that race into a certainty: without the drain
// this fails every time, not one run in twenty-five.
test('drains stdin, so the caller never races a closed pipe', { skip }, () => {
  const { home, reg } = fakeEnv();
  const big = JSON.stringify({ session_id: 'x', pad: 'p'.repeat(256 * 1024) });
  assert.doesNotThrow(() => runHook('completed', { home, reg, input: big }));
});
test('missing row -> never created (resurrection guard)', { skip }, () => {
  const { home, reg } = fakeEnv();
  runHook('completed', { home, reg, key: 'ghost' });
  assert.ok(!fs.existsSync(path.join(reg, 'ghost.json')), 'must not create the row');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
