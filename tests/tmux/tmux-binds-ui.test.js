// Drives the real tmux binds in dot_tmux.conf: a real tmux server on a private
// socket, attached by a real client inside the harness pty, driven with real keys.
//
// The harness pty IS the tmux client here, so what tmux paints is what the screen
// model parses -- no capture-pane involved (see tests/lib/pty.js on why capture-pane
// is the wrong tool).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Term, ptyAvailable, tierB, sleep } = require('../lib/pty');

const CONF = path.join(__dirname, '..', '..', 'home', 'dot_tmux.conf');

const missing = (t) => { try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); return false; } catch { return true; } };
const skip = tierB()
  || (!ptyAvailable() ? 'script(1) unavailable'
    : missing('tmux') ? 'tmux unavailable'
      : missing('zsh') ? 'zsh unavailable' : false);

const dirs = [];
const socks = [];
process.on('exit', () => {
  for (const s of socks) { try { execFileSync('tmux', ['-S', s, 'kill-server'], { stdio: 'ignore' }); } catch { /* already down */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// The binds run `agentview`; the stub stays alive so the window it opens persists
// long enough to be observed, and records the argv the bind passed it.
function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxui-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  const avLog = path.join(dir, 'agentview.log');
  fs.writeFileSync(path.join(bin, 'agentview'),
    `#!/bin/bash\necho "$*" >> ${JSON.stringify(avLog)}\necho AGENTVIEW-STUB-UP\nsleep 300\n`,
    { mode: 0o755 });

  // A prompt with no surprises, and the same C-Left binding dot_zshrc.tmpl installs --
  // the passthrough test needs the key to be visibly received, not just not-stolen.
  fs.writeFileSync(path.join(dir, '.zshrc'),
    "PS1='ZPROMPT> '\nbindkey -e\nbindkey -s '^[[1;5D' 'PASSTHRU'\n");

  const sock = path.join(dir, 'tmux.sock');
  socks.push(sock);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ZDOTDIR: dir,
    HOME: dir,
  };
  delete env.TMUX;
  return { dir, sock, avLog, env };
}

// `command` is what the first pane runs -- it decides which way the conditional
// C-Left bind resolves, since it matches on pane_current_command.
function attach({ sock, env }, command = 'zsh -i') {
  return new Term(
    ['tmux', '-S', sock, '-f', CONF, 'new-session', '-A', '-s', 'ui', command],
    { cols: 100, rows: 24, env },
  );
}

// Empty until the server is up, so it doubles as the "has tmux started" probe.
const windows = (sock) => {
  try {
    return execFileSync('tmux', ['-S', sock, 'list-windows', '-F', '#{window_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
};

const readLog = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// What the conditional bind actually matches on.
const paneCmd = (sock) => {
  try {
    return execFileSync('tmux', ['-S', sock, 'display-message', '-p', '#{pane_current_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
};

const hasWindow = (sock, name) => windows(sock).includes(name);

// Generous: this waits on a tmux server start AND a zsh start, and the suite runs its
// files in parallel. The default 5s was enough solo and intermittently short under load.
const waitPrompt = (term) => term.waitFor('ZPROMPT>', { timeout: 20000 });

test('prefix+g opens the agentview window', { skip }, async (t) => {
  const cfg = makeEnv();
  const term = attach(cfg);
  t.after(() => term.stop());

  await waitPrompt(term);
  term.send('ctrl-b', 'g');

  await term.waitFor('AGENTVIEW-STUB-UP');
  assert.ok(hasWindow(cfg.sock, 'agentview'), `windows: ${windows(cfg.sock).join(',')}`);
});

test('prefix+G opens a spawn window running agentview --spawn', { skip }, async (t) => {
  const cfg = makeEnv();
  const term = attach(cfg);
  t.after(() => term.stop());

  await waitPrompt(term);
  term.send('ctrl-b', 'G');

  await term.waitFor(() => hasWindow(cfg.sock, 'agentview-new'));
  await term.waitFor(() => /--spawn/.test(readLog(cfg.avLog)));
});

// The conditional bind: steal C-Left only when the pane is running something other
// than a shell. Both branches are asserted, because a bind that always fires and a
// bind that never fires each pass half of this on their own.
test('C-Left passes through to the shell at a prompt', { skip }, async (t) => {
  const cfg = makeEnv();
  const term = attach(cfg);
  t.after(() => term.stop());

  await waitPrompt(term);
  term.send('ctrl-left');

  await term.waitFor('PASSTHRU');
  assert.ok(!hasWindow(cfg.sock, 'agentview'), 'the key must not be stolen at a prompt');
});

test('C-Left over a non-shell process opens agentview', { skip }, async (t) => {
  const cfg = makeEnv();
  const term = attach(cfg, 'sleep 300');
  t.after(() => term.stop());

  // Nothing is painted by `sleep`, so wait on the server rather than the screen --
  // and wait for the command the bind matches on, not merely for the server to exist.
  await term.waitFor(() => paneCmd(cfg.sock) === 'sleep');
  term.send('ctrl-left');

  await term.waitFor('AGENTVIEW-STUB-UP');
  assert.ok(hasWindow(cfg.sock, 'agentview'), `windows: ${windows(cfg.sock).join(',')}`);
});

test('the status line carries the session name', { skip }, async (t) => {
  const cfg = makeEnv();
  const term = attach(cfg);
  t.after(() => term.stop());

  await waitPrompt(term);
  await sleep(50);
  assert.ok(term.screen.contains('ui'), `status line missing the session:\n${term.text()}`);
});
