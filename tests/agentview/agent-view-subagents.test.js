// executable_agent-view-subagents.sh + the completed-write it gates in
// executable_agent-view-state.sh.
//
// An async subagent outlives the turn that launched it: the parent's turn ends, Stop fires,
// and the row read "completed" while agents were still running. SubagentStart/SubagentStop
// both carry the PARENT session_id, so the outstanding set is keyed by the same id the
// registry row uses. Drives the ACTUAL hooks with a temp $HOME. Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS_SRC = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const STATE_HOOK = path.join(HOOKS_SRC, 'executable_agent-view-state.sh');
const SUB_HOOK = path.join(HOOKS_SRC, 'executable_agent-view-subagents.sh');
const HELPER = path.join(HOOKS_SRC, 'executable_agent-view-register.sh');
const INPUT_LIB = path.join(HOOKS_SRC, 'hook-input.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

const homes = [];
function freshHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sub-'));
  homes.push(h);
  const hooks = path.join(h, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.copyFileSync(HELPER, path.join(hooks, 'agent-view-register.sh'));
  fs.copyFileSync(INPUT_LIB, path.join(hooks, 'hook-input.sh'));
  // The stop path re-runs the state hook (rather than writing the row itself) so the
  // dirty-tree downgrade still happens, so the deployed sibling has to be here too.
  fs.copyFileSync(STATE_HOOK, path.join(hooks, 'agent-view-state.sh'));
  fs.chmodSync(path.join(hooks, 'agent-view-state.sh'), 0o755);
  return h;
}

function runHook(hook, arg, input, home) {
  const env = { ...process.env, HOME: home, WEZTERM_PANE: '1' };
  delete env.TMUX;
  delete env.CLAUDE_PID;
  return execFileSync('bash', [hook, arg], {
    input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env,
  });
}
const state = (h, sid) => runHook(STATE_HOOK, sid.state, sid.input, h);
const subagent = (h, action, sid, agentId) =>
  runHook(SUB_HOOK, action, { session_id: sid, agent_id: agentId }, h);
const readRow = (h, sid) =>
  JSON.parse(fs.readFileSync(path.join(h, '.claude', 'agent-view', `${sid}.json`), 'utf8'));
const setFile = (h, sid) => path.join(h, '.claude', 'agent-view-subagents', sid);

// cwd is a temp dir with no git repo, so git_review_marker never downgrades to "review"
// and the assertions below are about the subagent gate alone.
const noRepo = os.tmpdir();

test('a stop with a subagent outstanding records working, not completed', { skip }, () => {
  const home = freshHome();
  state(home, { state: 'working', input: { session_id: 's1', cwd: noRepo } });
  subagent(home, 'start', 's1', 'agent-a');
  state(home, { state: 'completed', input: { session_id: 's1', cwd: noRepo } });
  assert.strictEqual(readRow(home, 's1').state, 'working',
    'the turn ended but the session is still waiting on a subagent');
});

test('the row is stamped completed once the last subagent lands', { skip }, () => {
  const home = freshHome();
  state(home, { state: 'working', input: { session_id: 's2', cwd: noRepo } });
  subagent(home, 'start', 's2', 'agent-a');
  subagent(home, 'start', 's2', 'agent-b');
  state(home, { state: 'completed', input: { session_id: 's2', cwd: noRepo } });

  subagent(home, 'stop', 's2', 'agent-a');
  assert.strictEqual(readRow(home, 's2').state, 'working', 'one subagent is still outstanding');

  subagent(home, 'stop', 's2', 'agent-b');
  assert.strictEqual(readRow(home, 's2').state, 'completed', 'the last one landed');
  assert.ok(!fs.existsSync(setFile(home, 's2')), 'the empty set file is removed, not left behind');
});

test('with no subagents tracked a stop still writes completed', { skip }, () => {
  const home = freshHome();
  state(home, { state: 'completed', input: { session_id: 's3', cwd: noRepo } });
  assert.strictEqual(readRow(home, 's3').state, 'completed',
    'the gate is fail-safe: an absent set file behaves exactly as before');
});

test('a duplicate start does not double-count the same agent', { skip }, () => {
  const home = freshHome();
  state(home, { state: 'working', input: { session_id: 's4', cwd: noRepo } });
  subagent(home, 'start', 's4', 'agent-a');
  subagent(home, 'start', 's4', 'agent-a');
  state(home, { state: 'completed', input: { session_id: 's4', cwd: noRepo } });
  subagent(home, 'stop', 's4', 'agent-a');
  assert.strictEqual(readRow(home, 's4').state, 'completed',
    'one stop clears one agent, however many starts it sent');
});

// A start whose stop never arrives (kill -9) would otherwise pin the row to working forever.
test('an expired start does not hold the row on working', { skip }, () => {
  const home = freshHome();
  state(home, { state: 'working', input: { session_id: 's5', cwd: noRepo } });
  const dir = path.join(home, '.claude', 'agent-view-subagents');
  fs.mkdirSync(dir, { recursive: true });
  const old = Math.floor(Date.now() / 1000) - 22000; // > the 6h MAX_AGE
  fs.writeFileSync(path.join(dir, 's5'), `${old} ghost-agent\n`);

  // The set file is non-empty, so the state hook holds at working...
  state(home, { state: 'completed', input: { session_id: 's5', cwd: noRepo } });
  assert.strictEqual(readRow(home, 's5').state, 'working');

  // ...but the next subagent event prunes the expired entry and releases the row.
  subagent(home, 'start', 's5', 'agent-a');
  subagent(home, 'stop', 's5', 'agent-a');
  assert.strictEqual(readRow(home, 's5').state, 'completed',
    'the ghost entry aged out instead of pinning the row');
});

test('ending the session clears its outstanding set', { skip }, () => {
  const home = freshHome();
  state(home, { state: 'working', input: { session_id: 's6', cwd: noRepo } });
  subagent(home, 'start', 's6', 'agent-a');
  assert.ok(fs.existsSync(setFile(home, 's6')));
  state(home, { state: 'end', input: { session_id: 's6', cwd: noRepo } });
  assert.ok(!fs.existsSync(setFile(home, 's6')), 'the set cannot outlive the row it keys');
});

// The whole point of routing the final stamp back through the state hook: git_review_marker
// only runs on that hook's completed path, so a state-only write would land a dirty tree in
// COMPLETED when REVIEW is exactly the group it belongs in.
test('a dirty tree still lands in review when the last subagent finishes', { skip }, () => {
  const home = freshHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'av-repo-'));
  homes.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted\n');

  state(home, { state: 'working', input: { session_id: 's8', cwd: repo } });
  subagent(home, 'start', 's8', 'agent-a');
  state(home, { state: 'completed', input: { session_id: 's8', cwd: repo } });
  assert.strictEqual(readRow(home, 's8').state, 'working');

  subagent(home, 'stop', 's8', 'agent-a');
  const row = readRow(home, 's8');
  assert.strictEqual(row.state, 'review', 'an uncommitted tree is not "completed"');
  assert.match(row.git, /dirty/, 'the review marker is stamped, not left empty');
});

test('a payload with no agent_id is ignored rather than tracked', { skip }, () => {
  const home = freshHome();
  state(home, { state: 'working', input: { session_id: 's7', cwd: noRepo } });
  runHook(SUB_HOOK, 'start', { session_id: 's7' }, home);
  state(home, { state: 'completed', input: { session_id: 's7', cwd: noRepo } });
  assert.strictEqual(readRow(home, 's7').state, 'completed');
});

process.on('exit', () => {
  for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* temp */ } }
});
