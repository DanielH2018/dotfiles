// Behavior checks for `wezterm-pane-ssh`, the WSL-side half of the ssh-aware splits.
//
// WezTerm can't see into a WSL pane (it only ever gets wslhost.exe) and remote tmux eats
// OSC 7, so for an agentview homelab jump the Windows config has no signal at all. This
// helper answers from inside Linux, mapping $WEZTERM_PANE -> the ssh client backing it.
//
// It reads /proc directly, so the tests point it at a fixture tree via
// WEZTERM_PANE_SSH_PROC rather than trying to arrange real processes.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'home', 'dot_local', 'bin', 'executable_wezterm-pane-ssh');

function have(cmd, arg) {
  try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true; } catch { return false; }
}
const skip = !have('gawk', '--version') ? 'gawk unavailable' : false;

// One fake process. `pane` undefined means no WEZTERM_PANE in its environment at all.
// `stat` mirrors the kernel's format — comm is parenthesised and may itself contain
// spaces and parens ("tmux: client"), which is exactly what the parser has to survive.
function mkProc(root, { pid, comm, ppid, pane, argv = [], fd0 }) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stat'),
    `${pid} (${comm}) S ${ppid} 0 0 0 -1 0 0 0 0 0 0 0 20 0 1 0 100 0 0\n`);
  const env = ['PATH=/usr/bin', ...(pane === undefined ? [] : [`WEZTERM_PANE=${pane}`])];
  fs.writeFileSync(path.join(dir, 'environ'), `${env.join('\0')}\0`);
  fs.writeFileSync(path.join(dir, 'cmdline'), argv.length ? `${argv.join('\0')}\0` : '');
  if (fd0) {
    fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
    fs.symlinkSync(fd0, path.join(dir, 'fd', '0'));   // dangling on purpose: readlink only
  }
}

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pane-ssh-${name}-`));
}

// A stub tmux answering the two queries the helper makes, so the tmux layout is testable
// without a live server. Anything else it might be asked returns nothing.
function stubTmux(clients, panes) {
  const bin = tmpdir('bin');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$1" in
  list-clients) printf '%s\\n' ${JSON.stringify(clients)} ;;
  list-panes)   printf '%s\\n' ${JSON.stringify(panes)} ;;
esac
`, { mode: 0o755 });
  return bin;
}

function run(root, pane, bin) {
  const env = { ...process.env, WEZTERM_PANE_SSH_PROC: root };
  if (bin) env.PATH = `${bin}:${process.env.PATH}`;
  try {
    const stdout = execFileSync('sh', [SCRIPT, String(pane)], { env, encoding: 'utf8' });
    return { code: 0, argv: stdout.split('\n').filter(Boolean) };
  } catch (err) {
    return { code: err.status, argv: (err.stdout || '').split('\n').filter(Boolean) };
  }
}

// The plain case: the pane's own shell exec'd ssh, so it is a descendant of the pane.
function directTree() {
  const root = tmpdir('direct');
  mkProc(root, { pid: 100, comm: 'zsh', ppid: 1, pane: 7, argv: ['-zsh'] });
  mkProc(root, {
    pid: 101, comm: 'ssh', ppid: 100, pane: 7,
    argv: ['ssh', '-t', 'daniel-server', "tmux attach -t 'claude-9'"],
  });
  // A second pane whose id shares a prefix with the first, to pin down exact matching.
  mkProc(root, { pid: 200, comm: 'zsh', ppid: 1, pane: 70, argv: ['-zsh'] });
  mkProc(root, { pid: 201, comm: 'ssh', ppid: 200, pane: 70, argv: ['ssh', 'other-host'] });
  return root;
}

test('finds the ssh the pane shell launched', { skip }, () => {
  const got = run(directTree(), 7);
  assert.strictEqual(got.code, 0);
  assert.deepStrictEqual(got.argv,
    ['ssh', '-t', 'daniel-server', "tmux attach -t 'claude-9'"],
    'the full argv is reported; truncating at the destination is the caller\'s job');
});

test('pane ids match exactly, never by prefix', { skip }, () => {
  const root = directTree();
  assert.deepStrictEqual(run(root, 70).argv, ['ssh', 'other-host'], 'pane 70 is its own pane');
  assert.strictEqual(run(root, 7).argv[2], 'daniel-server', 'and does not bleed into pane 7');
});

test('reports nothing for a pane that is not ssh\'d anywhere', { skip }, () => {
  const root = tmpdir('local');
  mkProc(root, { pid: 100, comm: 'zsh', ppid: 1, pane: 7, argv: ['-zsh'] });
  mkProc(root, { pid: 101, comm: 'nvim', ppid: 100, pane: 7, argv: ['nvim', 'daniel-server'] });
  const got = run(root, 7);
  assert.deepStrictEqual(got.argv, [], 'no output, so the caller keeps the split local');
  assert.notStrictEqual(got.code, 0);
});

test('an unknown pane id and a malformed one both fail quietly', { skip }, () => {
  const root = directTree();
  assert.deepStrictEqual(run(root, 999).argv, []);
  assert.strictEqual(run(root, 'abc').code, 2, 'a pane id is always an integer');
});

test('prefers the shallowest ssh, not the first one found depth-first', { skip }, () => {
  // A background job several levels down must never outrank the pane's own foreground ssh.
  const root = tmpdir('depth');
  mkProc(root, { pid: 100, comm: 'zsh', ppid: 1, pane: 7, argv: ['-zsh'] });
  mkProc(root, { pid: 101, comm: 'make', ppid: 100, pane: 7, argv: ['make'] });
  mkProc(root, { pid: 102, comm: 'sh', ppid: 101, pane: 7, argv: ['sh'] });
  mkProc(root, { pid: 103, comm: 'ssh', ppid: 102, pane: 7, argv: ['ssh', 'deep-host'] });
  mkProc(root, { pid: 110, comm: 'ssh', ppid: 100, pane: 7, argv: ['ssh', 'foreground-host'] });
  assert.deepStrictEqual(run(root, 7).argv, ['ssh', 'foreground-host']);
});

// agentview's popup path opens a LOCAL tmux window running ssh. The ssh is then a child of
// the tmux *server*, not of the pane, and the server's own WEZTERM_PANE is stale — it was
// inherited from whichever pane happened to start it. Only the client -> session -> active
// pane chain gets there.
function tmuxTree() {
  const root = tmpdir('tmux');
  mkProc(root, { pid: 300, comm: 'zsh', ppid: 1, pane: 9, argv: ['-zsh'] });
  mkProc(root, {
    pid: 301, comm: 'tmux: client', ppid: 300, pane: 9, fd0: '/dev/pts/5',
    argv: ['tmux', 'attach-session', '-t', 'claude-42'],
  });
  mkProc(root, { pid: 400, comm: 'tmux: server', ppid: 1, pane: 3, argv: ['tmux'] });
  mkProc(root, {
    pid: 401, comm: 'ssh', ppid: 400, pane: 3,
    argv: ['ssh', '-t', 'daniel-server', "tmux attach -t 'claude-42'"],
  });
  return root;
}

test('follows a local tmux client through to the ssh under the server', { skip }, () => {
  const bin = stubTmux('/dev/pts/5 claude-42', 'claude-42 11 401');
  const got = run(tmuxTree(), 9, bin);
  assert.deepStrictEqual(got.argv,
    ['ssh', '-t', 'daniel-server', "tmux attach -t 'claude-42'"]);
});

test('the stale WEZTERM_PANE on tmux-server children is never trusted', { skip }, () => {
  // Pane 3 is what the server inherited, but no pane 3 is attached to that session now.
  // Answering "yes, pane 3 is on daniel-server" would ssh a split off the wrong pane.
  const bin = stubTmux('/dev/pts/5 claude-42', 'claude-42 11 401');
  assert.deepStrictEqual(run(tmuxTree(), 3, bin).argv, [],
    'a pane id seen only on the server side resolves to nothing');
});

test('an inactive tmux pane is not mistaken for the one on screen', { skip }, () => {
  // window_active/pane_active = "10": that pane is current in its window, but the window
  // is not the session's current one, so it is not what the user is looking at.
  const bin = stubTmux('/dev/pts/5 claude-42', 'claude-42 10 401');
  assert.deepStrictEqual(run(tmuxTree(), 9, bin).argv, []);
});

test('a tmux layout survives tmux being absent', { skip }, () => {
  const empty = tmpdir('notmux');
  fs.writeFileSync(path.join(empty, 'tmux'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const got = run(tmuxTree(), 9, empty);
  assert.deepStrictEqual(got.argv, [], 'no output rather than a crash');
  assert.notStrictEqual(got.code, 0);
});
