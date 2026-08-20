// Regression guard for the Agent View picker hotkeys added on top of the fzf picker:
//   CTRL+P pin-to-top    -> `agentview --pin KEY`   (toggles a local sidecar)
//   CTRL+R rename        -> `agentview --rename KEY` (writes .title on the local file)
//   ALT+1..9 quick-jump  -> `agentview --jump-nth N` (focus the Nth rendered session)
// Drives the ACTUAL script with stub hostname/tmux/fzf on PATH and a temp $HOME, so it's
// hermetic — no real mux, no TTY. Real jq/coreutils. Skips without bash/jq.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentviewWinSeams } = require('../lib/agentview-env');

const VIEW = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_agentview');
// Footer hints moved into render.sh's AV_HINTS when the footer became width-aware: the
// picker now builds the line at startup instead of carrying it as a literal flag.
const RENDER = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview', 'render.sh');
const US = '\x1f';
const HOST = 'av-host'; // what the `hostname` stub reports (selfhost)

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

function findBash() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'bash'); if (fs.existsSync(p)) return p;
  }
  return 'bash';
}
const BASH = findBash();
const nowSec = () => Math.floor(Date.now() / 1000);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:]*m/g, '');
const cardKey = (fields) => fields.join(US); // host|cwd|state|ts|title|pane|kind|locator

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// Hermetic env: stub-bin (hostname/tmux/fzf) + a temp HOME with a state dir.
function makeEnv() {
  const bin = scratch('avh-bin-');
  const home = scratch('avh-home-');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const claudeLog = path.join(bin, 'claude.log'); fs.writeFileSync(claudeLog, '');
  const sshLog = path.join(bin, 'ssh.log'); fs.writeFileSync(sshLog, '');
  const killLog = path.join(bin, 'kill.log'); fs.writeFileSync(killLog, '');
  const tmuxBufLog = path.join(bin, 'tmux-buf.log'); fs.writeFileSync(tmuxBufLog, '');
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash\necho ${HOST}\n`, { mode: 0o755 });
  // load-buffer's payload lands in a temp file the sender deletes straight after, so the stub
  // copies it out — otherwise a paste-based send can only be asserted on its plumbing, never
  // on the text that actually reached the pane.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "$TMUX_LOG"
case " $* " in *" load-buffer "*) cat "\${@: -1}" >> "$TMUX_BUF_LOG" ;; esac
exit 0
`, { mode: 0o755 });
  // --body / --jump-nth run after the jq+fzf tool check, so fzf must exist (never invoked here).
  // Answers the Ctrl+X confirm chooser. An unset FZF_PICK is an empty pick — i.e. cancelled.
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash\n[ -n "\${FZF_PICK:-}" ] && printf '%s\\n' "$FZF_PICK"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash\necho "$*" >> "$CLAUDE_LOG"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash\necho "$*" >> "$SSH_LOG"\nexit 0\n`, { mode: 0o755 });
  // Injection seam for the guarded kill — logs the pid instead of signalling anything.
  const killStub = path.join(bin, 'killstub'); fs.writeFileSync(killStub, `#!/bin/bash\necho "$1" >> "$KILL_LOG"\nexit 0\n`, { mode: 0o755 });
  // Every refusal path in actions.sh dwells 1.5s so the message can be read before fzf
  // repaints over it. Nothing here runs fzf and nothing asserts the dwell, so that was 1.52s
  // of dead wait on each of the ~10 refusal tests — the file's whole 15.4s. actions.sh calls
  // sleep by bare name, so this shadows it the same way the ssh and claude stubs above do,
  // and the dwell stays exactly as it is in production.
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  // Real Windows sessions would render alongside the fixtures and shift the row numbering
  // the pin/jump assertions depend on. See tests/lib/agentview-env.js.
  const seams = agentviewWinSeams({ bin, scratch });
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    // Pin the ssh roster: a machine that exports AGENT_VIEW_REMOTE_HOSTS="" from its login
    // profile empties HOST_SSH through the spread above, so every remote assertion failed
    // there and passed everywhere else -- the same shape as the TMUX leak.
    AGENT_VIEW_REMOTE_HOSTS: 'daniel-server daniel-box',
    TMUX_LOG: tmuxLog, CLAUDE_LOG: claudeLog, SSH_LOG: sshLog, KILL_LOG: killLog, AV_KILLCMD: killStub,
    TMUX_BUF_LOG: tmuxBufLog,
    ...seams.env,
  };
  delete env.TMUX; // a bare shell -> tmux jump takes the attach path
  return { bin, home, env, tmuxLog, claudeLog, sshLog, killLog, tmuxBufLog };
}

function stateFile(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
// Seed a Claude-native per-process file (~/.claude/sessions/<pid>.json) mapping pid -> sid.
function sessionProc(home, pid, sid) {
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid }));
}
const avFile = (home, sid) => path.join(home, '.claude', 'agent-view', `${sid}.json`);
const pinFile = (home) => path.join(home, '.claude', 'agent-view-pins');
const foldFile = (home) => path.join(home, '.claude', 'agent-view-folds');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

function run(env, args, { input, extraEnv = {} } = {}) {
  try {
    return { out: execFileSync(BASH, [VIEW, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, ...extraEnv },
      input: input === undefined ? '' : input,
    }), code: 0 };
  } catch (e) { return { out: e.stdout || '', code: e.status, err: e.stderr || '' }; }
}

// A row as its KEY (host|cwd|state|ts|title|pane|kind|locator).
function rowKey({ host = HOST, cwd, state = 'working', ts = nowSec(), title = '', pane = '%1', kind = 'host', locator }) {
  return cardKey([host, cwd, state, String(ts), title, pane, kind, locator]);
}

// ---- --pin (CTRL+P: toggle a pin in the sidecar) ------------------------
test('--pin adds a row to the sidecar, and --pin again removes it', { skip }, () => {
  const { env, home } = makeEnv();
  const key = rowKey({ cwd: '/r/alpha', locator: 'tmux:/s:sa:%1' });
  assert.strictEqual(run(env, ['--pin', key]).code, 0);
  assert.strictEqual(fs.readFileSync(pinFile(home), 'utf8').trim(), 'tmux:/s:sa:%1', 'a real locator is the pin id');
  assert.strictEqual(run(env, ['--pin', key]).code, 0);
  assert.strictEqual(fs.readFileSync(pinFile(home), 'utf8').trim(), '', 'toggling the last pin empties the file');
});

test('--pin keeps other pins when removing one', { skip }, () => {
  const { env, home } = makeEnv();
  run(env, ['--pin', rowKey({ cwd: '/r/a', locator: 'tmux:/s:a:%1' })]);
  run(env, ['--pin', rowKey({ cwd: '/r/b', locator: 'tmux:/s:b:%2' })]);
  run(env, ['--pin', rowKey({ cwd: '/r/a', locator: 'tmux:/s:a:%1' })]); // unpin a
  const lines = fs.readFileSync(pinFile(home), 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(lines, ['tmux:/s:b:%2'], 'only the toggled pin is removed');
});

test('--pin of a locator-less (none:) row keys on host+cwd+kind', { skip }, () => {
  const { env, home } = makeEnv();
  run(env, ['--pin', rowKey({ cwd: '/r/none', kind: 'host', locator: 'none:' })]);
  assert.strictEqual(fs.readFileSync(pinFile(home), 'utf8').trim(), `${HOST}${US}/r/none${US}host`,
    'a none: locator falls back to the host|cwd|kind identity');
});

test('--pin with an empty KEY (header/spacer row) is a no-op', { skip }, () => {
  const { env, home } = makeEnv();
  assert.strictEqual(run(env, ['--pin', '']).code, 0);
  assert.ok(!fs.existsSync(pinFile(home)) || fs.readFileSync(pinFile(home), 'utf8').trim() === '',
    'an empty KEY never writes a pin');
});

// ---- --fold (enter on a fold header: toggle the sidecar, collapsed by default) ----
test('--fold expands a group by adding it to the sidecar, and --fold again collapses it', { skip }, () => {
  const { env, home } = makeEnv();
  assert.strictEqual(run(env, ['--fold', 'fold:completed']).code, 0);
  assert.strictEqual(fs.readFileSync(foldFile(home), 'utf8').trim(), 'completed', 'expanding adds the bare group name');
  assert.strictEqual(run(env, ['--fold', 'fold:completed']).code, 0);
  assert.strictEqual(fs.readFileSync(foldFile(home), 'utf8').trim(), '', 'toggling again re-collapses it');
});

test('--fold keeps other expanded groups when collapsing one', { skip }, () => {
  const { env, home } = makeEnv();
  run(env, ['--fold', 'fold:completed']);
  run(env, ['--fold', 'fold:idle']);
  run(env, ['--fold', 'fold:completed']); // re-collapse completed
  const lines = fs.readFileSync(foldFile(home), 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(lines, ['idle'], 'only the toggled group is removed');
});

test('--fold with an empty group is a no-op', { skip }, () => {
  const { env, home } = makeEnv();
  assert.strictEqual(run(env, ['--fold', 'fold:']).code, 0);
  // Not the looser "empty-or-missing" check: without the guard, appending "" still
  // creates the sidecar (as a single blank line, which .trim() also reads as empty) —
  // this must fail if that guard is removed, so it asserts the file was never created.
  assert.ok(!fs.existsSync(foldFile(home)), 'an empty group never creates the fold sidecar');
});

// A "tidy" that reverts the fold header back to an empty key (matching every other
// header/spacer row) would pass every other test in this file — the render still shows
// "COMPLETED (1)", and --skip would just deflect off it like any other header. Only
// checking the KEY itself catches that regression.
test('a collapsed group carries a landable fold: sentinel, not an empty key', { skip }, () => {
  const { env, home } = makeEnv();
  // A live local session: fold_live_completed_to_idle re-groups it under IDLE, which is
  // foldable exactly like COMPLETED — the sentinel mechanism under test is generic to any
  // foldable group.
  stateFile(home, 'done', { host: HOST, cwd: '/r/done', state: 'completed', ts: nowSec() - 10, kind: 'host', locator: 'tmux:/s:sd:%1', pane: '%1', title: 'done' });
  const body = run(env, ['--body']).out;
  const line = body.split('\n').find((l) => l.includes('IDLE'));
  assert.ok(line, `expected a collapsed IDLE line, got:\n${body}`);
  assert.strictEqual(line.split('\t')[0], 'fold:idle', 'the fold row carries the sentinel key, not an empty one');
});

// ---- fold round trip: an EXPANDED foldable header must stay landable ----
// build_pretty's COLLAPSED header carries a landable fold:<group> key (tested above); the
// EXPANDED header used to fall through to a bare empty key instead, so re-collapsing was
// unreachable from the keyboard (--skip bounces the cursor off any empty key) and a mouse
// click that DID land there hit --enter's accept fallback, silently exiting the picker.
// Drive the render for real, rather than hand-typing 'fold:completed', so a regression that
// puts the sentinel on the wrong branch (or only for one of the two foldable groups) shows up
// here instead of passing two separately-mocked tests the way this branch's own gap did.
test('an expanded foldable group header carries a landable fold: key end to end', { skip }, () => {
  const { env, home } = makeEnv();
  // A live local session: fold_live_completed_to_idle re-groups it under IDLE, which is
  // foldable exactly like COMPLETED — the round trip under test is generic to any
  // foldable group.
  stateFile(home, 'done', { host: HOST, cwd: '/r/done', state: 'completed', ts: nowSec() - 10, kind: 'host', locator: 'tmux:/s:sd:%1', pane: '%1', title: 'done' });
  fs.writeFileSync(foldFile(home), 'idle\n');   // expand it -- collapsed is the default
  const body = run(env, ['--body']).out;
  const line = body.split('\n').find((l) => l.includes('IDLE'));
  assert.ok(line, `expected an expanded IDLE line, got:\n${body}`);
  const key = line.split('\t')[0];
  assert.strictEqual(key, 'fold:idle', 'the EXPANDED header still carries the fold sentinel, not an empty key');

  // Feed that real KEY through --skip: a landable row must not deflect the cursor.
  assert.strictEqual(run(env, ['--skip', 'down', key, '4']).out.trim(), '',
    'the expanded header must stop the cursor (landable), not bounce it like a plain header');

  // Feed it through --enter: it must toggle the fold, not fall through to accept.
  const action = run(env, ['--enter', key]).out;
  assert.match(action, /--fold fold:idle/, 'enter on the expanded header toggles the fold, not accept');
  run(env, ['--fold', key]);   // perform the toggle --enter's transform would have triggered
  assert.strictEqual(fs.readFileSync(foldFile(home), 'utf8').trim(), '', 'the round trip re-collapses the group');
});

test('a non-foldable group header stays keyless even though a foldable one is now landable', { skip }, () => {
  const { env, home } = makeEnv();
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: nowSec() - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: 'alpha' });
  const body = run(env, ['--body']).out;
  const line = body.split('\n').find((l) => l.includes('WORKING'));
  assert.ok(line, `expected a WORKING line, got:\n${body}`);
  assert.strictEqual(line.split('\t')[0], '', 'a non-foldable state header keeps the empty key');
  assert.match(run(env, ['--skip', 'down', '', '4']).out, /^down\+transform/, 'a keyless header still deflects the cursor');
  // A mouse click or enter on this same keyless row must not fall through to --enter's
  // accept fallback -- that would silently exit the picker on a dead key.
  const entered = run(env, ['--enter', '']);
  assert.strictEqual(entered.out, '', 'enter on a keyless row must emit nothing, not accept');
  assert.strictEqual(entered.code, 0);
});

// ---- render: PINNED group + exclusion + gutter --------------------------
test('a pinned session renders in a PINNED group above its state group', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: now - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: 'alpha' });
  stateFile(home, 'c', { host: HOST, cwd: '/r/charlie', state: 'needs-input', ts: now - 3, kind: 'host', locator: 'tmux:/s:sc:%3', pane: '%3', title: 'charlie' });
  run(env, ['--pin', rowKey({ cwd: '/r/alpha', state: 'working', ts: now - 5, locator: 'tmux:/s:sa:%1', title: 'alpha' })]);
  const body = stripAnsi(run(env, ['--body']).out);
  assert.match(body, /PINNED/, 'a PINNED group header renders');
  const pinnedAt = body.indexOf('PINNED');
  const workingAt = body.indexOf('WORKING');
  assert.ok(pinnedAt >= 0 && (workingAt === -1 || pinnedAt < workingAt), 'PINNED sits above the state groups');
});

test('a pinned session is removed from its own state group', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: now - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: 'alpha' });
  stateFile(home, 'b', { host: HOST, cwd: '/r/bravo', state: 'working', ts: now - 9, kind: 'host', locator: 'tmux:/s:sb:%2', pane: '%2', title: 'bravo' });
  run(env, ['--pin', rowKey({ cwd: '/r/bravo', state: 'working', ts: now - 9, locator: 'tmux:/s:sb:%2', title: 'bravo' })]);
  const body = stripAnsi(run(env, ['--body']).out);
  // bravo renders as exactly one row (under PINNED); the WORKING count is now 1 (only alpha).
  const bravoRows = body.split('\n').filter((l) => l.split('\t')[0].includes('/r/bravo'));
  assert.strictEqual(bravoRows.length, 1, 'the pinned row is not duplicated into its state group');
  assert.match(body, /WORKING\s+1/, 'the state group count excludes the pinned row');
});

test('the number gutter labels the first session row 1', { skip }, () => {
  const { env, home } = makeEnv();
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: nowSec() - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: 'alpha' });
  const body = stripAnsi(run(env, ['--body']).out);
  const line = body.split('\n').find((l) => l.includes('alpha') && l.split('\t')[0] !== '');
  assert.ok(line, 'the session row rendered');
  // Field 2 is the fzf --track SID (host+cwd+kind identity); display starts at field 3.
  const display = line.split('\t').slice(2).join('\t');
  // Display is "<accent-bar> <N> <pill> …"; the first session's gutter number is 1.
  assert.match(display, /^▎ 1 /, 'the first session shows the "1" jump gutter after the accent bar');
});

// ---- --rename (CTRL+R: send Claude's own /rename into the pane) ----------
test('--rename pastes "/rename <name>" into an idle tmux pane, then submits with a separate Enter', { skip }, () => {
  const { env, tmuxLog, tmuxBufLog } = makeEnv();
  const key = rowKey({ cwd: '/r/c', state: 'needs-input', pane: '%3', locator: 'tmux:/s:sc:%3' });
  assert.strictEqual(run(env, ['--rename', key], { input: 'Fix the parser\n' }).code, 0);
  const log = read(tmuxLog);
  assert.match(read(tmuxBufLog), /^\/rename Fix the parser$/, 'the buffer carries the /rename command');
  assert.match(log, /paste-buffer -p -d -b \S+ -t %3/, 'pasted with bracketed-paste markers, buffer dropped after');
  assert.match(log, /send-keys -t %3 Enter/, 'then submits with Enter');
  assert.doesNotMatch(log, /send-keys -t %3 -l/, 'never send-keys -l: it truncates at ~1024 bytes');
});

// ---- --send (CTRL+T: type a message into the session without attaching) --
test('--send pastes the message into an idle tmux pane and submits it', { skip }, () => {
  const { env, tmuxLog, tmuxBufLog } = makeEnv();
  const key = rowKey({ cwd: '/r/c', state: 'idle', pane: '%3', locator: 'tmux:/s:sc:%3' });
  assert.strictEqual(run(env, ['--send', key], { input: 'run the tests again\n' }).code, 0);
  assert.match(read(tmuxBufLog), /^run the tests again$/, 'the message reaches the pane verbatim');
  assert.match(read(tmuxLog), /paste-buffer -p -d -b \S+ -t %3/);
  assert.match(read(tmuxLog), /send-keys -t %3 Enter/);
});

test('--send carries a prompt past the ~1024-byte send-keys ceiling intact', { skip }, () => {
  // The regression this whole path exists for: `send-keys -l` stops silently around 1024
  // bytes, so a long prompt used to arrive cut in half with no error anywhere.
  const { env, tmuxBufLog } = makeEnv();
  const long = 'x'.repeat(4096);
  const key = rowKey({ cwd: '/r/c', state: 'idle', pane: '%3', locator: 'tmux:/s:sc:%3' });
  assert.strictEqual(run(env, ['--send', key], { input: `${long}\n` }).code, 0);
  assert.strictEqual(read(tmuxBufLog).trim().length, 4096, 'all 4096 bytes made it into the buffer');
});

test('--send is a no-op for a none: (pane-less) session', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const key = rowKey({ cwd: '/r/none', state: 'idle', locator: 'none:' });
  assert.strictEqual(run(env, ['--send', key], { input: 'hello\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'no pane to address -> nothing is sent');
});

test('--send refuses a working session (the keys would land mid-task)', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const key = rowKey({ cwd: '/r/busy', state: 'working', pane: '%4', locator: 'tmux:/s:sb:%4' });
  assert.strictEqual(run(env, ['--send', key], { input: 'later\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'a working session is gated out');
});

test('--send refuses a bg row: a daemon session has no pane to type into', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const key = rowKey({ cwd: '/r/bg', state: 'idle', kind: 'bg', locator: 'bg:job-1' });
  assert.strictEqual(run(env, ['--send', key], { input: 'hello\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'nothing is sent to a paneless bg session');
});

test('--send with an empty message sends nothing', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const key = rowKey({ cwd: '/r/c', state: 'idle', pane: '%3', locator: 'tmux:/s:sc:%3' });
  assert.strictEqual(run(env, ['--send', key], { input: '\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'an empty prompt is a cancel, not a bare Enter');
});

test('--send drives a REMOTE tmux session over ssh, text on stdin not in the command', { skip }, () => {
  const { env, sshLog, tmuxLog } = makeEnv();
  const key = rowKey({ host: 'daniel-server', cwd: '/home/ubuntu/p', state: 'idle', pane: '%9', locator: 'tmux:/s:rs:%9' });
  assert.strictEqual(run(env, ['--send', key], { input: 'deploy it\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'never touches a local pane for a remote session');
  const log = read(sshLog);
  assert.match(log, /daniel-server/, 'ssh targets the remote alias');
  assert.match(log, /load-buffer/, 'the remote loads a buffer rather than send-keys -l');
  assert.match(log, /paste-buffer -p -d -b \S+ -t %9/);
  assert.doesNotMatch(log, /deploy it/, 'the message travels on stdin, never quoted into the remote command');
});

test('--rename is a no-op for a none: (pane-less) session', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const key = rowKey({ cwd: '/r/none', state: 'idle', locator: 'none:' });
  assert.strictEqual(run(env, ['--rename', key], { input: 'Nope\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'no pane to address -> nothing is sent');
});

test('--rename refuses a working session (would inject mid-task)', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const key = rowKey({ cwd: '/r/busy', state: 'working', pane: '%4', locator: 'tmux:/s:sb:%4' });
  assert.strictEqual(run(env, ['--rename', key], { input: 'Later\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'a working session is gated out');
});

test('--rename drives a REMOTE tmux session over ssh', { skip }, () => {
  const { env, sshLog, tmuxLog } = makeEnv();
  const key = rowKey({ host: 'daniel-server', cwd: '/home/ubuntu/p', state: 'idle', pane: '%9', locator: 'tmux:/s:rs:%9' });
  assert.strictEqual(run(env, ['--rename', key], { input: 'Remote name\n' }).code, 0);
  assert.strictEqual(read(tmuxLog), '', 'never touches a local pane for a remote session');
  const log = read(sshLog);
  assert.match(log, /daniel-server/, 'ssh targets the remote alias');
  assert.match(log, /load-buffer -b \S+/, 'the remote loads a buffer (send-keys -l truncates)');
  assert.match(log, /paste-buffer -p -d -b \S+ -t %9/, 'and pastes it into the remote pane');
  assert.match(log, /send-keys -t %9 Enter/, 'then submits with Enter');
});

// ---- --resume (CTRL+V: reopen a session whose pane is gone) --------------
test('--resume reopens a pane-less session with claude --resume at its own cwd', { skip }, () => {
  const { env, home, claudeLog } = makeEnv();
  stateFile(home, 'sid-gone', {
    session: 'sid-gone', host: HOST, cwd: '/r/lost', kind: 'host', locator: 'none:',
    state: 'idle', ts: nowSec(),
  });
  const key = rowKey({ cwd: '/r/lost', state: 'idle', pane: '', locator: 'none:' });
  run(env, ['--resume', key]);
  const log = read(claudeLog);
  assert.match(log, /--resume sid-gone/, 'resumes THAT session, not a fresh one');
});

test('--resume matches the record by host+cwd+kind, so a scrubbed locator still resolves', { skip }, () => {
  // av_neutralize_locator blanks a locator the live registry could not confirm, so the row's
  // none: and the file's recorded pane disagree by design. Matching on the locator would find
  // nothing — exactly the row that most needs resuming.
  const { env, home, claudeLog } = makeEnv();
  stateFile(home, 'sid-scrub', {
    session: 'sid-scrub', host: HOST, cwd: '/r/scrubbed', kind: 'host',
    locator: 'tmux:/s:sc:%77', state: 'idle', ts: nowSec(),
  });
  const key = rowKey({ cwd: '/r/scrubbed', state: 'idle', pane: '', locator: 'none:' });
  run(env, ['--resume', key]);
  assert.match(read(claudeLog), /--resume sid-scrub/);
});

test('--resume inside tmux opens a new window instead of taking over the picker shell', { skip }, () => {
  const { env, home, tmuxLog } = makeEnv();
  stateFile(home, 'sid-tm', {
    session: 'sid-tm', host: HOST, cwd: '/r/lost', kind: 'host', locator: 'none:',
    state: 'idle', ts: nowSec(),
  });
  const key = rowKey({ cwd: '/r/lost', state: 'idle', pane: '', locator: 'none:' });
  run(env, ['--resume', key], { extraEnv: { TMUX: '/tmp/tmux-1000/default,1,0' } });
  assert.match(read(tmuxLog), /new-window .*claude --resume sid-tm/);
});

test('--resume refuses a row that still has a pane (that is what <enter> is for)', { skip }, () => {
  const { env, home, claudeLog } = makeEnv();
  stateFile(home, 'sid-live', {
    session: 'sid-live', host: HOST, cwd: '/r/live', kind: 'host',
    locator: 'tmux:/s:sc:%3', state: 'idle', ts: nowSec(),
  });
  const key = rowKey({ cwd: '/r/live', state: 'idle', pane: '%3', locator: 'tmux:/s:sc:%3' });
  run(env, ['--resume', key]);
  assert.strictEqual(read(claudeLog), '', 'a reachable session is never respawned');
});

test('--resume refuses a session on another machine', { skip }, () => {
  const { env, home, claudeLog } = makeEnv();
  stateFile(home, 'sid-rem', {
    session: 'sid-rem', host: 'daniel-server', cwd: '/r/rem', kind: 'host', locator: 'none:',
    state: 'idle', ts: nowSec(),
  });
  const key = rowKey({ host: 'daniel-server', cwd: '/r/rem', state: 'idle', pane: '', locator: 'none:' });
  run(env, ['--resume', key]);
  assert.strictEqual(read(claudeLog), '', 'resuming a remote session locally would run it on the wrong host');
});

test('--resume refuses a bg row: the daemon owns that session', { skip }, () => {
  const { env, claudeLog } = makeEnv();
  const key = rowKey({ cwd: '/r/bg', state: 'idle', pane: '', kind: 'bg', locator: 'none:' });
  run(env, ['--resume', key]);
  assert.strictEqual(read(claudeLog), '');
});

test('--resume with no session record does nothing', { skip }, () => {
  const { env, claudeLog } = makeEnv();
  const key = rowKey({ cwd: '/r/unknown', state: 'idle', pane: '', locator: 'none:' });
  run(env, ['--resume', key]);
  assert.strictEqual(read(claudeLog), '', 'nothing to resume -> no guessed session id');
});

// ---- --remove (CTRL+X: REALLY delete — kill the process + claude rm) -----
test('--remove kills the mapped pid, runs `claude rm`, deletes the row (after confirm)', { skip }, () => {
  const { env, home, killLog, claudeLog } = makeEnv();
  stateFile(home, 'gone', { session: 'gone', cwd: '/r/gone', state: 'idle', host: HOST, kind: 'host', locator: 'tmux:/s:g:%1' });
  sessionProc(home, 5150, 'gone');                    // Claude maps pid 5150 -> session gone
  const key = rowKey({ cwd: '/r/gone', state: 'idle', locator: 'tmux:/s:g:%1' });
  assert.strictEqual(run(env, ['--remove', key], { extraEnv: { FZF_PICK: 'Remove' } }).code, 0);
  assert.strictEqual(read(killLog).trim(), '5150', 'kills the pid Claude maps to this session');
  assert.match(read(claudeLog), /rm gone/, 'runs `claude rm <sid>` to delete the record + worktree');
  assert.ok(!fs.existsSync(avFile(home, 'gone')), 'the registry row is dropped');
});

test('--remove aborts entirely when the confirm chooser returns Cancel', { skip }, () => {
  const { env, home, killLog } = makeEnv();
  stateFile(home, 'keep', { session: 'keep', cwd: '/r/keep', state: 'idle', host: HOST, kind: 'host', locator: 'tmux:/s:k:%1' });
  sessionProc(home, 6000, 'keep');
  const key = rowKey({ cwd: '/r/keep', state: 'idle', locator: 'tmux:/s:k:%1' });
  assert.strictEqual(run(env, ['--remove', key], { extraEnv: { FZF_PICK: 'Cancel' } }).code, 0);
  assert.strictEqual(read(killLog).trim(), '', 'no process is signalled');
  assert.ok(fs.existsSync(avFile(home, 'keep')), 'the session is left intact');
});

test('--remove only kills the pid Claude currently maps to the sid (reuse-safe)', { skip }, () => {
  const { env, home, killLog } = makeEnv();
  stateFile(home, 'target', { session: 'target', cwd: '/r/t', state: 'idle', host: HOST, kind: 'host', locator: 'tmux:/s:t:%1' });
  sessionProc(home, 1111, 'someone-else');            // 1111 belongs to a DIFFERENT session
  sessionProc(home, 2222, 'target');                  // 2222 is our session
  const key = rowKey({ cwd: '/r/t', state: 'idle', locator: 'tmux:/s:t:%1' });
  assert.strictEqual(run(env, ['--remove', key], { extraEnv: { FZF_PICK: 'Remove' } }).code, 0);
  assert.strictEqual(read(killLog).trim(), '2222', 'only the sid-matched pid is killed, never a reused one');
});

test('--remove of a REMOTE row purges over ssh and filters the cache', { skip }, () => {
  const now = nowSec();
  const gone = JSON.stringify({ session: 'rg', cwd: '/r/rgone', state: 'working', host: 'daniel-server', kind: 'host', ts: now, locator: 'tmux:/s:rg:%2' });
  const keep = JSON.stringify({ session: 'rk', cwd: '/r/rkeep', state: 'idle', host: 'daniel-server', kind: 'host', ts: now, locator: 'tmux:/s:rk:%1' });
  const { env, home, sshLog } = makeEnv();
  fs.writeFileSync(path.join(home, '.agentview-remote-cache.daniel-server'), `${gone}\n${keep}`);
  const key = rowKey({ host: 'daniel-server', cwd: '/r/rgone', state: 'working', locator: 'tmux:/s:rg:%2' });
  assert.strictEqual(run(env, ['--remove', key], { extraEnv: { FZF_PICK: 'Remove' } }).code, 0);
  assert.match(read(sshLog), /claude rm/, 'runs the purge on the remote over ssh');
  assert.match(read(sshLog), /s=rg/, 'for the selected session id');
  const cache = fs.readFileSync(path.join(home, '.agentview-remote-cache.daniel-server'), 'utf8');
  assert.doesNotMatch(cache, /rgone/, 'the removed remote row leaves the cache');
  assert.match(cache, /rkeep/, 'other remote rows stay');
});

// ---- --jump-nth (ALT+1..9) ---------------------------------------------
test('--jump-nth focuses the Nth session in render order', { skip }, () => {
  const { env, home, tmuxLog } = makeEnv();
  const now = nowSec();
  // No pins: order is needs-input (charlie #1), then working ts desc (alpha #2, bravo #3).
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: now - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: 'alpha' });
  stateFile(home, 'b', { host: HOST, cwd: '/r/bravo', state: 'working', ts: now - 9, kind: 'host', locator: 'tmux:/s:sb:%2', pane: '%2', title: 'bravo' });
  stateFile(home, 'c', { host: HOST, cwd: '/r/charlie', state: 'needs-input', ts: now - 3, kind: 'host', locator: 'tmux:/s:sc:%3', pane: '%3', title: 'charlie' });
  run(env, ['--jump-nth', '1']);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /select-pane -t %3/, 'jump #1 is the needs-input session');
  fs.writeFileSync(tmuxLog, '');
  run(env, ['--jump-nth', '2']);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /select-pane -t %1/, 'jump #2 is the newest working session');
});

test('--jump-nth counts a pinned session as #1', { skip }, () => {
  const { env, home, tmuxLog } = makeEnv();
  const now = nowSec();
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: now - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: 'alpha' });
  stateFile(home, 'b', { host: HOST, cwd: '/r/bravo', state: 'working', ts: now - 9, kind: 'host', locator: 'tmux:/s:sb:%2', pane: '%2', title: 'bravo' });
  run(env, ['--pin', rowKey({ cwd: '/r/bravo', state: 'working', ts: now - 9, locator: 'tmux:/s:sb:%2', title: 'bravo' })]);
  run(env, ['--jump-nth', '1']);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /select-pane -t %2/, 'the pinned session is jump target #1');
});

test('--jump-nth skips a collapsed fold row instead of mis-numbering past it', { skip }, () => {
  const { env, home, tmuxLog } = makeEnv();
  const now = nowSec();
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: now - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: 'alpha' });
  // charlie is on a non-self host: fold_live_completed_to_idle only re-groups a LOCAL
  // host row, so a self-host fixture here would fold into the same IDLE group as delta
  // instead of staying a separate collapsed COMPLETED group.
  stateFile(home, 'c', { host: 'otherbox', cwd: '/r/charlie', state: 'completed', ts: now - 10, kind: 'host', locator: 'tmux:/s:sc:%3', pane: '%3', title: 'charlie' });
  stateFile(home, 'd', { host: HOST, cwd: '/r/delta', state: 'idle', ts: now - 20, kind: 'host', locator: 'tmux:/s:sd:%4', pane: '%4', title: 'delta' });
  // completed stays collapsed (default); idle is explicitly expanded. Render order is fixed
  // by group (working, then completed, then idle), so this is: alpha (gutter 1), fold:completed
  // (a row with no gutter number), delta (gutter 2). --jump-nth 2 must land on delta, not on
  // whatever the fold row's position in the fold: KEY count would otherwise put there.
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'idle\n');
  run(env, ['--jump-nth', '2']);
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /select-pane -t %4/, 'jump #2 is the row gutter 2 actually numbers (delta), not the fold row before it');
});

// ---- --skip (up/down step over the group headers + spacers) -------------
test('--skip leaves the cursor on a real session row', { skip }, () => {
  const { env } = makeEnv();
  const out = run(env, ['--skip', 'down', rowKey({ cwd: '/r/alpha', locator: 'tmux:/s:sa:%1' })]).out;
  assert.strictEqual(out, '', 'a keyed row emits no follow-up action');
});

test('--skip keeps going the same way off a keyless header/spacer row', { skip }, () => {
  const { env } = makeEnv();
  assert.match(run(env, ['--skip', 'up', '']).out, /^up\+transform\(.*--skip up \{1\} 3\)$/,
    'up off a header moves up again and re-arms itself with a hop spent');
  assert.match(run(env, ['--skip', 'down', '']).out, /^down\+transform\(.*--skip down \{1\} 3\)$/,
    'down off a header moves down again');
});

test('--skip runs out of hops, so an all-keyless list cannot spin forever', { skip }, () => {
  const { env } = makeEnv();
  let out = run(env, ['--skip', 'down', '']).out;
  let hops = 0;
  while (out && hops < 20) { hops++; out = run(env, ['--skip', 'down', '', out.match(/\{1\} (\d+)\)$/)[1]]).out; }
  assert.ok(hops < 20, `the chain terminates on its own (took ${hops} hops)`);
  assert.strictEqual(run(env, ['--skip', 'down', '', '0']).out, '', 'a spent budget emits nothing');
});

test('--skip re-arms with AGENTVIEW_SELF, so an undeployed copy drives its own picker', { skip }, () => {
  const { env } = makeEnv();
  const out = run(env, ['--skip', 'down', ''], { extraEnv: { AGENTVIEW_SELF: '/tmp/av-copy' } }).out;
  assert.match(out, /transform\('\/tmp\/av-copy' --skip down/, 'the recursion points back at the same copy');
});

// --skip exists so the cursor never rests on a keyless row. A fold header has to be
// selectable to be expandable, so it carries a sentinel key (fold:<group>) rather than an
// empty one — and the dispatch's early return on any non-empty key catches it unmodified.
test('a fold header is landable, unlike a plain group header', { skip }, () => {
  const { env } = makeEnv();
  const out = run(env, ['--skip', 'down', 'fold:completed', '4']).out;
  assert.strictEqual(out.trim(), '', 'a fold header must stop the cursor, not deflect it');
});

test('a plain header still deflects the cursor', { skip }, () => {
  const { env } = makeEnv();
  const out = run(env, ['--skip', 'down', '', '4']).out;
  assert.match(out, /^down\+transform/, 'a keyless header must still be skipped');
});

// ---- --keys (the ? shortcut cheatsheet) ---------------------------------
test('--keys renders every shortcut in the cheatsheet', { skip }, () => {
  const { env } = makeEnv();
  const txt = stripAnsi(run(env, ['--keys']).out);
  for (const s of ['shortcuts', 'Navigate', 'Manage', 'View',
    '⌥1 … ⌥9', 'switch to selected', '⌃r', 'rename label', '⌃p', 'pin / unpin',
    '⌃x', '⌃n', '⌃o', 'session details', '⌃f', '? ', 'this help', 'esc']) {
    assert.ok(txt.includes(s), `cheatsheet lists "${s}"`);
  }
});

// ---- picker binds + footer ----------------------------------------------
test('picker binds the new hotkeys and hints them in the footer', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /ctrl-r:execute\([^)]*--rename {1}/, 'ctrl-r renames the selected row');
  assert.match(src, /ctrl-p:execute-silent\([^)]*--pin {1}/, 'ctrl-p pins the selected row');
  // A transform, not a bare reload: --repaint decides between repainting and restarting the
  // picker, so that a schema change deployed under it cannot skew the columns.
  assert.match(src, /ctrl-f:transform\([^)]*--repaint \{q\}\)/, 'ctrl-f is the manual refresh (moved off ctrl-r)');
  assert.match(src, /alt-1:become\([^)]*--jump-nth 1\)/, 'alt-1 jumps to session #1');
  assert.match(src, /alt-9:become\([^)]*--jump-nth 9\)/, 'alt-9 jumps to session #9');
  assert.match(src, /'\?:show-preview\+preview\([^)]*--keys\)'/, '? shows the shortcut cheatsheet');
  assert.match(src, /ctrl-o:toggle-preview/, 'ctrl-o toggles the session details card');
  assert.match(src, /up:up\+transform\([^)]*--skip up \{1\}\)/, 'up steps over a group header');
  assert.match(src, /down:down\+transform\([^)]*--skip down \{1\}\)/, 'down steps over a group header');
  assert.match(src, /load:transform\([^)]*--skip down \{1\}\)/, 'the picker never opens on a header row');
  const hints = fs.readFileSync(RENDER, 'utf8');
  assert.match(hints, /⌃r rename/, 'footer advertises rename');
  assert.match(hints, /⌃p pin/, 'footer advertises pin');
  assert.match(hints, /alt-# jump/, 'footer advertises the alt jump');
  assert.match(hints, /⌃f refresh/, 'footer advertises the moved refresh');
  assert.match(hints, /\? keys/, 'footer advertises the shortcut help');
});

// ---- render width + twin-name disambiguation ----------------------------
test('--body row width tracks FZF_COLUMNS instead of a fixed 72', { skip }, () => {
  const { env, home } = makeEnv();
  const longTitle = 'a very long task title that should be truncated at narrow widths, definitely longer than the pane';
  stateFile(home, 'a', { host: HOST, cwd: '/r/alpha', state: 'working', ts: nowSec() - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: longTitle });
  const rowAt = (cols) => {
    const body = stripAnsi(run(env, ['--body'], { extraEnv: { FZF_COLUMNS: String(cols) } }).out);
    const line = body.split('\n').find((l) => l.includes('alpha') && l.split('\t')[0] !== '');
    assert.ok(line, `session row rendered at ${cols} cols`);
    return line.split('\t').slice(2).join('\t');   // field 2 is the track SID, display is field 3+
  };
  const narrow = rowAt(50);
  const wide = rowAt(120);
  assert.ok(narrow.length <= 50, `a 50-col pane gets a row that fits it (got ${narrow.length})`);
  assert.ok(wide.length > narrow.length, 'a wider pane renders a wider row');
  assert.match(narrow, /…/, 'the long title truncates at narrow width instead of overflowing');
});

test('rows sharing a leaf dir name get a parent-dir prefix', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'a', { host: HOST, cwd: '/repos/one/proj', state: 'working', ts: now - 5, kind: 'host', locator: 'tmux:/s:sa:%1', pane: '%1', title: '' });
  stateFile(home, 'b', { host: HOST, cwd: '/repos/two/proj', state: 'working', ts: now - 9, kind: 'host', locator: 'tmux:/s:sb:%2', pane: '%2', title: '' });
  stateFile(home, 'c', { host: HOST, cwd: '/repos/one/solo', state: 'working', ts: now - 3, kind: 'host', locator: 'tmux:/s:sc:%3', pane: '%3', title: '' });
  const body = stripAnsi(run(env, ['--body']).out);
  // Judge only the DISPLAY halves — the KEY field carries the full cwd either way.
  const displays = body.split('\n').map((l) => l.split('\t').slice(2).join('\t'));
  assert.ok(displays.some((d) => d.includes('one/proj')), 'first twin carries its parent dir');
  assert.ok(displays.some((d) => d.includes('two/proj')), 'second twin carries its parent dir');
  const solo = displays.find((d) => d.includes('solo'));
  assert.ok(solo && !solo.includes('one/solo'), 'a unique leaf name stays bare');
});

// ---- --refresh-remote (CTRL+F / startup: pull homelab cache, reload fzf) --
test('--refresh-remote pulls over ssh and posts a reload to the fzf port', { skip }, () => {
  const { bin, env, home, sshLog } = makeEnv();
  const curlLog = path.join(bin, 'curl.log'); fs.writeFileSync(curlLog, '');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\necho "$*" >> "$CURL_LOG"\nexit 0\n`, { mode: 0o755 });
  const pf = path.join(home, 'portfile'); fs.writeFileSync(pf, '61234\n');
  assert.strictEqual(run(env, ['--refresh-remote', pf], { extraEnv: { CURL_LOG: curlLog } }).code, 0);
  assert.match(read(sshLog), /daniel-server/, 'refreshes the homelab snapshot over ssh');
  assert.ok(fs.existsSync(path.join(home, '.agentview-remote-cache.daniel-server')), 'rewrites the remote cache');
  const curl = read(curlLog);
  assert.match(curl, /127\.0\.0\.1:61234/, 'posts to the port read from the portfile');
  assert.match(curl, /reload\(/, 'the POST body is a reload action');
});

test('ctrl-f also kicks a background remote refresh', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /ctrl-f:.*--refresh-remote/, 'ctrl-f reloads locally, then refreshes the remote cache in the background');
});

// ---- C-Left: back to Agent View from inside any non-shell pane ----------
// The tmux half of this is gone: dot_tmux.conf no longer binds C-Left, prefix+g or prefix+G,
// because Warp's sidebar replaced the picker those reached. WezTerm still binds it, so the
// guard below stays.
const WEZTERM = path.join(__dirname, '..', '..', 'home', 'dot_config', 'wezterm', 'wezterm.lua.tmpl');

test('wezterm binds CTRL+Left with the same shell pass-through', () => {
  const src = fs.readFileSync(WEZTERM, 'utf8');
  const at = src.indexOf('key = "LeftArrow", mods = "CTRL"');
  assert.ok(at >= 0, 'a CTRL+LeftArrow binding exists');
  const block = src.slice(at, src.indexOf('end) },', at));
  assert.match(block, /get_foreground_process_name/, 'the bind probes the foreground process');
  assert.match(block, /SendKey/, 'a shell gets the key passed through (word-left survives)');
  assert.match(block, /agentview/, 'a non-shell pane spawns the picker tab');
  for (const s of ['zsh', 'bash', 'wsl', 'wslhost']) {
    assert.match(block, new RegExp(`\\b${s} = true`), `pass-through covers ${s}`);
  }
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
