// Behavior checks for the ssh-aware CTRL+D / CTRL+SHIFT+D splits in wezterm.lua.tmpl.
// A plain split spawns a shell in the pane's own domain and inherits its OSC 7 cwd, so
// splitting an ssh'd pane used to drop you on the LOCAL box at the REMOTE path. The
// config now probes the pane (ssh process argv, then OSC 7 host) and hops back over ssh.
//
// The logic is Lua inside a Windows-only config, so it is exercised the only way it can
// be off-Windows: render the template, load it against a stubbed `wezterm` module, fire
// the real keybinding at a fake pane, and assert on the SpawnCommand it hands WezTerm.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const TMPL = path.join(REPO, 'home', 'dot_config', 'wezterm', 'wezterm.lua.tmpl');

function have(cmd, arg) {
  try { execFileSync(cmd, [arg], { stdio: 'ignore' }); return true; } catch { return false; }
}
// DEVCOM.Lua (the winget installer's Lua) drops lua.exe outside PATH — probe it like
// wezterm-config.test.js probes luac, then fall back to the names a Linux box has.
function findLua() {
  const win = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Lua', 'bin', 'lua.exe');
  if (fs.existsSync(win)) return win;
  for (const c of ['lua5.4', 'lua']) if (have(c, '-v')) return c;
  return '';
}
const lua = findLua();
const skip = !have('chezmoi', '--version') ? 'chezmoi unavailable'
  : !lua ? 'lua unavailable' : false;

// Fake panes, one per pane shape the split has to handle. `cwd` is what OSC 7 reported
// (a Url — host + file_path); `proc` is the foreground process WezTerm can see.
const SSH_EXE = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
const PANES = {
  // A local WSL pane: OSC 7 names this machine's distro, WSL hides the process.
  local_wsl: { cwd: { host: 'daniel-wsl', file_path: '/home/daniel/dev' }, domain: 'WSL:Ubuntu' },
  // A local Git Bash pane: OSC 7 names the Windows box.
  local_windows: {
    cwd: { host: 'TEST-PC', file_path: 'C:/Users/test' },
    proc: { name: 'bash.exe', executable: 'C:\\...\\bash.exe', argv: ['bash'] },
    domain: 'local',
  },
  // A WSL pane sitting at a REMOTE shell prompt (`ssh homelab`): the process is hidden,
  // but the remote shell's OSC 7 gives up both the host and the directory.
  remote_shell_wsl: {
    cwd: { host: 'daniel-server', file_path: '/home/ubuntu/proj' }, domain: 'WSL:Ubuntu',
  },
  // The CTRL+SHIFT+H homelab tab: Git Bash -> ssh -> REMOTE tmux. tmux swallows OSC 7
  // (the cwd is still the local one), so the ssh process argv is the only signal.
  homelab_tab: {
    cwd: { host: 'TEST-PC', file_path: 'C:/Users/test' },
    proc: {
      name: 'ssh.exe', executable: SSH_EXE,
      argv: ['ssh', '-t', 'daniel-server', 'tmux new-session -A -s main'],
    },
    domain: 'local',
  },
  // Options that take a value must not be read as the destination.
  ssh_with_flags: {
    cwd: { host: 'TEST-PC', file_path: 'C:/Users/test' },
    proc: {
      name: 'ssh.exe', executable: SSH_EXE,
      argv: ['ssh', '-p', '2222', '-o', 'StrictHostKeyChecking=no', '-i', '~/.ssh/k', 'box', 'tmux', 'a'],
    },
    domain: 'local',
  },
  // Both signals at once (bare `ssh` from Git Bash, remote shell at a prompt).
  remote_shell_gitbash: {
    cwd: { host: 'daniel-server', file_path: '/home/ubuntu' },
    proc: { name: 'ssh.exe', executable: SSH_EXE, argv: ['ssh', 'homelab'] },
    domain: 'local',
  },
  // A path the remote shell needs quoted.
  quoted_path: {
    cwd: { host: 'daniel-server', file_path: "/home/ubuntu/it's here" }, domain: 'WSL:Ubuntu',
  },
  // A non-ssh foreground process must not be mistaken for one.
  nonssh_proc: {
    cwd: { host: 'daniel-wsl', file_path: '/home/daniel' },
    proc: { name: 'nvim', executable: '/usr/bin/nvim', argv: ['nvim', 'daniel-server'] },
    domain: 'WSL:Ubuntu',
  },
  // Both probes throwing must never wedge the key.
  probe_error: { cwdError: true, procError: true, domain: 'WSL:Ubuntu' },
};

// Stubs `wezterm`, loads the rendered config, fires one binding, prints the SpawnCommand.
const HARNESS = String.raw`
local rendered, pane_json, key, mods = ...
local function ctor(name)
  return setmetatable({}, { __call = function(_, arg) return { action = name, arg = arg } end })
end
local wezterm = {
  action = setmetatable({}, { __index = function(_, k) return ctor(k) end }),
  action_callback = function(fn) return { callback = fn } end,
  config_builder = function() return {} end,
  font_with_fallback = function() return {} end,
  font = function() return {} end,
  hostname = function() return "TEST-PC" end,
  home_dir = "C:\\Users\\test",
  on = function() end,
  GLOBAL = {},
  mux = {},
}
package.preload["wezterm"] = function() return wezterm end
local config = dofile(rendered)

local spec = dofile(pane_json)   -- a Lua table literal written by the test
local pane = {
  get_current_working_dir = function()
    if spec.cwdError then error("probe failed") end
    return spec.cwd
  end,
  get_foreground_process_info = function()
    if spec.procError then error("probe failed") end
    return spec.proc
  end,
  get_domain_name = function() return spec.domain end,
}

local callback
for _, entry in ipairs(config.keys) do
  if entry.key == key and entry.mods == mods then callback = entry.action.callback end
end
if not callback then print("ERROR=no binding for " .. key .. " " .. mods) os.exit(1) end

local captured
local window = { perform_action = function(_, action) captured = action end }
callback(window, pane)

print("action=" .. tostring(captured.action))
print("domain=" .. tostring(captured.arg.domain))
print("cwd=" .. tostring(captured.arg.cwd))
if captured.arg.args == nil then
  print("args=nil")
else
  for _, a in ipairs(captured.arg.args) do print("arg=" .. a) end
end
`;

let dir, rendered;
function setup() {
  if (dir) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wezterm-split-'));
  rendered = path.join(dir, 'wezterm.lua');
  fs.writeFileSync(rendered, execFileSync('chezmoi', ['execute-template'], {
    input: fs.readFileSync(TMPL, 'utf8'), cwd: REPO, encoding: 'utf8',
  }));
  fs.writeFileSync(path.join(dir, 'harness.lua'), HARNESS);
}

// Serialize a pane spec as a Lua table literal the harness can dofile().
function luaLiteral(value) {
  if (value === true) return 'true';
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (Array.isArray(value)) return `{ ${value.map(luaLiteral).join(', ')} }`;
  const body = Object.entries(value).map(([k, v]) => `["${k}"] = ${luaLiteral(v)}`);
  return `{ ${body.join(', ')} }`;
}

// Fires a binding at a pane and returns the SpawnCommand WezTerm would have received.
function split(paneName, { vertical = false } = {}) {
  setup();
  const specFile = path.join(dir, `${paneName}.lua`);
  fs.writeFileSync(specFile, `return ${luaLiteral(PANES[paneName])}\n`);
  const out = execFileSync(lua, [
    path.join(dir, 'harness.lua'), rendered, specFile,
    vertical ? 'D' : 'd', vertical ? 'CTRL|SHIFT' : 'CTRL',
  ], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const get = (k) => (lines.find((l) => l.startsWith(`${k}=`)) || '').slice(k.length + 1);
  return {
    action: get('action'),
    domain: get('domain'),
    cwd: get('cwd') === 'nil' ? null : get('cwd'),
    args: lines.some((l) => l === 'args=nil') ? null
      : lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4)),
  };
}

test('a local pane still gets the plain inherit-the-cwd split', { skip }, () => {
  for (const pane of ['local_wsl', 'local_windows', 'nonssh_proc']) {
    const got = split(pane);
    assert.strictEqual(got.action, 'SplitHorizontal', `${pane}: splits horizontally`);
    assert.strictEqual(got.domain, 'CurrentPaneDomain', `${pane}: stays in the pane's domain`);
    assert.strictEqual(got.args, null, `${pane}: no ssh command — WezTerm spawns the default shell`);
    assert.strictEqual(got.cwd, null, `${pane}: cwd left to WezTerm, so the split inherits it`);
  }
});

test('a probe that throws falls back to the plain split', { skip }, () => {
  const got = split('probe_error');
  assert.strictEqual(got.args, null, 'no ssh command guessed from a failed probe');
  assert.strictEqual(got.cwd, null, 'cwd untouched');
});

test('a remote shell (OSC 7) splits back over ssh into the same directory', { skip }, () => {
  const got = split('remote_shell_wsl');
  assert.deepStrictEqual(got.args, [
    'ssh', '-t', 'daniel-server',
    "cd '/home/ubuntu/proj' 2>/dev/null || cd; exec ${SHELL:-/bin/sh} -l",
  ]);
  // Inheriting the pane's cwd here would chdir a LOCAL spawn into the remote path:
  // `WSL ... CreateProcessCommon:788: chdir(/home/ubuntu) failed 2`.
  assert.strictEqual(got.cwd, '/', 'WSL spawn launches from a dir that exists locally');
});

test('the homelab tab splits into a second shell, not a mirror of its tmux session', { skip }, () => {
  const got = split('homelab_tab');
  // `tmux new-session -A -s main` is dropped: replaying it would attach the SAME session.
  assert.deepStrictEqual(got.args, [SSH_EXE, '-t', 'daniel-server']);
  // OSC 7 is local here (remote tmux swallowed it), so there is no remote dir to cd into.
  assert.strictEqual(got.cwd, 'C:\\Users\\test', 'local domain gets a valid local launch dir');
});

test('ssh options are carried over and their values are not read as the destination', { skip }, () => {
  const got = split('ssh_with_flags');
  assert.deepStrictEqual(got.args, [
    SSH_EXE, '-p', '2222', '-o', 'StrictHostKeyChecking=no', '-i', '~/.ssh/k', 'box',
  ], 'stops at `box`, keeping every flag/value pair and dropping the remote command');
});

test('both signals together: ssh argv picks the destination, OSC 7 the directory', { skip }, () => {
  const got = split('remote_shell_gitbash');
  assert.deepStrictEqual(got.args, [
    SSH_EXE, '-t', 'homelab',
    "cd '/home/ubuntu' 2>/dev/null || cd; exec ${SHELL:-/bin/sh} -l",
  ]);
  assert.strictEqual(got.cwd, 'C:\\Users\\test', 'never launches from the remote path locally');
});

test('a remote path with a quote survives the trip to the remote shell', { skip }, () => {
  const got = split('quoted_path');
  assert.strictEqual(got.args[3],
    "cd '/home/ubuntu/it'\\''s here' 2>/dev/null || cd; exec ${SHELL:-/bin/sh} -l");
});

test('no ssh split is ever launched from the remote path', { skip }, () => {
  // The symptom when it is: `WSL (…) ERROR: CreateProcessCommon:788: chdir(/home/ubuntu)
  // failed 2` — a local spawn trying to enter a directory that only exists on the far side.
  for (const pane of ['remote_shell_wsl', 'quoted_path', 'homelab_tab', 'remote_shell_gitbash']) {
    const got = split(pane);
    assert.ok(got.cwd, `${pane}: launch dir is pinned, not inherited`);
    assert.ok(!got.cwd.startsWith('/home/ubuntu'), `${pane}: launch dir is not the remote path`);
  }
});

test('CTRL+SHIFT+D splits down with the same ssh-aware command', { skip }, () => {
  const got = split('remote_shell_wsl', { vertical: true });
  assert.strictEqual(got.action, 'SplitVertical');
  assert.strictEqual(got.args[2], 'daniel-server', 'same ssh destination as CTRL+D');
});
