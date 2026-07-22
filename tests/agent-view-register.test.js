// Unit tests for executable_agent-view-register.sh — the shared Agent View registry
// write path (capture/write_full/update_state/guarded_remove). Sources the ACTUAL
// helper in a hermetic bash with a temp AGENT_VIEW_DIR. Real jq is used. Skips
// without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_agent-view-register.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'av-reg-')); dirs.push(d); return d; }

// Source the helper, then run `body`, with AGENT_VIEW_DIR pointed at a temp dir.
// Extra env (e.g. WEZTERM_PANE/TMUX) overrides the process env.
function sh(body, { dir, env = {} } = {}) {
  dir = dir || scratch();
  const full = { ...process.env, AGENT_VIEW_DIR: dir, ...env };
  // Ensure TMUX/WEZTERM_PANE are unset unless explicitly provided.
  if (!('TMUX' in env)) delete full.TMUX;
  if (!('WEZTERM_PANE' in env)) delete full.WEZTERM_PANE;
  const out = execFileSync('bash', ['-c', `source "${HELPER}"; ${body}`], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: full,
  });
  return { out, dir };
}
const readRow = (dir, key) => JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));

test('av_capture_locator: none: when no TMUX/WEZTERM_PANE', { skip }, () => {
  assert.strictEqual(sh('av_capture_locator').out, 'none:');
});

test('av_capture_locator: wezterm:<pane> from WEZTERM_PANE', { skip }, () => {
  assert.strictEqual(sh('av_capture_locator', { env: { WEZTERM_PANE: '42' } }).out, 'wezterm:42');
});

test('av_write_full writes a keyed row with all fields + derived backend', { skip }, () => {
  const { dir } = sh('av_write_full "repo-abc" "working" "C:\\\\p\\\\proj" "hostx" 1700000000 "sandbox" "proj · main" "wezterm:9" "9" "run-1"');
  const r = readRow(dir, 'repo-abc');
  assert.strictEqual(r.key, 'repo-abc');
  assert.strictEqual(r.state, 'working');
  assert.strictEqual(r.kind, 'sandbox');
  assert.strictEqual(r.title, 'proj · main');
  assert.strictEqual(r.locator, 'wezterm:9');
  assert.strictEqual(r.backend, 'wezterm');
  assert.strictEqual(r.pane, '9');
  assert.strictEqual(r.run, 'run-1');
  assert.strictEqual(r.host, 'hostx');
  assert.strictEqual(r.ts, 1700000000);
  assert.strictEqual(r.session, 'repo-abc'); // legacy-compat alias
});

test('av_write_full keeps a POSIX cwd intact (no MSYS mangling)', { skip }, () => {
  const { dir } = sh('av_write_full "k" "idle" "/home/ubuntu/proj" "h" 1 "host" "" "none:" "" ""');
  assert.strictEqual(readRow(dir, 'k').cwd, '/home/ubuntu/proj');
});

test('av_update_state changes only state+ts and preserves identity/locator', { skip }, () => {
  const dir = scratch();
  sh('av_write_full "k" "working" "/c/p" "h" 100 "sandbox" "t" "wezterm:5" "5" "run-9"', { dir });
  sh('av_update_state "k" "needs-input"', { dir });
  const r = readRow(dir, 'k');
  assert.strictEqual(r.state, 'needs-input');
  assert.strictEqual(r.locator, 'wezterm:5');
  assert.strictEqual(r.run, 'run-9');
  assert.strictEqual(r.kind, 'sandbox');
  assert.ok(r.ts >= 100, 'ts refreshed');
});

test('av_update_state never creates a missing row (resurrection guard)', { skip }, () => {
  const dir = scratch();
  sh('av_update_state "ghost" "working"', { dir });
  assert.ok(!fs.existsSync(path.join(dir, 'ghost.json')), 'must not create the file');
});

test('av_guarded_remove deletes when run matches', { skip }, () => {
  const dir = scratch();
  sh('av_write_full "k" "working" "/c/p" "h" 1 "sandbox" "" "none:" "" "run-1"', { dir });
  sh('av_guarded_remove "k" "run-1"', { dir });
  assert.ok(!fs.existsSync(path.join(dir, 'k.json')));
});

test('av_guarded_remove keeps a row a NEWER run owns (run mismatch)', { skip }, () => {
  const dir = scratch();
  sh('av_write_full "k" "working" "/c/p" "h" 1 "sandbox" "" "none:" "" "run-NEW"', { dir });
  sh('av_guarded_remove "k" "run-OLD"', { dir });
  assert.ok(fs.existsSync(path.join(dir, 'k.json')), 'stale launch must not delete a newer row');
});

test('av_guarded_remove with empty run deletes unconditionally (host hook)', { skip }, () => {
  const dir = scratch();
  sh('av_write_full "sid" "working" "/c/p" "h" 1 "host" "" "wezterm:3" "3" ""', { dir });
  sh('av_guarded_remove "sid"', { dir });
  assert.ok(!fs.existsSync(path.join(dir, 'sid.json')));
});

test('av_capture_locator: tmux:<socket>:<session>:<pane> from a tmux pane', { skip }, () => {
  const bin = scratch();
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
# stub: respond to \`tmux display -p '#{socket_path}\\t#{session_name}\\t#{pane_id}'\`
printf '%s\\t%s\\t%s' /tmp/tmux-1000/default airflow '%3'
`, { mode: 0o755 });
  const out = execFileSync('bash', ['-c', `source "${HELPER}"; av_capture_locator`], {
    encoding: 'utf8',
    env: { ...process.env, TMUX: 'fake', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.strictEqual(out, 'tmux:/tmp/tmux-1000/default:airflow:%3');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
