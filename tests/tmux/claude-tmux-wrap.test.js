// Regression guard for the bare-terminal claude() wrapper in shell/common.sh: an
// interactive TUI start with no mux underneath wraps in a status-less tmux session
// (so the C-Left back-to-Agent-View bind exists there), and EVERY other invocation —
// inside tmux/wezterm, non-TUI subcommands, pipes — reaches the real binary untouched.
// Extracts the ACTUAL function from the source and drives it with stub tmux/claude on
// PATH, in bash and (when present) zsh — the two shells that source common.sh.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMMON = path.join(__dirname, '..', '..', 'home', 'dot_config', 'shell', 'common.sh');

function have(cmd) { try { execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } }
const zshSkip = have('zsh') ? false : 'zsh unavailable';
const tmuxSkip = have('tmux') ? false : 'tmux unavailable';

// The function under test, lifted verbatim from common.sh (first ^claude() { .. ^}).
const fnMatch = fs.readFileSync(COMMON, 'utf8').match(/^claude\(\) \{\n[\s\S]*?\n\}/m);
assert.ok(fnMatch, 'claude() exists in common.sh');
const FN = fnMatch[0];

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// Stub bin: tmux + claude log their argv; the wrap path must never run the real ones.
function makeEnv() {
  const bin = scratch('cwrap-bin-');
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const claudeLog = path.join(bin, 'claude.log'); fs.writeFileSync(claudeLog, '');
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\necho "$*" >> "$TMUX_LOG"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/bash\necho "$*" >> "$CLAUDE_LOG"\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_LOG: tmuxLog, CLAUDE_LOG: claudeLog };
  delete env.TMUX; delete env.WEZTERM_PANE; delete env.CLAUDE_WRAP_TTY; delete env.WSL_DISTRO_NAME;
  return { bin, env, tmuxLog, claudeLog };
}
const read = (p) => fs.readFileSync(p, 'utf8');

function run(shell, env, args, extraEnv = {}) {
  const argv = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  execFileSync(shell, ['-c', `${FN}\nclaude ${argv}`], { env: { ...env, ...extraEnv }, stdio: 'ignore', timeout: 10000 });
}

// Like run(), but pins the shell's cwd and $HOME so the wrapper's "$HOME -> ~/dev"
// redirect (Claude Code's trust prompt never persists for a $HOME workspace) is testable.
function runIn(shell, env, { args = [], extraEnv = {}, cwd, home }) {
  const argv = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const e = { ...env, ...extraEnv };
  if (home) e.HOME = home;
  if (cwd) e.PWD = cwd;
  execFileSync(shell, ['-c', `${FN}\nclaude ${argv}`], { env: e, cwd, stdio: 'ignore', timeout: 10000 });
}

test('a bare interactive start wraps: detached create, status off, then attach', () => {
  const { env, tmuxLog, claudeLog } = makeEnv();
  run('bash', env, [], { CLAUDE_WRAP_TTY: '1' });
  const log = read(tmuxLog);
  assert.match(log, /new-session -d -s claude-\d+ -c \S+ claude/, 'creates a detached session running claude in a cwd');
  assert.match(log, /set-option -t claude-\d+ status off/, 'hides the status line before the attach');
  assert.match(log, /attach-session -t claude-\d+/, 'then attaches this terminal');
  assert.strictEqual(read(claudeLog), '', 'claude runs inside tmux, never directly');
});

test('inside tmux the wrapper passes through (the C-Left bind already exists)', () => {
  const { env, tmuxLog, claudeLog } = makeEnv();
  run('bash', env, [], { CLAUDE_WRAP_TTY: '1', TMUX: '/tmp/sock,1,0' });
  assert.strictEqual(read(tmuxLog), '', 'no nested tmux session');
  assert.match(read(claudeLog), /^$|^\n$/, 'the real claude runs with its own (empty) args');
});

test('a native wezterm pane passes through (the wezterm keybind owns C-Left)', () => {
  const { env, tmuxLog } = makeEnv();
  run('bash', env, [], { CLAUDE_WRAP_TTY: '1', WEZTERM_PANE: '7' });
  assert.strictEqual(read(tmuxLog), '', 'WEZTERM_PANE suppresses the wrap');
});

// wezterm.lua.tmpl does NOT handle C-Left itself in a WSL pane — it can't see the pane's
// foreground process through wsl.exe, so it forwards the key and lets tmux decide. That
// makes tmux mandatory there. WEZTERM_PANE now crosses into WSL (it is in WSLENV), so it
// no longer means "an outer layer owns the key"; only a non-WSL wezterm pane does.
test('a wezterm WSL pane still wraps (wezterm forwards C-Left to tmux there)', () => {
  const { env, tmuxLog, claudeLog } = makeEnv();
  run('bash', env, [], { CLAUDE_WRAP_TTY: '1', WEZTERM_PANE: '7', WSL_DISTRO_NAME: 'Ubuntu' });
  assert.match(read(tmuxLog), /new-session -d -s claude-\d+/, 'a WSL pane needs the tmux layer to catch C-Left');
  assert.strictEqual(read(claudeLog), '', 'claude runs inside tmux, never directly');
});

test('non-TUI invocations pass through even on a TTY', () => {
  for (const args of [['--version'], ['-p', 'list files'], ['mcp', 'list'], ['rm', 'sid']]) {
    const { env, tmuxLog, claudeLog } = makeEnv();
    run('bash', env, args, { CLAUDE_WRAP_TTY: '1' });
    assert.strictEqual(read(tmuxLog), '', `claude ${args[0]} never wraps`);
    assert.strictEqual(read(claudeLog).trim(), args.join(' '), `claude ${args[0]} reaches the real binary intact`);
  }
});

test('TUI flags (-c/-r/--resume/attach/agents) do wrap', () => {
  for (const args of [['-c'], ['--resume'], ['attach', 'job1'], ['agents']]) {
    const { env, tmuxLog } = makeEnv();
    run('bash', env, args, { CLAUDE_WRAP_TTY: '1' });
    assert.match(read(tmuxLog), /new-session/, `claude ${args.join(' ')} wraps in tmux`);
  }
});

test('without a TTY (pipes, scripts) nothing wraps', () => {
  // The test harness itself has no TTY on stdio, so leaving the seam unset IS the case.
  const { env, tmuxLog, claudeLog } = makeEnv();
  run('bash', env, []);
  assert.strictEqual(read(tmuxLog), '', 'no TTY -> no wrap');
  assert.ok(read(claudeLog) !== undefined && read(tmuxLog) === '', 'falls through to the real claude');
});

test('args with spaces survive the tmux command quoting', () => {
  const { env, tmuxLog } = makeEnv();
  run('bash', env, ['-r', 'id with spaces'], { CLAUDE_WRAP_TTY: '1' });
  assert.match(read(tmuxLog), /claude -r id\\ with\\ spaces/, 'the resumed id stays one word');
});

test('the wrap behaves identically under zsh', { skip: zshSkip }, () => {
  const { env, tmuxLog, claudeLog } = makeEnv();
  run('zsh', env, [], { CLAUDE_WRAP_TTY: '1' });
  const log = read(tmuxLog);
  assert.match(log, /new-session -d -s claude-\d+ -c \S+ claude/, 'zsh creates the detached session');
  assert.match(log, /attach-session/, 'zsh attaches');
  assert.strictEqual(read(claudeLog), '', 'zsh never runs claude directly');
});

test('against real tmux: the session exists, runs claude, and hides its status', { skip: tmuxSkip }, () => {
  const { bin, env } = makeEnv();
  // A long-running stub keeps the session alive for inspection; TMUX_TMPDIR isolates
  // the server from the user's real one. The attach fails (no TTY) — expected.
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/bash\nsleep 30\n', { mode: 0o755 });
  const tmuxTmp = scratch('cwrap-srv-');
  const realTmux = { ...env, PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`, TMUX_TMPDIR: tmuxTmp, CLAUDE_WRAP_TTY: '1' };
  // Strip the stub tmux from PATH: keep stub claude by copying it to a claude-only dir.
  const claudeOnly = scratch('cwrap-claude-');
  fs.copyFileSync(path.join(bin, 'claude'), path.join(claudeOnly, 'claude'));
  fs.chmodSync(path.join(claudeOnly, 'claude'), 0o755);
  // The real tmux's own directory, resolved rather than assumed: Homebrew puts it in
  // /opt/homebrew/bin, which none of the hardcoded entries below cover. Without it the wrap's
  // `command -v tmux` guard failed, so the function fell through to the real claude and this
  // test asserted against a server that was never asked to exist -- and then died on ENOENT
  // spawning tmux itself. The stub tmux stays off PATH, which is the point of claudeOnly.
  const tmuxDir = path.dirname(execFileSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim());
  realTmux.PATH = `${claudeOnly}:${tmuxDir}:/usr/bin:/bin:/usr/local/bin:${path.dirname(process.execPath)}`;
  try {
    try {
      execFileSync('bash', ['-c', `${FN}\nclaude || true`], {
        env: realTmux, stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL',
      });
    } catch {
      // The wrap ends in `tmux attach-session`, and there is no TTY to attach to. Linux tmux
      // gives up ("open terminal failed") and the shell exits, which is what this used to
      // rely on; macOS tmux blocks instead, so the call sat there until execFileSync's own
      // timeout fired and the test failed with ETIMEDOUT before asserting anything. Killing
      // the attach at the timeout is fine either way: the detached session and its status
      // option are both set before it, and they are what the assertions below read.
    }
    const T = (...a) => execFileSync('tmux', a, { env: realTmux, encoding: 'utf8' });
    const ls = T('ls');
    assert.match(ls, /^claude-\d+:/, 'the wrapped session exists on the isolated server');
    const name = ls.match(/^(claude-\d+):/)[1];
    assert.match(T('show-options', '-t', name, 'status'), /status off/, 'its status line is hidden');
  } finally {
    try { execFileSync('tmux', ['kill-server'], { env: realTmux, stdio: 'ignore' }); } catch { /* server already gone */ }
  }
});

test('a real project cwd becomes the session -c dir', () => {
  const { env, tmuxLog } = makeEnv();
  const proj = scratch('cwrap-proj-');
  const home = scratch('cwrap-home-');            // cwd != $HOME -> no redirect
  runIn('bash', env, { extraEnv: { CLAUDE_WRAP_TTY: '1' }, cwd: proj, home });
  assert.match(read(tmuxLog), new RegExp(`new-session -d -s claude-\\d+ -c ${proj} claude`),
    'the tmux session opens in the current project dir');
});

test('a $HOME cwd is redirected to ~/dev so Claude Code trust persists', () => {
  const { env, tmuxLog } = makeEnv();
  const home = scratch('cwrap-home-');
  fs.mkdirSync(path.join(home, 'dev'));
  runIn('bash', env, { extraEnv: { CLAUDE_WRAP_TTY: '1' }, cwd: home, home });
  assert.match(read(tmuxLog), new RegExp(`new-session -d -s claude-\\d+ -c ${home}/dev claude`),
    'launching from $HOME lands the session in ~/dev, never $HOME (claude-code#43958)');
});

test('a $HOME cwd with no ~/dev falls back to $HOME rather than failing to launch', () => {
  const { env, tmuxLog } = makeEnv();
  const home = scratch('cwrap-home-');            // no dev/ subdir
  runIn('bash', env, { extraEnv: { CLAUDE_WRAP_TTY: '1' }, cwd: home, home });
  assert.match(read(tmuxLog), new RegExp(`new-session -d -s claude-\\d+ -c ${home} claude`),
    'without ~/dev the session stays in $HOME so the launch still works');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
