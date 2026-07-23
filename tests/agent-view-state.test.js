// Characterization + regression guard for executable_agent-view-state.sh (the
// Claude Code hook that records HOST session state for the agentview picker).
// Drives the ACTUAL hook with a temp $HOME so it's hermetic; the shared register
// helper is deployed into $HOME/.claude/hooks (mirroring chezmoi) so the hook's
// `source` resolves. Real jq is used. Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS_SRC = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks');
const HOOK = path.join(HOOKS_SRC, 'executable_agent-view-state.sh');
const HELPER = path.join(HOOKS_SRC, 'executable_agent-view-register.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const homes = [];
function freshHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'av-home-'));
  homes.push(h);
  // Deploy the sourced helper where the hook expects it (~/.claude/hooks/).
  const hooks = path.join(h, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.copyFileSync(HELPER, path.join(hooks, 'agent-view-register.sh'));
  return h;
}

// Run the hook: `state` arg, JSON stdin, optional WEZTERM_PANE. Returns {out, home}.
function run(state, input, { pane, home } = {}) {
  home = home || freshHome();
  const env = { ...process.env, HOME: home };
  if (pane !== undefined) env.WEZTERM_PANE = pane; else delete env.WEZTERM_PANE;
  delete env.TMUX; // force the wezterm/none backend, never the test host's tmux
  const out = execFileSync('bash', [HOOK, state], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env,
  });
  return { out, home };
}
const stateFile = (home, sid) => path.join(home, '.claude', 'agent-view', `${sid}.json`);
const readState = (home, sid) => JSON.parse(fs.readFileSync(stateFile(home, sid), 'utf8'));

test('writes <session_id>.json with fields + host kind + wezterm locator', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'abc123', cwd: 'C:/Users/daniel/My_Vault' }, { pane: '7', home });
  const s = readState(home, 'abc123');
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.pane, '7');
  assert.strictEqual(s.session, 'abc123');
  assert.strictEqual(s.cwd, 'C:/Users/daniel/My_Vault');
  assert.strictEqual(s.kind, 'host');
  assert.strictEqual(s.locator, 'wezterm:7');
  assert.strictEqual(s.backend, 'wezterm');
  assert.strictEqual(typeof s.host, 'string');
  assert.ok(Number.isInteger(s.ts) && s.ts > 0, 'ts is an epoch integer');
});

test('locator is none: when no WEZTERM_PANE/TMUX', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'noloc', cwd: '/tmp' }, { home });
  assert.strictEqual(readState(home, 'noloc').locator, 'none:');
});

test('preserves a POSIX-style cwd without MSYS path mangling', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'posix', cwd: '/home/ubuntu/project' }, { pane: '1', home });
  assert.strictEqual(readState(home, 'posix').cwd, '/home/ubuntu/project');
});

test('missing session_id falls back to nosession.json', { skip }, () => {
  const home = freshHome();
  run('working', { cwd: '/tmp' }, { pane: '1', home });
  assert.ok(fs.existsSync(stateFile(home, 'nosession')));
});

test('caches last-known pane + locator when WEZTERM_PANE is absent', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'sid', cwd: '/tmp' }, { pane: '9', home });     // seeds pane 9 / wezterm:9
  run('needs-input', { session_id: 'sid', cwd: '/tmp' }, { home });            // no pane this event
  const s = readState(home, 'sid');
  assert.strictEqual(s.pane, '9');
  assert.strictEqual(s.locator, 'wezterm:9', 'carries the last-known locator forward');
});

test('escapes Windows backslash cwd into valid JSON', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'winsid', cwd: 'C:\\Users\\daniel\\My_Vault' }, { pane: '2', home });
  assert.strictEqual(readState(home, 'winsid').cwd, 'C:\\Users\\daniel\\My_Vault');
});

test('`end` removes the session state file', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'gone', cwd: '/tmp' }, { pane: '1', home });
  assert.ok(fs.existsSync(stateFile(home, 'gone')));
  run('end', { session_id: 'gone' }, { home });
  assert.ok(!fs.existsSync(stateFile(home, 'gone')));
});

test('emits nothing on stdout (safe for UserPromptSubmit)', { skip }, () => {
  const home = freshHome();
  const { out } = run('working', { session_id: 'quiet', cwd: '/tmp' }, { pane: '1', home });
  assert.strictEqual(out, '');
});

// ---- session name from the transcript (no wezterm to correlate a pane title) --------
const jsonl = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

test('names the row from the transcript custom-title', { skip }, () => {
  const home = freshHome();
  const tp = path.join(home, 'ct.jsonl');
  fs.writeFileSync(tp, jsonl(
    { type: 'user', message: { content: 'hi' } },
    { type: 'agent-name', agentName: 'ignored when a custom-title exists' },
    { type: 'custom-title', customTitle: 'Cool Session' },
  ));
  run('working', { session_id: 'ct', cwd: '/tmp', transcript_path: tp }, { home });
  assert.strictEqual(readState(home, 'ct').title, 'Cool Session');
});

test('falls back to the agent name when there is no custom-title', { skip }, () => {
  const home = freshHome();
  const tp = path.join(home, 'an.jsonl');
  fs.writeFileSync(tp, jsonl({ type: 'agent-name', agentName: 'Some Agent' }));
  run('working', { session_id: 'an', cwd: '/tmp', transcript_path: tp }, { home });
  assert.strictEqual(readState(home, 'an').title, 'Some Agent');
});

test('reconstructs the transcript path from cwd+session_id when not passed', { skip }, () => {
  const home = freshHome();
  const proj = path.join(home, '.claude', 'projects', '-home-daniel'); // /home/daniel -> -home-daniel
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'rc.jsonl'), jsonl({ type: 'custom-title', customTitle: 'Reconstructed' }));
  run('working', { session_id: 'rc', cwd: '/home/daniel' }, { home }); // note: no transcript_path
  assert.strictEqual(readState(home, 'rc').title, 'Reconstructed');
});

test('does not overwrite an existing title (a CTRL+R rename survives events)', { skip }, () => {
  const home = freshHome();
  const tp = path.join(home, 'stick.jsonl');
  fs.writeFileSync(tp, jsonl({ type: 'custom-title', customTitle: 'First' }));
  run('working', { session_id: 'stick', cwd: '/tmp', transcript_path: tp }, { home });
  assert.strictEqual(readState(home, 'stick').title, 'First');
  fs.writeFileSync(tp, jsonl({ type: 'custom-title', customTitle: 'Second' })); // renamed in Claude
  run('needs-input', { session_id: 'stick', cwd: '/tmp', transcript_path: tp }, { home });
  assert.strictEqual(readState(home, 'stick').title, 'First', 'once set, the title sticks (rename-safe)');
});

process.on('exit', () => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
