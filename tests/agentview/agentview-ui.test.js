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
const { Term, ptySkip } = require('../lib/pty');
const { agentviewWinSeams } = require('../lib/agentview-env');

const SRC = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_agentview');
// The script sources its modules from ../share/agentview relative to its own path;
// the copy under test lives in a scratch bin/, so AGENTVIEW_LIB has to point elsewhere.
const LIB = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview');
const HOST = 'testbox';

const missing = (t) => { try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); return false; } catch { return true; } };
const skip = ptySkip()
  || (missing('fzf') ? 'fzf unavailable'
    : missing('jq') ? 'jq unavailable' : false);

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

  // Snapshot the modules alongside the launcher instead of pointing at the live source.
  // The launcher is copied once here, but AGENTVIEW_LIB is re-read by every `--body`
  // subprocess the picker spawns, so a checkout that moves mid-run -- `bin/try` switching
  // the primary checkout's branch is the way that happens -- hands one run two vintages of
  // the row format. That mismatch is exactly the tab-column skew these tests exist to
  // catch, and it would arrive as unexplained flake rather than a failure pointing at it.
  const lib = path.join(bin, 'share', 'agentview');
  fs.cpSync(LIB, lib, { recursive: true });

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
    AGENTVIEW_LIB: lib,
    ...seams.env,
    AV_KILLCMD: 'true',   // the seam do_remove kills through; nothing real to signal here
  };
  delete env.TMUX;          // a bare pty: binds use execute, not execute-silent
  delete env.WEZTERM_PANE;
  delete env.FZF_DEFAULT_OPTS; // ambient opts from the user's shell would skew the render
  return { bin, home, env, self, lib, tmuxLog };
}

function session(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}

// N completed + M idle sessions, named so their leaf dir (what the row renders) is
// distinctive. ts stays within the last day: gather_local_rows (rows.sh) HIDES a row
// aged 1-7 days and PRUNES it past 7, so anything older would silently vanish from
// both the collapsed count and the expanded rows.
function seedFinished(home, { completed = 0, idle = 0 } = {}) {
  const ts = nowSec();
  for (let i = 1; i <= completed; i++) {
    session(home, `completed-session-${i}`, {
      pane: `%c${i}`, state: 'completed', cwd: `/home/daniel/dev/completed-session-${i}`, host: HOST,
      ts: ts - 100 - i, kind: 'host', title: '', locator: `tmux:/tmp/s.sock:main:%c${i}`,
    });
  }
  for (let i = 1; i <= idle; i++) {
    session(home, `idle-session-${i}`, {
      pane: `%i${i}`, state: 'idle', cwd: `/home/daniel/dev/idle-session-${i}`, host: HOST,
      ts: ts - 500 - i, kind: 'host', title: '', locator: `tmux:/tmp/s.sock:main:%i${i}`,
    });
  }
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
  // idle collapses behind a fold line by default (task 6); every test below drives beta
  // directly by keystroke/click, so pre-expand it here rather than in each caller.
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'idle\n');
}

function open(env) {
  return new Term(['bash', env.AGENTVIEW_SELF], { cols: 110, rows: 30, env });
}

// The selected row is identified by --highlight-line's background rather than by the
// pointer glyph: fzf paints its own ▌ down the gutter of every non-current row, so a
// pointer-glyph search would match all of them, whatever --pointer is set to.
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
  assert.ok(screen.contains('switch/fold'), `footer hints missing:\n${term.text()}`);
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
  // idle is pre-expanded (seed() above), and its header now carries a landable fold: key
  // (Important 1) so it can be re-collapsed -- the first down lands there, same as any other
  // real row would, and a second down continues on to beta.
  await term.waitFor((s) => selectedLine(s).includes('IDLE'));
  term.send('down');
  await term.waitFor((s) => selectedLine(s).includes('beta'));
  assert.ok(selectedLine(term.screen).includes('beta'));
});

// --track: the cursor must follow the SESSION across a repaint, not its row index.
// Parking the tracked row LAST would make this pass whether or not tracking works --
// fzf clamps a shorter/reordered list to the end regardless -- so this targets a
// genuine MIDDLE row (rows above and below it, in both expanded groups) and forces a
// real REORDER (not just a text change), so a plain index-based reload lands on a
// different session than the one that was selected.
test('the cursor follows the tracked session across a reload, not its row index', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seedFinished(home, { completed: 3, idle: 2 });
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'completed\nidle\n');
  const term = open(env);
  t.after(() => term.stop());

  // The first landable row is COMPLETED's own header (a landable fold: key) -- two downs
  // land on completed-session-2, which has a header and a sibling above it, and a sibling
  // plus the whole IDLE group below it.
  await term.waitFor((s) => selectedLine(s).includes('COMPLETED'));
  term.send('down');
  await term.waitFor((s) => selectedLine(s).includes('completed-session-1'));
  term.send('down');
  await term.waitFor((s) => selectedLine(s).includes('completed-session-2'));

  // Age session-2 past session-3, so the ts-desc sort sinks it below its sibling -- the
  // KEY changes (it embeds ts) but the session's identity (host+cwd+kind) does not. Stays
  // well under a day: gather_local_rows HIDES anything 1-7 days old (seedFinished's own
  // comment), and a hidden row would vanish instead of reordering.
  const sf = statefile(home, 'completed-session-2');
  const state = JSON.parse(fs.readFileSync(sf, 'utf8'));
  state.ts = nowSec() - 1000;
  fs.writeFileSync(sf, JSON.stringify(state));

  term.send('ctrl-f');   // fires reload('...' --body), the same action the live --watch loop posts
  await term.waitFor((s) => {
    const lines = s.text().split('\n');
    const i2 = lines.findIndex((l) => l.includes('completed-session-2'));
    const i3 = lines.findIndex((l) => l.includes('completed-session-3'));
    return i2 >= 0 && i3 >= 0 && i3 < i2;   // the reorder has actually landed
  });

  assert.ok(selectedLine(term.screen).includes('completed-session-2'),
    `cursor should stay on session-2 after it moved rows, got:\n${term.text()}`);
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

  // Wait for the LAST of the three tmux calls do_rename makes, not the middle one. It writes
  // load-buffer, then paste-buffer, then send-keys Enter (actions.sh:323-328); waiting on
  // paste-buffer let the assertions below run in the gap before the Enter was logged, which
  // failed under the parallel load of a full-suite run and passed on its own.
  await term.waitFor(() => /send-keys -t %2 Enter/.test(fs.readFileSync(tmuxLog, 'utf8')));
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /-S \/tmp\/s\.sock load-buffer -b \S+ /, 'the name goes through a buffer, not send-keys -l');
  assert.match(log, /-S \/tmp\/s\.sock send-keys -t %2 Enter/, 'and the Enter follows on its own');
});

test('a mouse click selects the row that was clicked', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seed(home);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor((s) => selectedLine(s).includes('alpha'));

  // fzf enables SGR mouse reporting (?1000h/?1002h/?1006h) on startup, so this
  // is the same byte sequence a terminal sends when the user clicks the cell.
  const target = lineIndex(term, 'beta');
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

  // No query here: a plain group header is a row with an empty key, so any filter hides
  // the very header this asserts on.
  await term.waitFor((s) => selectedLine(s).includes('alpha'));
  term.send('down');
  // idle is pre-expanded (seed()), so its header is now landable (Important 1) and the
  // first down stops there; a second down continues on to beta.
  await term.waitFor((s) => selectedLine(s).includes('IDLE'));
  term.send('down');
  await term.waitFor((s) => selectedLine(s).includes('beta'));
  assert.ok(!term.screen.contains('PINNED'), `nothing should be pinned yet:\n${term.text()}`);

  term.send('ctrl-p');
  await term.waitFor('PINNED');   // the bind's reload re-renders with the new group

  assert.match(fs.readFileSync(pinfile(home), 'utf8'), /\S/);
});

// The picker's own inline startup block (executable_agentview) calls fold_seen_states before
// its first fzf frame, but every reload after that -- every key bind via --repaint, and the
// background remote-refresh poster that fires ~1s after open -- goes through render_body()
// (render.sh), a separate function. When the two fell out of sync a completed row the seen
// sidecar marks unwatched rendered DONE on frame 1 and reverted to plain COMPLETED the moment
// anything reloaded the list -- which happens automatically, unprompted, every time.
test('a DONE row stays DONE once the background refresh reloads the list', { skip }, async (t) => {
  const { home, env } = makeEnv();
  const ts = nowSec() - 100;
  session(home, 'unwatched', {
    pane: '%9', state: 'completed', cwd: '/home/daniel/dev/unwatched', host: HOST,
    ts, kind: 'host', title: '', locator: 'tmux:/tmp/s.sock:main:%9',
  });
  const US = '\x1f';
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-seen'),
    [HOST, '/home/daniel/dev/unwatched', 'host'].join(US) + `\t${ts - 500}\n`);

  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('DONE');
  assert.ok(!term.screen.contains('COMPLETED'),
    `first frame should classify the row as DONE, got:\n${term.text()}`);

  // Prove a reload actually lands, without touching the row under test: a second, unrelated
  // session written just before ctrl-f can only appear once render_body() re-gathers rows.
  session(home, 'proof', {
    pane: '%8', state: 'working', cwd: '/home/daniel/dev/proof', host: HOST,
    ts: nowSec(), kind: 'host', title: 'proof task', locator: 'tmux:/tmp/s.sock:main:%8',
  });
  term.send('ctrl-f');   // fires reload('...' --body), the same action the background poster sends
  await term.waitFor('proof task');

  assert.ok(term.screen.contains('DONE'), `row should still be DONE after the reload, got:\n${term.text()}`);
  assert.ok(!term.screen.contains('COMPLETED'),
    `row must not revert to COMPLETED after the reload, got:\n${term.text()}`);
});

test('completed and idle collapse to one line each by default', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seedFinished(home, { completed: 3, idle: 2 });
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('COMPLETED');
  assert.ok(lineIndex(term, 'COMPLETED (3)') >= 0, `expected a collapsed line, got:\n${term.text()}`);
  assert.ok(lineIndex(term, 'IDLE (2)') >= 0, `expected a collapsed line, got:\n${term.text()}`);
  assert.strictEqual(lineIndex(term, 'completed-session-1'), -1, 'collapsed rows must not render');
});

test('an expanded group renders its rows', { skip }, async (t) => {
  const { home, env } = makeEnv();
  seedFinished(home, { completed: 3, idle: 2 });
  fs.writeFileSync(path.join(home, '.claude', 'agent-view-folds'), 'completed\n');
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('completed-session-1');
  assert.ok(lineIndex(term, 'completed-session-1') >= 0, 'an expanded group renders its rows');
  assert.strictEqual(lineIndex(term, 'idle-session-1'), -1, 'idle stays collapsed');
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

const statusfile = (home, host) => path.join(home, `.agentview-remote-status.${host}`);

// makeEnv()'s ssh stub exits 0 immediately, which the picker's background refresh reads as a
// real (if empty) roster -- it legitimately overwrites the status/cache it just fetched. That
// races a test that pre-seeds a status file and asserts on ITS content: the seed can lose to
// the background rewrite before the assertion runs. Sleeping instead of exiting keeps the ssh
// call outstanding for the test's lifetime, so the seeded fixture is the only thing rendered.
// 300s, well past any waitFor budget in this suite -- term.stop() SIGKILLs the process group,
// so nothing is left running past the test.
function stubSlowSsh(bin) {
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\nsleep 300\n', { mode: 0o755 });
}

test('an unreachable host renders a status row instead of going quiet', { skip }, async (t) => {
  const { bin, home, env } = makeEnv();
  stubSlowSsh(bin);
  fs.writeFileSync(statusfile(home, 'daniel-box'), `unreachable\t${nowSec()}\n`);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('unreachable');
  assert.ok(lineIndex(term, 'Box · unreachable') >= 0,
    `expected an unreachable row for Box, got:\n${term.text()}`);
});

test('a stale-but-ok host is labelled with its age', { skip }, async (t) => {
  const { bin, home, env } = makeEnv();
  stubSlowSsh(bin);
  fs.writeFileSync(statusfile(home, 'daniel-server'), `ok\t${nowSec() - 360}\n`);
  const term = open(env);
  t.after(() => term.stop());

  // Wait for the EXACT string the assertion checks, not a weaker prefix: waiting on a looser
  // match (even a specific-enough substring like ' old') can resolve on a transient partial
  // repaint that hasn't finished laying out the row yet, so the assert right after can lose to
  // a reflow that hasn't settled -- this test was flaky against that looser probe.
  await term.waitFor((s) => s.contains('Homelab · 6m old'));
  assert.ok(lineIndex(term, 'Homelab · 6m old') >= 0,
    `expected a 6m age on Homelab, got:\n${term.text()}`);
});

test('a fresh ok host adds no chrome', { skip }, async (t) => {
  const { bin, home, env } = makeEnv();
  stubSlowSsh(bin);
  fs.writeFileSync(statusfile(home, 'daniel-server'), `ok\t${nowSec()}\n`);
  const term = open(env);
  t.after(() => term.stop());

  await term.waitFor('no active Claude sessions');
  assert.strictEqual(lineIndex(term, 'unreachable'), -1, 'a healthy host should be silent');
  assert.strictEqual(lineIndex(term, 'fetch failed'), -1, 'a healthy host should be silent');
  // ' old' (leading space), not bare 'old': the footer's '↵ switch/fold' hint contains the
  // bare substring 'old' inside 'fold', which a fresh host's silence does not disprove.
  assert.strictEqual(lineIndex(term, ' old'), -1, 'a fresh host should carry no age chrome');
});

// ---- the EXIT trap ----
// The picker detaches two children before fzf starts: --refresh-remote (short-lived) and
// --watch (loops forever -- nothing about fzf closing makes it exit). A survivor holds the
// picker's pty open, which is the shape of the old CTRL+W hang. The trap is the only thing
// that reaps them.
//
// The obvious test does not work. Quitting closes the pty, and the kernel SIGHUPs the
// foreground process group -- so the children die whether or not the trap exists. The first
// version of this test asserted "the watcher is gone afterwards" and stayed GREEN with the
// trap's kill deleted: it was measuring process-group teardown, not the code under test.
//
// So the --watch child is intercepted by a stub that IGNORES SIGHUP and records SIGTERM.
// Once teardown cannot reap it, the trap's explicit kill is the only thing that can.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const until = async (fn, tries = 120) => {
  for (let i = 0; i < tries; i++) { if (fn()) return true; await sleepMs(50); }
  return false;
};

test('the EXIT trap signals the picker\'s background children and clears its portfile', { skip }, async (t) => {
  const { env, home, bin, self } = makeEnv();
  seed(home);

  const marker = path.join(home, 'watch-signalled');
  const pidfile = path.join(home, 'watch-pid');
  // Stands in for $SELF everywhere but only changes behaviour for --watch; every other
  // invocation (the picker itself, previews, --body reloads) execs the real script, so the
  // code under test is unmodified.
  const stub = path.join(bin, 'agentview-selfstub');
  fs.writeFileSync(stub, `#!/bin/bash
if [ "\${1:-}" = "--watch" ]; then
  trap '' HUP
  trap 'printf term > ${JSON.stringify(marker)}; exit 0' TERM
  echo $$ > ${JSON.stringify(pidfile)}
  while :; do sleep 0.05; done
fi
exec ${JSON.stringify(self)} "$@"
`, { mode: 0o755 });

  const term = new Term(['bash', stub], { cols: 110, rows: 30, env: { ...env, AGENTVIEW_SELF: stub } });
  t.after(() => {
    term.stop();
    // SIGKILL, not the stub's ignorable signals: a failed assertion must not leak a spinner.
    try { process.kill(Number(fs.readFileSync(pidfile, 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ }
  });

  await term.waitFor('alpha');
  assert.ok(await until(() => fs.existsSync(pidfile)), 'the picker should spawn a --watch child');
  const watchPid = fs.readFileSync(pidfile, 'utf8').trim();
  const portfiles = () => fs.readdirSync(home).filter((f) => f.startsWith('.agentview-fzfport.'));
  assert.ok(portfiles().length, 'the picker should write a portfile while open');

  // Natural exit. term.stop() would SIGKILL the group and prove nothing.
  term.send('esc');
  assert.notStrictEqual(await term.waitForExit({ timeout: 8000 }), null, 'the picker should exit');

  assert.ok(await until(() => fs.existsSync(marker)),
    'the trap must send SIGTERM to the watch child (pty teardown alone cannot reap it here)');
  assert.ok(await until(() => !alive(watchPid)), `the watch child ${watchPid} outlived the picker`);
  assert.deepStrictEqual(portfiles(), [], 'the trap must remove the portfile');
});

test('a picker whose row format changes under it restarts instead of skewing', { skip }, async (t) => {
  // The failure this prevents, exactly: a493a71 added a column and moved --with-nth from
  // 2.. to 3.., and every picker already open rendered the new field 2 -- the \x1f-joined
  // host/cwd/kind identity -- as display text. Asserting that --repaint prints "become("
  // would pass while the screen still showed that, so this drives the real picker and
  // reads the real screen.
  const env = makeEnv();
  seed(env.home);
  const term = open(env.env);
  t.after(() => term.stop());

  await term.waitFor('alpha');

  // Model a REAL upgrade, which moves both halves at once: the rows gain a leading field
  // AND the launcher's --with-nth moves to match. Changing only the rows would skew the
  // restarted picker too, so it could never tell a restart from a reload.
  const render = path.join(env.lib, 'render.sh');
  fs.appendFileSync(render, [
    '',
    '# test-only: shift every row one field to the right',
    'eval "orig_build_pretty() $(declare -f build_pretty | sed \'1d\')"',
    'build_pretty() { orig_build_pretty "$@" | sed \'s/^/EXTRA\\t/\'; }',
    '',
  ].join('\n'));

  // The border label is read from render.sh but baked into fzf's ARGV at launch, so it can
  // only change in a process that started after the edit. That makes it the proof that a
  // restart actually happened -- a reload cannot produce it however the rows come out.
  const MARK = 'UPGRADED-PICKER';
  fs.writeFileSync(render, fs.readFileSync(render, 'utf8').replace(/^LABEL=.*$/m, `LABEL=' ${MARK} '`));
  fs.writeFileSync(env.self, fs.readFileSync(env.self, 'utf8').replace('--with-nth=3..', '--with-nth=4..'));

  term.send('ctrl-f');

  // Waiting on the marker is what makes this test able to fail: with the fingerprint
  // pinned no restart happens, the label never changes, and this times out.
  // The row has to be in the same wait: the border is drawn at startup but the rows arrive
  // with the first --body, so under a full parallel run the marker alone let the assertions
  // fire against a picker that had restarted but not yet listed anything.
  await term.waitFor((s) => s.contains(MARK) && s.contains('alpha'));
  const screen = term.text();

  // And the restarted picker reads the new format correctly. The full cwd is display text
  // ONLY when the columns have skewed -- an intact row shows the leaf name, and the full
  // path lives in the CTRL+O card.
  assert.ok(
    !screen.includes('/home/daniel/dev/alpha'),
    `an identity field leaked into the display:\n${screen}`,
  );
  assert.ok(screen.includes('alpha'), 'the session row must still be there after the restart');
});
