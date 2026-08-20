// Regression guard for the claude() function in home/dot_config/shell/common.sh.
//
// The function used to start every interactive session inside a status-less tmux session, so
// the C-Left back-to-Agent-View bind had a layer to catch the key. agentview is retired and
// that bind is gone, so the wrap went with it — and the wrap was never free: a session labels
// its own terminal row by writing OSC 0, and inside tmux that sets tmux's pane_title and stops
// there under Warp's TERM=xterm-256color, which carries no tsl/fsl for tmux to set an outer
// title with.
//
// So the property under test inverted. It used to be "an interactive start wraps"; it is now
// "nothing ever invokes tmux". The $HOME redirect is the one behaviour that survived, because
// it fixes a Claude Code trust prompt rather than anything to do with tmux.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'home', 'dot_config', 'shell', 'common.sh');
const FN = fs.readFileSync(SRC, 'utf8').match(/^claude\(\) \{[\s\S]*?^\}$/m)[0];

let zshOk = true;
try { execFileSync('zsh', ['-c', 'true'], { stdio: 'ignore' }); } catch { zshOk = false; }
const zshSkip = zshOk ? false : 'zsh unavailable';

const dirs = [];
function scratch(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

// Stub bin: tmux and claude both log. tmux logging ANYTHING is a failure now — that is the
// whole point of the file — and claude logs its argv and cwd so the redirect is checkable.
function makeEnv() {
  const bin = scratch('cwrap-bin-');
  const tmuxLog = path.join(bin, 'tmux.log'); fs.writeFileSync(tmuxLog, '');
  const claudeLog = path.join(bin, 'claude.log'); fs.writeFileSync(claudeLog, '');
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/bash\necho "$*" >> "$TMUX_LOG"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/bash\necho "cwd=$PWD argv=$*" >> "$CLAUDE_LOG"\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMUX_LOG: tmuxLog, CLAUDE_LOG: claudeLog };
  delete env.TMUX; delete env.WEZTERM_PANE; delete env.WSL_DISTRO_NAME; delete env.TERM_PROGRAM;
  return { bin, env, tmuxLog, claudeLog };
}
const read = (p) => fs.readFileSync(p, 'utf8');

function run(shell, env, { args = [], cwd, home } = {}) {
  const argv = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const e = { ...env };
  if (home) e.HOME = home;
  if (cwd) e.PWD = cwd;
  execFileSync(shell, ['-c', `${FN}\nclaude ${argv}`], { env: e, cwd, stdio: 'ignore', timeout: 10000 });
}

test('an interactive start runs claude directly — tmux is never invoked', () => {
  const { env, tmuxLog, claudeLog } = makeEnv();
  run('bash', env);
  assert.strictEqual(read(tmuxLog), '', 'the wrap is gone; nothing may shell out to tmux');
  assert.match(read(claudeLog), /argv=/, 'the real binary ran');
});

// Every value that used to steer the wrap is now inert. Left as a set rather than one case so
// a reintroduced branch on any of them fails here rather than in a terminal months later.
for (const [name, extra] of [
  ['inside tmux', { TMUX: '/tmp/tmux-1000/default,1,0' }],
  ['a wezterm pane', { WEZTERM_PANE: '7' }],
  ['a wezterm WSL pane', { WEZTERM_PANE: '7', WSL_DISTRO_NAME: 'Ubuntu' }],
  ['a Warp pane', { TERM_PROGRAM: 'WarpTerminal' }],
]) {
  test(`${name} is indistinguishable — still no tmux`, () => {
    const { env, tmuxLog } = makeEnv();
    run('bash', { ...env, ...extra });
    assert.strictEqual(read(tmuxLog), '', `${name} changed the behaviour; the wrap is meant to be unconditional-off`);
  });
}

test('TUI flags (-c/-r/--resume/attach/agents) reach the binary with their args intact', () => {
  const { env, claudeLog } = makeEnv();
  for (const f of ['-c', '--continue', '-r', '--resume', 'attach', 'agents']) run('bash', env, { args: [f] });
  const log = read(claudeLog);
  for (const f of ['-c', '--continue', '-r', '--resume', 'attach', 'agents']) {
    assert.match(log, new RegExp(`argv=${f.replace(/-/g, '\\-')}$`, 'm'), `${f} did not reach the binary`);
  }
});

test('non-TUI invocations pass through untouched', () => {
  const { env, claudeLog, tmuxLog } = makeEnv();
  run('bash', env, { args: ['-p', 'hello'] });
  run('bash', env, { args: ['--version'] });
  assert.strictEqual(read(tmuxLog), '');
  assert.match(read(claudeLog), /argv=-p hello/);
  assert.match(read(claudeLog), /argv=--version/);
});

test('args with spaces survive', () => {
  const { env, claudeLog } = makeEnv();
  run('bash', env, { args: ['-p', 'two words'] });
  assert.match(read(claudeLog), /argv=-p two words/);
});

// Claude Code never persists trust for a $HOME workspace (claude-code#43958), so it re-asks on
// every launch. Running from ~/dev trusts once and sticks.
test('a $HOME cwd runs claude from ~/dev', () => {
  const { env, claudeLog } = makeEnv();
  const home = scratch('cwrap-home-');
  fs.mkdirSync(path.join(home, 'dev'));
  run('bash', env, { cwd: home, home });
  assert.match(read(claudeLog), new RegExp(`cwd=${path.join(home, 'dev')} `), 'a $HOME session must run from ~/dev');
});

test('a $HOME cwd with no ~/dev stays in $HOME rather than failing to launch', () => {
  const { env, claudeLog } = makeEnv();
  const home = scratch('cwrap-home-');
  run('bash', env, { cwd: home, home });
  assert.match(read(claudeLog), new RegExp(`cwd=${home} `), 'no ~/dev means run where you are');
});

test('a real project cwd is left alone', () => {
  const { env, claudeLog } = makeEnv();
  const home = scratch('cwrap-home-');
  fs.mkdirSync(path.join(home, 'dev'));
  const proj = scratch('cwrap-proj-');
  run('bash', env, { cwd: proj, home });
  assert.match(read(claudeLog), new RegExp(`cwd=${proj} `), 'a project cwd must not be redirected');
});

test('behaves identically under zsh', { skip: zshSkip }, () => {
  const { env, tmuxLog, claudeLog } = makeEnv();
  run('zsh', env);
  assert.strictEqual(read(tmuxLog), '');
  assert.match(read(claudeLog), /argv=/);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
