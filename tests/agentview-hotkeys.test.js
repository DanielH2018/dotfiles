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
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash\necho ${HOST}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash\necho "$*" >> "$TMUX_LOG"\nexit 0\n`, { mode: 0o755 });
  // --body / --jump-nth run after the jq+fzf tool check, so fzf must exist (never invoked here).
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/bash\nexit 0\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TMUX_LOG: tmuxLog };
  delete env.TMUX; // a bare shell -> tmux jump takes the attach path
  return { bin, home, env, tmuxLog };
}

function stateFile(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
const avFile = (home, sid) => path.join(home, '.claude', 'agent-view', `${sid}.json`);
const pinFile = (home) => path.join(home, '.claude', 'agent-view-pins');

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

// ---- --pin (CTRL+T: toggle a pin in the sidecar) ------------------------
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

// ---- --rename (CTRL+R) --------------------------------------------------
test('--rename writes the typed label to the matching local file', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'c', { host: HOST, cwd: '/r/charlie', state: 'needs-input', ts: now, kind: 'host', locator: 'tmux:/s:sc:%3', pane: '%3', title: 'old' });
  const key = rowKey({ cwd: '/r/charlie', state: 'needs-input', ts: now, title: 'old', pane: '%3', locator: 'tmux:/s:sc:%3' });
  assert.strictEqual(run(env, ['--rename', key], { input: 'brand new label\n' }).code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(avFile(home, 'c'), 'utf8')).title, 'brand new label');
});

test('--rename with empty input clears the label', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'c', { host: HOST, cwd: '/r/charlie', state: 'working', ts: now, kind: 'host', locator: 'tmux:/s:sc:%3', pane: '%3', title: 'was set' });
  const key = rowKey({ cwd: '/r/charlie', ts: now, title: 'was set', pane: '%3', locator: 'tmux:/s:sc:%3' });
  assert.strictEqual(run(env, ['--rename', key], { input: '\n' }).code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(avFile(home, 'c'), 'utf8')).title, '', 'empty input clears .title');
});

test('--rename of a remote row leaves local files untouched', { skip }, () => {
  const { env, home } = makeEnv();
  const now = nowSec();
  stateFile(home, 'local', { host: HOST, cwd: '/r/local', state: 'working', ts: now, kind: 'host', locator: 'tmux:/s:x:%1', pane: '%1', title: 'keep' });
  const key = rowKey({ host: 'daniel-server', cwd: '/home/ubuntu/remote', locator: 'tmux:/s:remote:%9' });
  assert.strictEqual(run(env, ['--rename', key], { input: 'nope\n' }).code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(avFile(home, 'local'), 'utf8')).title, 'keep', 'a remote rename never touches a local file');
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
  assert.match(src, /⌃r rename/, 'footer advertises rename');
  assert.match(src, /⌃p pin/, 'footer advertises pin');
  assert.match(src, /alt-# jump/, 'footer advertises the alt jump');
  assert.match(src, /⌃f refresh/, 'footer advertises the moved refresh');
  assert.match(src, /\? keys/, 'footer advertises the shortcut help');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
