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

const HOOKS_SRC = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
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

test('a custom-title (from /rename) overrides the ai-title', { skip }, () => {
  const home = freshHome();
  const tpath = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(tpath,
    '{"type":"ai-title","aiTitle":"Auto summary","sessionId":"s"}\n' +
    '{"type":"custom-title","customTitle":"My Chosen Name","sessionId":"s"}\n');
  run('working', { session_id: 'ct', cwd: '/tmp', transcript_path: tpath }, { pane: '1', home });
  assert.strictEqual(readState(home, 'ct').title, 'My Chosen Name', 'a /rename custom-title wins over the auto ai-title');
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

// ---- review state: a stop with an uncommitted/unpushed tree is not "done" ----
// The Stop/task_complete hooks fire `completed` at every turn end; the hook downgrades that
// to `review` (and stamps a marker) when the repo is dirty or ahead of upstream, so the
// picker can group loose-end sessions apart. Needs real git.
let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }
const gitSkip = skip || (gitOk ? false : 'git unavailable');

const repos = [];
const GITENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
// Build a temp repo in one of four shapes: 'clean' (committed+pushed), 'dirty' (uncommitted
// change), 'unpushed' (a commit ahead of upstream), 'nonrepo' (a plain dir). Returns its cwd.
function makeRepo(shape) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'av-repo-'));
  repos.push(d);
  if (shape === 'nonrepo') return d;
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore', env: { ...process.env, ...GITENV } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'f'), '1\n');
  git('add', '.'); git('commit', '-qm', 'init');
  if (shape === 'dirty') { fs.writeFileSync(path.join(d, 'f'), '2\n'); return d; }
  // clean/unpushed both need an upstream to compare against.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'av-bare-'));
  repos.push(bare);
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore', env: { ...process.env, ...GITENV } });
  git('remote', 'add', 'origin', bare);
  git('push', '-q', '-u', 'origin', 'main');
  if (shape === 'unpushed') { fs.writeFileSync(path.join(d, 'f'), '3\n'); git('commit', '-qam', 'ahead'); }
  return d;
}

test('completed in a dirty repo downgrades to review with a ⚠ dirty marker', { skip: gitSkip }, () => {
  const home = freshHome();
  run('completed', { session_id: 'r1', cwd: makeRepo('dirty') }, { pane: '1', home });
  const s = readState(home, 'r1');
  assert.strictEqual(s.state, 'review', 'a dirty stop is review, not completed');
  assert.match(s.git, /dirty/, 'the git marker names the dirty tree');
});

test('completed with unpushed commits downgrades to review with an ↑N marker', { skip: gitSkip }, () => {
  const home = freshHome();
  run('completed', { session_id: 'r2', cwd: makeRepo('unpushed') }, { pane: '1', home });
  const s = readState(home, 'r2');
  assert.strictEqual(s.state, 'review', 'an unpushed stop is review');
  assert.match(s.git, /↑1/, 'the marker counts commits ahead of upstream');
});

test('completed in a clean, pushed repo stays completed (no marker)', { skip: gitSkip }, () => {
  const home = freshHome();
  run('completed', { session_id: 'r3', cwd: makeRepo('clean') }, { pane: '1', home });
  const s = readState(home, 'r3');
  assert.strictEqual(s.state, 'completed', 'a clean+pushed stop is genuinely done');
  assert.strictEqual(s.git, '', 'no marker on a clean tree');
});

test('completed outside any git repo stays completed', { skip: gitSkip }, () => {
  const home = freshHome();
  run('completed', { session_id: 'r4', cwd: makeRepo('nonrepo') }, { pane: '1', home });
  const s = readState(home, 'r4');
  assert.strictEqual(s.state, 'completed', 'a non-repo cwd has nothing to review');
  assert.strictEqual(s.git, '');
});

test('only completed is downgraded — a working turn in a dirty repo stays working', { skip: gitSkip }, () => {
  const home = freshHome();
  run('working', { session_id: 'r5', cwd: makeRepo('dirty') }, { pane: '1', home });
  const s = readState(home, 'r5');
  assert.strictEqual(s.state, 'working', 'an active turn is never review, dirty or not');
  assert.strictEqual(s.git, '', 'no marker stamped outside a completed stop');
});

// ---- the `start` state (SessionStart) ------------------------------------
// Every other event fires only after the user does something, so a session started or resumed
// and then left idle never wrote a row and was invisible to the picker. `start` closes that,
// but it runs BEFORE any activity has proven the session is interactive — so unlike the other
// states it treats an absent per-process registry file as "don't know" and declines to write.
function writeSessionRegistry(home, pid, entrypoint, kind) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid: Number(pid), entrypoint, kind }));
}

test('start registers an idle row for a real cli session', { skip }, () => {
  const home = freshHome();
  writeSessionRegistry(home, '4242', 'cli');
  run('start', { session_id: 's1', cwd: '/home/daniel/dev' }, { pane: '3', home, pid: '4242' });
  const s = readState(home, 's1');
  assert.strictEqual(s.state, 'idle', 'a session that has done nothing yet is idle, not working');
  assert.strictEqual(s.locator, 'wezterm:3', 'and its pane is captured at start like any other event');
});

test('start declines to register an sdk session', { skip }, () => {
  const home = freshHome();
  writeSessionRegistry(home, '4243', 'sdk-cli');
  run('start', { session_id: 's2', cwd: '/tmp' }, { pane: '3', home, pid: '4243' });
  assert.ok(!fs.existsSync(stateFile(home, 's2')), 'a headless `claude -p` run is not a picker row');
});

test('start declines when the per-process registry says nothing yet', { skip }, () => {
  const home = freshHome();
  run('start', { session_id: 's3', cwd: '/tmp' }, { pane: '3', home, pid: '9999' });
  assert.ok(!fs.existsSync(stateFile(home, 's3')),
    'unknown is not "interactive" — UserPromptSubmit registers it moments later if it is real');
});

// The daemon keeps a pool of PRE-WARMED sessions: claimed spare processes with a real session id
// that fire SessionStart and then wait for a background job. They have no job, no transcript, and
// `claude agents` never lists them — but registering one renders a nameless idle row the picker
// cannot get rid of, because CTRL+X only makes the daemon warm a replacement that lands right back
// here under a new id.
test('start declines to register a pre-warmed daemon session', { skip }, () => {
  const home = freshHome();
  writeSessionRegistry(home, '4244', 'cli', 'bg');
  run('start', { session_id: 's5', cwd: '/home/daniel/dev' }, { home, pid: '4244' });
  assert.ok(!fs.existsSync(stateFile(home, 's5')), 'a spare awaiting a job is not a picker row');
});

test('a bg session that is actually running still registers on its first event', { skip }, () => {
  const home = freshHome();
  writeSessionRegistry(home, '4245', 'cli', 'bg');
  run('working', { session_id: 's6', cwd: '/home/daniel/dev' }, { home, pid: '4245' });
  assert.strictEqual(readState(home, 's6').state, 'working',
    'only `start` is blind to bg — a dispatched job proves itself by prompting');
});

test('the other states still register without a per-process registry', { skip }, () => {
  const home = freshHome();
  run('working', { session_id: 's4', cwd: '/home/daniel/dev' }, { pane: '3', home, pid: '9999' });
  assert.strictEqual(readState(home, 's4').state, 'working',
    'the older-claude fallback is unchanged: only `start` is strict');
});

process.on('exit', () => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  for (const d of repos) fs.rmSync(d, { recursive: true, force: true });
});
