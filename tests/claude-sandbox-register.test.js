// Guards for the Agent View registration wired into executable_claude-sandbox.
// The launcher itself can't run hermetically (docker/git/openssl), so this pairs:
//  (1) STRUCTURAL asserts on the real script — the registration + cleanup wiring is
//      present, correctly gated (interactive-only), and ordered before `docker run`.
//  (2) BEHAVIORAL asserts — a harness that mirrors the launcher's registration block,
//      sourcing the ACTUAL shared helper, proving the title/cwd/run contract writes a
//      correct sandbox row (and that guarded_remove tears it down).
// If (1) and (2) drift apart the structural test catches it. Real jq is used.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'executable_claude-sandbox');
const HELPER = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_agent-view-register.sh');
const SRC = fs.readFileSync(SANDBOX, 'utf8');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

// ---- (1) structural wiring ------------------------------------------------
test('sources the shared register helper', () => {
  assert.match(SRC, /source "\$HOME\/\.claude\/hooks\/agent-view-register\.sh"/);
});

test('registration is gated to interactive Claude sessions (not exec/shell)', () => {
  assert.match(SRC, /"\$EXEC_MODE" != true && "\$SHELL_MODE" != true/);
});

test('registers a sandbox row keyed by INSTANCE_ID with the RUN_ID guard', () => {
  assert.match(SRC, /av_write_full "\$INSTANCE_ID" "working" "\$WORK_PATH"[\s\S]*"sandbox"[\s\S]*"\$RUN_ID"/);
});

test('registration is ordered before the interactive docker run', () => {
  const reg = SRC.indexOf('av_write_full "$INSTANCE_ID"');
  const runIdx = SRC.lastIndexOf('docker run "${DOCKER_ARGS[@]}" "$IMAGE_TAG" "${CLAUDE_ARGS[@]}"');
  assert.ok(reg > 0 && runIdx > 0 && reg < runIdx, 'registration must precede the final docker run');
});

test('cleanup deregisters via the RUN_ID-guarded remove (inside cleanup, no 2nd trap)', () => {
  assert.match(SRC, /av_guarded_remove "\$INSTANCE_ID" "\$RUN_ID"/);
  // Exactly one EXIT trap — a second would clobber cleanup() and leak resources.
  const traps = SRC.match(/trap cleanup EXIT/g) || [];
  assert.strictEqual(traps.length, 1, 'must keep the single existing cleanup EXIT trap');
});

// ---- (1b) Phase 2 wiring: in-container live state --------------------------
test('Phase 2: mounts the in-container state hook + shared helper read-only', () => {
  // Live ~/.claude/hooks path, not the ~/.claude-defaults staging area: hooks are
  // no longer copied into the writable state volume, they are :ro-mounted in place.
  assert.match(SRC, /agent-view-register\.sh:\/home\/claudebot\/\.claude\/hooks\/agent-view-register\.sh:ro/);
  assert.match(SRC, /agent-view-state-hook\.sh:\/home\/claudebot\/\.claude\/hooks\/agent-view-state-hook\.sh:ro/);
});

test('Phase 2: binds the registry RW + passes AGENT_VIEW_KEY, interactive-only', () => {
  assert.match(SRC, /-v "\$HOME\/\.claude\/agent-view:\/home\/claudebot\/\.claude\/agent-view"/);
  assert.match(SRC, /-e "AGENT_VIEW_KEY=\$INSTANCE_ID"/);
  // The RW mount + key live INSIDE the interactive registration block (after the row is
  // written) and before the final docker run, so exec/shell containers never get them.
  const gate = SRC.indexOf('AV_REGISTERED=true');
  const mount = SRC.indexOf('agent-view:/home/claudebot/.claude/agent-view');
  const runIdx = SRC.lastIndexOf('docker run "${DOCKER_ARGS[@]}" "$IMAGE_TAG" "${CLAUDE_ARGS[@]}"');
  assert.ok(gate > 0 && mount > gate && mount < runIdx,
    'RW registry mount + key must be added after register, before the interactive docker run');
});

// ---- (2) behavioral contract (mirrors the launcher block) -----------------
const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reg-')); dirs.push(d); return d; }

// Mirror of the launcher's registration block, verbatim in logic, over the real helper.
const REG_BLOCK = `
  source "${HELPER}"
  av_title="$REPO_NAME"
  if [[ -n "$WT_BRANCH" ]]; then av_title="$REPO_NAME · $WT_BRANCH"; fi
  av_title="$av_title (sandbox)"
  av_locator="$(av_capture_locator || true)"
  av_write_full "$INSTANCE_ID" "working" "$WORK_PATH" "hostx" 1700000000 \
    "sandbox" "$av_title" "$av_locator" "" "$RUN_ID" || true
`;
function register({ repo, branch, instance, run, work, dir, wezpane }) {
  const env = { ...process.env, AGENT_VIEW_DIR: dir,
    REPO_NAME: repo, WT_BRANCH: branch, INSTANCE_ID: instance, RUN_ID: run, WORK_PATH: work };
  delete env.TMUX;
  if (wezpane) env.WEZTERM_PANE = wezpane; else delete env.WEZTERM_PANE;
  execFileSync('bash', ['-euo', 'pipefail', '-c', REG_BLOCK], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}
const readRow = (dir, key) => JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));

test('writes a sandbox row with branch title, WORK_PATH cwd, RUN_ID + wezterm locator', { skip }, () => {
  const dir = scratch();
  register({ repo: 'airflow', branch: 'claude/foo', instance: 'airflow-abcd1234-foo',
    run: 'airflow-abcd1234-foo-deadbe', work: '/c/repos/airflow-wt-foo', dir, wezpane: '9' });
  const r = readRow(dir, 'airflow-abcd1234-foo');
  assert.strictEqual(r.kind, 'sandbox');
  assert.strictEqual(r.state, 'working');
  assert.strictEqual(r.title, 'airflow · claude/foo (sandbox)');
  assert.strictEqual(r.cwd, '/c/repos/airflow-wt-foo');
  assert.strictEqual(r.run, 'airflow-abcd1234-foo-deadbe');
  assert.strictEqual(r.locator, 'wezterm:9');
  assert.strictEqual(r.backend, 'wezterm');
});

test('title omits the branch when WT_BRANCH is empty (main repo session)', { skip }, () => {
  const dir = scratch();
  register({ repo: 'airflow', branch: '', instance: 'airflow-abcd1234',
    run: 'airflow-abcd1234-beefee', work: '/c/repos/airflow', dir });
  assert.strictEqual(readRow(dir, 'airflow-abcd1234').title, 'airflow (sandbox)');
});

test('the RUN_ID-guarded remove tears down exactly the launched row', { skip }, () => {
  const dir = scratch();
  register({ repo: 'r', branch: '', instance: 'r-1', run: 'r-1-aaa', work: '/c/r', dir });
  // A stale exit (different run) must NOT delete it; the real run's exit must.
  execFileSync('bash', ['-c', `source "${HELPER}"; av_guarded_remove "r-1" "r-1-OTHER"`], { env: { ...process.env, AGENT_VIEW_DIR: dir } });
  assert.ok(fs.existsSync(path.join(dir, 'r-1.json')), 'stale run must not delete the row');
  execFileSync('bash', ['-c', `source "${HELPER}"; av_guarded_remove "r-1" "r-1-aaa"`], { env: { ...process.env, AGENT_VIEW_DIR: dir } });
  assert.ok(!fs.existsSync(path.join(dir, 'r-1.json')), 'the launched run removes its own row');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
