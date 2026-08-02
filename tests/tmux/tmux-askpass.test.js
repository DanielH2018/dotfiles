// Behavioral tests for `tmux-askpass` (executable_tmux-askpass) — the SUDO_ASKPASS
// helper that prompts in a tmux popup on hosts with no graphical session.
//
// The failure modes worth pinning down are all silent ones: sudo cannot tell an empty
// answer from a wrong password, so a helper that dies quietly looks to the user like a
// mistyped password. Hence the loud exits when there is no tmux or no attached client,
// and the bounded read so an unanswered popup releases sudo instead of wedging the caller.
//
// Seams: a stub `tmux` at the front of PATH (no real server is touched), XDG_RUNTIME_DIR
// pointed at a scratch dir, TMUX_ASKPASS_TIMEOUT to keep the unanswered case fast.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ASKPASS = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_tmux-askpass');

const dirs = [];
function scratch(p) { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

// The stub stands in for tmux itself: `list-clients` reports whoever FAKE_TMUX_CLIENTS
// says is attached, and `display-popup` runs the popup half of the script the way tmux
// would — via `sh -c`, with a tty-less stdin carrying the "typed" password.
const STUB_TMUX = `#!/bin/sh
case "$1" in
  list-clients)
    [ -n "\${FAKE_TMUX_CLIENTS:-}" ] && printf '%s\\n' "$FAKE_TMUX_CLIENTS"
    exit 0
    ;;
  display-popup)
    if [ -n "\${FAKE_TMUX_FAIL:-}" ]; then
      echo "no client to draw on" >&2
      exit 1
    fi
    for a in "$@"; do cmd=$a; done
    printf '%s' "$cmd" >"$FAKE_TMUX_CMDLOG"
    # A popup that is never answered: created, then closed without writing anything.
    [ -n "\${FAKE_TMUX_UNANSWERED:-}" ] && exit 0
    # Escape / Ctrl-C: the popup runs but there is no input to read.
    if [ -n "\${FAKE_TMUX_CANCEL:-}" ]; then
      sh -c "$cmd" </dev/null >"$FAKE_TMUX_POPUPLOG" 2>&1
      exit 0
    fi
    printf '%s\\n' "$FAKE_TMUX_PASSWORD" | sh -c "$cmd" >"$FAKE_TMUX_POPUPLOG" 2>&1
    ;;
esac
`;

// Returns { run, runtime, popupLog, cmdLog } for one isolated invocation environment.
function fakeEnv({ clients = 'client-0', password = 'hunter2', ...flags } = {}) {
  const home = scratch('askpass-');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tmux'), STUB_TMUX, { mode: 0o755 });
  // Run a deployed-style copy: sources are 0644 in the repo (chezmoi's `executable_`
  // prefix sets the mode on apply), and the popup half re-executes the script by path.
  const deployed = path.join(bin, 'tmux-askpass');
  fs.copyFileSync(ASKPASS, deployed);
  fs.chmodSync(deployed, 0o755);
  const runtime = path.join(home, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const popupLog = path.join(home, 'popup.log');
  const cmdLog = path.join(home, 'cmd.log');

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMUX: '/tmp/tmux-1000/default,123,0',
    XDG_RUNTIME_DIR: runtime,
    TMUX_ASKPASS_TIMEOUT: '3',
    FAKE_TMUX_CLIENTS: clients,
    FAKE_TMUX_PASSWORD: password,
    FAKE_TMUX_POPUPLOG: popupLog,
    FAKE_TMUX_CMDLOG: cmdLog,
    ...flags,
  };

  const run = (args = [], overrides = {}) => {
    try {
      const stdout = execFileSync(deployed, args, {
        env: { ...env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (e) {
      return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  return { run, runtime, popupLog: () => fs.readFileSync(popupLog, 'utf8'), cmdLog: () => fs.readFileSync(cmdLog, 'utf8') };
}

test('hands back the password typed into the popup', () => {
  const { run } = fakeEnv({ password: 'hunter2' });
  const r = run(['[sudo] password for ubuntu: ']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hunter2\n');
});

test('preserves a password containing spaces and shell metacharacters', () => {
  const pw = 'a b$c "d" `e` \\f';
  const { run } = fakeEnv({ password: pw });
  const r = run(['Password: ']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${pw}\n`);
});

test("passes sudo's prompt through to the popup, quotes and all", () => {
  const { run, popupLog } = fakeEnv();
  const prompt = "[sudo] daniel's password: ";
  const r = run([prompt]);
  assert.equal(r.code, 0);
  assert.match(popupLog(), /\[sudo\] daniel's password: /);
});

// The shell running Claude Code's `!` commands descends from the Claude daemon, which on
// daniel-box was started before the tmux server it now hosts panes for — so $TMUX is set
// in the pane and absent everywhere it would have been useful. tmux itself doesn't need
// it: with no $TMUX the CLI talks to the default socket and draws on the most recently
// active client, which is the one being typed in.
test('works with $TMUX unset, as in a daemon-hosted session', () => {
  const { run } = fakeEnv({ password: 'hunter2' });
  const r = run(['Password: '], { TMUX: '' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hunter2\n');
});

test('refuses when the tmux server has no attached client', () => {
  const { run } = fakeEnv({ clients: '' });
  const r = run(['Password: ']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no attached tmux client/);
  assert.equal(r.stdout, '');
});

test('surfaces display-popup failure on stderr rather than hanging', () => {
  const { run } = fakeEnv({ FAKE_TMUX_FAIL: '1' });
  const r = run(['Password: ']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /display-popup failed: no client to draw on/);
});

test('a cancelled popup returns an empty answer promptly', () => {
  const { run } = fakeEnv({ FAKE_TMUX_CANCEL: '1' });
  const started = Date.now();
  const r = run(['Password: ']);
  assert.equal(r.stdout, '\n');
  assert.ok(Date.now() - started < 3000, 'should not wait out the read timeout');
});

test('an unanswered popup releases the caller at the timeout', () => {
  const { run } = fakeEnv({ FAKE_TMUX_UNANSWERED: '1' });
  const r = run(['Password: '], { TMUX_ASKPASS_TIMEOUT: '1' });
  assert.equal(r.stdout, '');
  assert.equal(r.code, 124); // timeout(1)
});

test('leaves no password FIFO behind under XDG_RUNTIME_DIR', () => {
  const { run, runtime } = fakeEnv();
  run(['Password: ']);
  assert.deepEqual(fs.readdirSync(runtime), []);
});

test('re-executes itself by absolute path so the popup can find it', () => {
  const { run, cmdLog } = fakeEnv();
  run(['Password: ']);
  const cmd = cmdLog();
  assert.match(cmd, /^\//, `popup command should start with an absolute path: ${cmd}`);
  assert.match(cmd, /--popup/);
});
