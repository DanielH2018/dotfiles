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
function run(state, input, { pane, home, pid } = {}) {
  home = home || freshHome();
  const env = { ...process.env, HOME: home };
  if (pane !== undefined) env.WEZTERM_PANE = pane; else delete env.WEZTERM_PANE;
  if (pid !== undefined) env.CLAUDE_PID = pid; else delete env.CLAUDE_PID;
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

// ---- title from the transcript's ai-title (matches the built-in Agent View) ----
test('names the row with the latest ai-title from the transcript', { skip }, () => {
  const home = freshHome();
  const tpath = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(tpath,
    '{"type":"user","message":{"content":"hi"}}\n' +
    '{"type":"ai-title","aiTitle":"Old title","sessionId":"s"}\n' +
    '{"type":"assistant","message":{}}\n' +
    '{"type":"ai-title","aiTitle":"Fix the parser race","sessionId":"s"}\n');
  run('working', { session_id: 'titled', cwd: '/tmp', transcript_path: tpath }, { pane: '1', home });
  assert.strictEqual(readState(home, 'titled').title, 'Fix the parser race', 'the latest ai-title wins');
});

test('no ai-title in the transcript -> empty title (picker falls back to age)', { skip }, () => {
  const home = freshHome();
  const tpath = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(tpath, '{"type":"user","message":{"content":"hello"}}\n');
  run('working', { session_id: 'untitled', cwd: '/tmp', transcript_path: tpath }, { pane: '1', home });
  assert.strictEqual(readState(home, 'untitled').title, '', 'no ai-title yields an empty title');
});

test('a missing/unreadable transcript_path is harmless (no title, no error)', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'notrans', cwd: '/tmp', transcript_path: '/no/such/file.jsonl' }, { pane: '1', home });
  assert.strictEqual(readState(home, 'notrans').title, '', 'a bad transcript path just leaves the title empty');
});

// ---- pid liveness handle (lets the picker prune leaked, killed sessions) ----
test('records CLAUDE_PID as the row pid', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'pidsess', cwd: '/tmp' }, { pane: '1', home, pid: '424242' });
  assert.strictEqual(String(readState(home, 'pidsess').pid), '424242');
});

test('carries the pid forward when a later event lacks CLAUDE_PID', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 'sid', cwd: '/tmp' }, { pane: '1', home, pid: '4242' }); // seed
  run('needs-input', { session_id: 'sid', cwd: '/tmp' }, { home });                      // no CLAUDE_PID
  assert.strictEqual(String(readState(home, 'sid').pid), '4242', 'pid persists across events');
});

process.on('exit', () => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }); });
