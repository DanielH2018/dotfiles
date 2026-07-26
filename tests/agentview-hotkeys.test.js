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
const { agentviewWinSeams } = require('./lib/agentview-env');

const VIEW = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_agentview');
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
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash\necho ${HOST}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash\necho "$*" >> "$TMUX_LOG"\nexit 0\n`, { mode: 0o755 });
  // --body / --jump-nth run after the jq+fzf tool check, so fzf must exist (never invoked here).
  // Answers the Ctrl+X confirm chooser. An unset FZF_PICK is an empty pick — i.e. cancelled.
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash\n[ -n "\${FZF_PICK:-}" ] && printf '%s\\n' "$FZF_PICK"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash\necho "$*" >> "$CLAUDE_LOG"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash\necho "$*" >> "$SSH_LOG"\nexit 0\n`, { mode: 0o755 });
  // Injection seam for the guarded kill — logs the pid instead of signalling anything.
  const killStub = path.join(bin, 'killstub'); fs.writeFileSync(killStub, `#!/bin/bash\necho "$1" >> "$KILL_LOG"\nexit 0\n`, { mode: 0o755 });
  // Real Windows sessions would render alongside the fixtures and shift the row numbering
  // the pin/jump assertions depend on. See tests/lib/agentview-env.js.
  const seams = agentviewWinSeams({ bin, scratch });
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    TMUX_LOG: tmuxLog, CLAUDE_LOG: claudeLog, SSH_LOG: sshLog, KILL_LOG: killLog, AV_KILLCMD: killStub,
    ...seams.env,
  };
  delete env.TMUX; // a bare shell -> tmux jump takes the attach path
  return { bin, home, env, tmuxLog, claudeLog, sshLog, killLog };
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
  const display = line.split('\t').slice(1).join('\t');
  // Display is "<accent-bar> <N> <pill> …"; the first session's gutter number is 1.
  assert.match(display, /^▎ 1 /, 'the first session shows the "1" jump gutter after the accent bar');
});

// ---- --rename (CTRL+R: send Claude's own /rename into the pane) ----------
test('--rename types "/rename <name>" + Enter into an idle tmux pane', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  const key = rowKey({ cwd: '/r/c', state: 'needs-input', pane: '%3', locator: 'tmux:/s:sc:%3' });
  assert.strictEqual(run(env, ['--rename', key], { input: 'Fix the parser\n' }).code, 0);
  const log = read(tmuxLog);
  assert.match(log, /send-keys -t %3 -l \/rename Fix the parser/, 'sends the /rename command literally');
  assert.match(log, /send-keys -t %3 Enter/, 'then submits with Enter');
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
  // The name is %q-escaped for the remote shell, so match loosely across the spaces.
  assert.match(log, /send-keys -t %9 -l [^;]*rename[^;]*Remote[^;]*name/, 'ssh sends the /rename keys on the remote');
  assert.match(log, /send-keys -t %9 Enter/, 'then submits with Enter');
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
  fs.writeFileSync(path.join(home, '.agentview-remote-cache'), `${gone}\n${keep}`);
  const key = rowKey({ host: 'daniel-server', cwd: '/r/rgone', state: 'working', locator: 'tmux:/s:rg:%2' });
  assert.strictEqual(run(env, ['--remove', key], { extraEnv: { FZF_PICK: 'Remove' } }).code, 0);
  assert.match(read(sshLog), /claude rm/, 'runs the purge on the remote over ssh');
  assert.match(read(sshLog), /s=rg/, 'for the selected session id');
  const cache = fs.readFileSync(path.join(home, '.agentview-remote-cache'), 'utf8');
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
  assert.match(src, /ctrl-f:reload\(/, 'ctrl-f is the manual refresh (moved off ctrl-r)');
  assert.match(src, /alt-1:become\([^)]*--jump-nth 1\)/, 'alt-1 jumps to session #1');
  assert.match(src, /alt-9:become\([^)]*--jump-nth 9\)/, 'alt-9 jumps to session #9');
  assert.match(src, /'\?:show-preview\+preview\([^)]*--keys\)'/, '? shows the shortcut cheatsheet');
  assert.match(src, /ctrl-o:toggle-preview/, 'ctrl-o toggles the session details card');
  assert.match(src, /up:up\+transform\([^)]*--skip up \{1\}\)/, 'up steps over a group header');
  assert.match(src, /down:down\+transform\([^)]*--skip down \{1\}\)/, 'down steps over a group header');
  assert.match(src, /load:transform\([^)]*--skip down \{1\}\)/, 'the picker never opens on a header row');
  assert.match(src, /⌃r rename/, 'footer advertises rename');
  assert.match(src, /⌃p pin/, 'footer advertises pin');
  assert.match(src, /alt-# jump/, 'footer advertises the alt jump');
  assert.match(src, /⌃f refresh/, 'footer advertises the moved refresh');
  assert.match(src, /\? keys/, 'footer advertises the shortcut help');
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
    return line.split('\t').slice(1).join('\t');
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
  const displays = body.split('\n').map((l) => l.split('\t').slice(1).join('\t'));
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
  assert.ok(fs.existsSync(path.join(home, '.agentview-remote-cache')), 'rewrites the remote cache');
  const curl = read(curlLog);
  assert.match(curl, /127\.0\.0\.1:61234/, 'posts to the port read from the portfile');
  assert.match(curl, /reload\(/, 'the POST body is a reload action');
});

test('ctrl-f also kicks a background remote refresh', () => {
  const src = fs.readFileSync(VIEW, 'utf8');
  assert.match(src, /ctrl-f:.*--refresh-remote/, 'ctrl-f reloads locally, then refreshes the remote cache in the background');
});

// ---- C-Left: back to Agent View from inside any non-shell pane ----------
const TMUXCONF = path.join(__dirname, '..', 'home', 'dot_tmux.conf');
const WEZTERM = path.join(__dirname, '..', 'home', 'dot_config', 'wezterm', 'wezterm.lua.tmpl');
let tmuxOk = true;
try { execFileSync('bash', ['-c', 'command -v tmux'], { stdio: 'ignore' }); } catch { tmuxOk = false; }
const tmuxSkip = tmuxOk ? false : 'tmux unavailable';

test('tmux binds prefix-less C-Left: shells pass through, other panes get the picker', () => {
  const conf = fs.readFileSync(TMUXCONF, 'utf8');
  const bind = conf.split('\n').find((l) => l.startsWith('bind -n C-Left'));
  assert.ok(bind, 'a root-table (no prefix) C-Left bind exists');
  assert.match(bind, /if -F/, 'the bind branches on the pane command');
  assert.match(bind, /send-keys C-Left/, 'a shell keeps word-left — the key passes through');
  // A window, not a display-popup: tmux allows one popup per client, and a picker that was
  // itself a popup could never float its CTRL+X / CTRL+N choosers (tmux drops the nested
  // request silently). -S reuses the window instead of stacking a new one per press.
  assert.match(bind, /new-window -S -n agentview agentview/, 'a non-shell pane opens the picker window');
});

test('the C-Left condition passes shells and catches claude panes (real tmux)', { skip: tmuxSkip }, () => {
  // Evaluate the ACTUAL regex from the conf through real tmux format matching, so a
  // typo'd pattern can't ship: the picker would silently stop opening from claude panes.
  const conf = fs.readFileSync(TMUXCONF, 'utf8');
  const m = conf.match(/#\{m\/r:([^,]+),#\{pane_current_command\}\}/);
  assert.ok(m, 'the bind embeds an m/r regex on pane_current_command');
  const sock = path.join(scratch('avh-tmux-'), 'sock');
  const T = (...a) => execFileSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' });
  try {
    T('new-session', '-d', '-s', 'probe');
    const evalRe = (cand) => T('display', '-p', `#{m/r:${m[1]},${cand}}`).trim();
    assert.strictEqual(evalRe('zsh'), '1', 'zsh passes through');
    assert.strictEqual(evalRe('bash'), '1', 'bash passes through');
    assert.strictEqual(evalRe('claude'), '0', 'a claude pane summons the picker');
    assert.strictEqual(evalRe('docker'), '0', 'a sandbox (docker) pane summons the picker');
    assert.strictEqual(evalRe('ssh'), '0', 'a remote-attach (ssh) pane summons the picker');
  } finally {
    try { T('kill-server'); } catch { /* server already gone */ }
  }
});

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
