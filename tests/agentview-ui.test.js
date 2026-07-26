// Drives the real agentview picker through a real pty: real fzf, real jq, real
// keystrokes, assertions against the rendered screen.
//
// This is the layer agentview-hotkeys.test.js cannot reach. That suite greps the
// --bind string out of the script and separately unit-tests the handler the bind
// names; neither proves a keypress actually arrives at that handler. These tests
// press the key and read what appears.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Term, ptyAvailable } = require('./lib/pty');
const { agentviewWinSeams } = require('./lib/agentview-env');

const SRC = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_agentview');
// The script sources its modules from ../share/agentview relative to its own path;
// the copy under test lives in a scratch bin/, so point it back at the source tree.
const LIB = path.join(__dirname, '..', 'home', 'dot_local', 'share', 'agentview');
const HOST = 'testbox';

const missing = (t) => { try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); return false; } catch { return true; } };
const skip = !ptyAvailable() ? 'script(1) unavailable'
  : missing('fzf') ? 'fzf unavailable'
    : missing('jq') ? 'jq unavailable' : false;

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const nowSec = () => Math.floor(Date.now() / 1000);

// The picker shells out to "$AGENTVIEW_SELF" for previews and hotkey binds, so
// the copy under test has to be executable -- chezmoi only sets +x on deploy.
function makeEnv() {
  const bin = scratch('avui-bin-');
  const home = scratch('avui-home-');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });

  const self = path.join(bin, 'agentview');
  fs.copyFileSync(SRC, self);
  fs.chmodSync(self, 0o755);

  const tmuxLog = path.join(bin, 'tmux.log');
  fs.writeFileSync(tmuxLog, '');
  fs.writeFileSync(path.join(bin, 'hostname'), `#!/bin/bash\necho ${HOST}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash\necho "$*" >> "$TMUX_LOG"\nexit 0\n`, { mode: 0o755 });
  // Present but inert: the picker fires a background remote refresh on open, and a
  // real ssh/curl here would cost a connect timeout per test.
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  // ctrl-x's confirm path calls `claude rm` on the real binary if it finds one.
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  // Without these the picker renders the operator's real Windows sessions beside the
  // fixtures and every row-position assertion below shifts. See tests/lib/agentview-env.js.
  const seams = agentviewWinSeams({ bin, scratch });

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    TMUX_LOG: tmuxLog,
    AGENTVIEW_SELF: self,
    AGENTVIEW_LIB: LIB,
    ...seams.env,
    AV_KILLCMD: 'true',   // the seam do_remove kills through; nothing real to signal here
  };
  delete env.TMUX;          // a bare pty: binds use execute, not execute-silent
  delete env.WEZTERM_PANE;
  delete env.FZF_DEFAULT_OPTS; // ambient opts from the user's shell would skew the render
  return { bin, home, env, self, tmuxLog };
}

function session(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}

// Two rows, one per state: 'working' also exercises the rename guard.
function seed(home) {
  const ts = nowSec();
  session(home, 'a', {
    pane: '%1', state: 'working', cwd: '/home/daniel/dev/alpha', host: HOST,
    ts: ts - 10, kind: 'host', title: 'alpha work', locator: `tmux:/tmp/s.sock:main:%1`,
  });
  session(home, 'b', {
    pane: '%2', state: 'idle', cwd: '/home/daniel/dev/beta', host: HOST,
    ts: ts - 60, kind: 'host', title: 'beta task', locator: `tmux:/tmp/s.sock:main:%2`,
  });
}

function open(env) {
  return new Term(['bash', env.AGENTVIEW_SELF], { cols: 110, rows: 30, env });
}

// agentview's --pointer is the same glyph fzf gutters every other row with, so
// the selected row is identified by --highlight-line's background instead.
function selectedLine(screen) {
  const rows = screen.highlightedRows();
  return rows.length ? screen.line(rows[0]).trim() : '';
}

const lineIndex = (term, needle) => term.text().split('\n').findIndex((l) => l.includes(needle));

const pinfile = (home) => path.join(home, '.claude', 'agent-view-pins');
const statefile = (home, sid) => path.join(home, '.claude', 'agent-view', `${sid}.json`);

// Narrow the list to one row so the bind under test acts on a known session.
async function focus(term, needle) {
  await term.waitFor('alpha');
  term.type(needle);
  await term.waitFor((s) => selectedLine(s).includes(needle));
}

test('picker renders the seeded sessions', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('alpha');
  const screen = term.screen;
  assert.ok(screen.contains('beta'), `beta row missing:\n${term.text()}`);
  assert.ok(screen.contains('WORKING'), `working state missing:\n${term.text()}`);
  assert.ok(screen.contains('IDLE'), `idle state missing:\n${term.text()}`);
  assert.ok(screen.contains('switch'), `footer hints missing:\n${term.text()}`);
});

test('typing filters the list down to the match', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('alpha');
  term.type('beta');
  await term.waitFor((s) => !s.contains('alpha'));
  assert.ok(term.screen.contains('beta'), `beta should survive the filter:\n${term.text()}`);
});

test('arrow keys move the selection', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor((s) => selectedLine(s).includes('alpha'));
  term.send('down');
  await term.waitFor((s) => selectedLine(s).includes('beta'));
  assert.ok(selectedLine(term.screen).includes('beta'));
});

test('ctrl-r reaches the rename prompt and sends /rename to the pane', { skip }, async (t) => {
  const { home, env, tmuxLog } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('alpha');
  term.type('beta');                     // rename refuses a 'working' session
  await term.waitFor((s) => !s.contains('alpha'));

  term.send('ctrl-r');
  await term.waitFor('new name>');       // the assertion the grep-based suite cannot make

  term.type('renamed-by-test');
  term.send('enter');

  await term.waitFor(() => /send-keys .*-l \/rename renamed-by-test/.test(fs.readFileSync(tmuxLog, 'utf8')));
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /-S \/tmp\/s\.sock send-keys -t %2 -l \/rename renamed-by-test/);
});

test('a mouse click selects the row that was clicked', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor((s) => selectedLine(s).includes('alpha'));

  // fzf enables SGR mouse reporting (?1000h/?1002h/?1006h) on startup, so this
  // is the same byte sequence a terminal sends when the user clicks the cell.
  const target = lineIndex(term, 'claude · beta');
  assert.ok(target > 0, `beta row not on screen:\n${term.text()}`);
  term.click(target + 1, 30);

  await term.waitFor((s) => selectedLine(s).includes('beta'));
  assert.ok(selectedLine(term.screen).includes('beta'));
});

test('enter switches to the selected session', { skip }, async (t) => {
  const { home, env, tmuxLog } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await focus(term, 'beta');
  term.send('enter');

  await term.waitFor(() => /select-pane -t %2/.test(fs.readFileSync(tmuxLog, 'utf8')));
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /-S \/tmp\/s\.sock select-pane -t %2/);
  assert.equal(await term.waitForExit(), 0);
});

// alt-N counts the same rows the gutter numbers, so alt-2 must land on the second
// rendered row -- beta, since 'working' sorts above 'idle'.
test('alt-2 jumps to the second rendered row', { skip }, async (t) => {
  const { home, env, tmuxLog } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor((s) => selectedLine(s).includes('alpha'));
  term.send('alt-2');

  await term.waitFor(() => /select-pane -t %2/.test(fs.readFileSync(tmuxLog, 'utf8')));
  assert.doesNotMatch(fs.readFileSync(tmuxLog, 'utf8'), /select-pane -t %1/);
});

test('ctrl-p pins the row into the PINNED group', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  // No query here: the group headers are rows with an empty key, so any filter hides
  // the very header this asserts on.
  await term.waitFor((s) => selectedLine(s).includes('alpha'));
  term.send('down');
  await term.waitFor((s) => selectedLine(s).includes('beta'));
  assert.ok(!term.screen.contains('PINNED'), `nothing should be pinned yet:\n${term.text()}`);

  term.send('ctrl-p');
  await term.waitFor('PINNED');   // the bind's reload re-renders with the new group

  assert.match(fs.readFileSync(pinfile(home), 'utf8'), /\S/);
});

test('ctrl-o toggles the preview card', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await focus(term, 'beta');
  assert.ok(!term.screen.contains('Machine'), `preview starts hidden:\n${term.text()}`);

  term.send('ctrl-o');
  await term.waitFor('Machine');
  assert.ok(term.screen.contains('beta task'), `card should name the task:\n${term.text()}`);

  term.send('ctrl-o');
  await term.waitFor((s) => !s.contains('Machine'));
});

test('? opens the shortcut cheatsheet', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  // Wait for the settled selection, not merely for the row text: fzf's load bind fires
  // a --skip transform chain that walks the cursor off the group header, and every
  // cursor move refreshes the preview -- which would overwrite the cheatsheet with the
  // card if the key landed mid-chain.
  await term.waitFor((s) => selectedLine(s).includes('alpha'));
  term.send('?');

  await term.waitFor('pin / unpin to top');
  assert.ok(term.screen.contains('shortcuts'), `cheatsheet title missing:\n${term.text()}`);
});

// The confirm chooser is a second fzf that REPLACES the picker (outside tmux the bind
// runs under execute(), which clears the window first) -- so this also proves the
// harness survives one TUI handing off to another in the same pty.
test('ctrl-x cancel leaves the session alone', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await focus(term, 'beta');
  term.send('ctrl-x');
  await term.waitFor('remove session');

  term.send('esc');
  await term.waitFor((s) => s.contains('beta') && !s.contains('remove session'));
  assert.ok(fs.existsSync(statefile(home, 'b')), 'cancel must not delete the session');
});

test('ctrl-x confirm removes the session', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await focus(term, 'beta');
  term.send('ctrl-x');
  await term.waitFor('remove session');

  // Cancel is deliberately the first row, so a stray enter can't destroy a session.
  await term.waitFor((s) => selectedLine(s).includes('Cancel'));
  term.send('down');
  await term.waitFor((s) => selectedLine(s).includes('Remove'));
  term.send('enter');

  await term.waitFor(() => !fs.existsSync(statefile(home, 'b')));
  assert.ok(fs.existsSync(statefile(home, 'a')), 'only the chosen row may be removed');
});

test('esc closes the picker', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('alpha');
  term.send('esc');

  assert.equal(await term.waitForExit(), 0);
});
