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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');
const { run: spawnScript } = require('../lib/run');

const ASKPASS = srcPath('dot_local', 'bin', 'executable_tmux-askpass');

// The helper's last line is `timeout ... head -n 1 <&3`, and timeout(1) is GNU coreutils, which
// a stock Mac does not have and this repo never asks for (not in Brewfile.tmpl, not a row in
// .chezmoidata/tools.toml). Every path that reaches the bounded read therefore exits 127 there,
// which is the harness reporting a missing tool, not the helper misbehaving.
//
// Gated rather than made portable because the helper only ever runs on the headless Linux hosts:
// settings.base.json sets SUDO_ASKPASS to it for those hosts only, ~/.zshenv prefers ksshaskpass
// wherever a graphical session exists, and .chezmoiignore keeps the sudo shim that pairs with it
// off every other machine. A BSD fallback would be code for a call site that does not exist.
// Four tests stay live everywhere and keep this from being a blanket file skip: the two
// loud-exit paths return before the read, and the FIFO-cleanup and absolute-path ones assert
// state the helper leaves behind whatever the read's exit status was.
const skipTimeout = process.platform === 'linux' ? false : 'bounded read needs GNU timeout(1); helper targets headless Linux';

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
  const home = scratch(os.tmpdir(), 'askpass-');
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

  const run = (args = [], overrides = {}) => spawnScript(deployed, args, { env: { ...env, ...overrides } });

  return { run, runtime, popupLog: () => fs.readFileSync(popupLog, 'utf8'), cmdLog: () => fs.readFileSync(cmdLog, 'utf8') };
}

test('hands back the password typed into the popup', { skip: skipTimeout }, () => {
  const { run } = fakeEnv({ password: 'hunter2' });
  const r = run(['[sudo] password for ubuntu: ']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hunter2\n');
});

test('preserves a password containing spaces and shell metacharacters', { skip: skipTimeout }, () => {
  const pw = 'a b$c "d" `e` \\f';
  const { run } = fakeEnv({ password: pw });
  const r = run(['Password: ']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${pw}\n`);
});

test("passes sudo's prompt through to the popup, quotes and all", { skip: skipTimeout }, () => {
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
test('works with $TMUX unset, as in a daemon-hosted session', { skip: skipTimeout }, () => {
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

test('a cancelled popup returns an empty answer promptly', { skip: skipTimeout }, () => {
  const { run } = fakeEnv({ FAKE_TMUX_CANCEL: '1' });
  const started = Date.now();
  const r = run(['Password: ']);
  assert.equal(r.stdout, '\n');
  assert.ok(Date.now() - started < 3000, 'should not wait out the read timeout');
});

test('an unanswered popup releases the caller at the timeout', { skip: skipTimeout }, () => {
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
