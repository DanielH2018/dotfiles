// Behavior checks for the ONE dedicated Agent View tab (CTRL+SHIFT+S / CTRL+Left) in
// wezterm.lua.tmpl. Activating the tab is only half the job: if the picker already exited
// back to its shell the binding has to retype `agentview`, and if the picker is still up it
// must NOT — typing into a live fzf prompt corrupts the query. That decision was a substring
// search over the foreground process PATH, so `.../fzf-tmux`, or any path with fzf in a
// directory name, read as "picker is live" and the key silently did nothing but activate.
//
// Same approach as wezterm-ssh-splits.test.js — the logic is Lua inside a Windows-only
// config, so render the template, load it against a stubbed `wezterm`, fire the real
// binding at a fake tab, and assert on what it did. That file's harness captures
// perform_action for the split bindings; this path drives mux tabs and send_text instead,
// so it needs its own stub surface.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const TMPL = path.join(REPO, 'home', 'dot_config', 'wezterm', 'wezterm.lua.tmpl');
const TITLE = 'Agent View';

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

// Stubs `wezterm`, loads the rendered config, fires CTRL+SHIFT+S at a fake mux window, and
// prints every call the binding made in order.
const HARNESS = String.raw`
local rendered, spec_file = ...
local spec = dofile(spec_file)
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
  run_child_process = function() return true, "", "" end,
}
package.preload["wezterm"] = function() return wezterm end
local config = dofile(rendered)

local log = {}
-- The pane inside the Agent View tab. spec.proc is what WezTerm can see running in front.
local pane = {
  get_foreground_process_name = function() return spec.proc end,
  send_text = function(_, t) log[#log + 1] = "send_text=" .. t:gsub("\n", "\\n") end,
}
local function make_tab(title)
  return {
    get_title = function() return title end,
    activate = function() log[#log + 1] = "activate=" .. tostring(title) end,
    active_pane = function() return pane end,
    set_title = function(_, s) log[#log + 1] = "set_title=" .. s end,
  }
end
local tabs = {}
for _, title in ipairs(spec.tabs or {}) do tabs[#tabs + 1] = { tab = make_tab(title) } end

local muxwin = {
  tabs_with_info = function() return tabs end,
  spawn_tab = function(_, args)
    log[#log + 1] = "spawn_tab=" .. tostring(args.domain and args.domain.DomainName)
    for _, a in ipairs(args.args or {}) do log[#log + 1] = "spawn_arg=" .. a end
    return make_tab("spawned")
  end,
}
local window = { mux_window = function() return muxwin end }

local callback
for _, entry in ipairs(config.keys) do
  if entry.key == "S" and entry.mods == "CTRL|SHIFT" then callback = entry.action.callback end
end
if not callback then print("ERROR=no binding for CTRL|SHIFT S") os.exit(1) end
callback(window, pane)
for _, l in ipairs(log) do print(l) end
`;

const dirs = [];
let dir, rendered;
function setup() {
  if (dir) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wezterm-agentview-'));
  dirs.push(dir);
  rendered = path.join(dir, 'wezterm.lua');
  fs.writeFileSync(rendered, execFileSync('chezmoi', ['execute-template'], {
    input: fs.readFileSync(TMPL, 'utf8'), cwd: REPO, encoding: 'utf8',
  }));
  fs.writeFileSync(path.join(dir, 'harness.lua'), HARNESS);
}

function luaStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// Fires the binding and returns the ordered list of calls the Lua made.
let specSeq = 0;
function press({ tabs = [], proc = null } = {}) {
  setup();
  const body = [`["tabs"] = { ${tabs.map(luaStr).join(', ')} }`];
  if (proc !== null) body.push(`["proc"] = ${luaStr(proc)}`);
  const specFile = path.join(dir, `spec${specSeq += 1}.lua`);
  fs.writeFileSync(specFile, `return { ${body.join(', ')} }\n`);
  const out = execFileSync(lua, [path.join(dir, 'harness.lua'), rendered, specFile], { encoding: 'utf8' });
  const lines = out.trim() === '' ? [] : out.trim().split('\n');
  assert.ok(!lines.some((l) => l.startsWith('ERROR=')), lines.join('\n'));
  return lines;
}
const retyped = (lines) => lines.includes('send_text=agentview\\n');

test('the picker is retyped when the tab has fallen back to its shell', { skip }, () => {
  const lines = press({ tabs: [TITLE], proc: '/usr/bin/bash' });
  assert.ok(lines.includes(`activate=${TITLE}`), lines.join('\n'));
  assert.ok(retyped(lines), 'a shell prompt must get the picker back');
});

test('a live picker is only activated, never typed into', { skip }, () => {
  for (const proc of ['/usr/bin/fzf', '/home/daniel/.local/bin/fzf', 'C:\\tools\\fzf.exe', 'FZF']) {
    const lines = press({ tabs: [TITLE], proc });
    assert.ok(lines.includes(`activate=${TITLE}`), lines.join('\n'));
    assert.ok(!retyped(lines), `must not type into a live picker: ${proc}`);
  }
});

test('a process that merely contains fzf is not mistaken for the picker', { skip }, () => {
  // The regression: each of these suppressed the retype, so the key activated a dead
  // shell and looked broken. Only an exact basename match means "picker is up".
  for (const proc of [
    '/home/daniel/.local/bin/fzf-tmux',   // the wrapper, not the picker
    '/opt/fzf/bin/bash',                  // fzf in a DIRECTORY name
    '/usr/bin/fzfmenu',
  ]) {
    assert.ok(retyped(press({ tabs: [TITLE], proc })), `must still retype: ${proc}`);
  }
});

test('a pane WezTerm cannot see into still gets the picker', { skip }, () => {
  // WSL hides the foreground process, so this is the common case, not an edge one.
  assert.ok(retyped(press({ tabs: [TITLE] })), 'an unknown process must not read as a live picker');
});

test('the one and only tab is spawned when none is marked', { skip }, () => {
  const lines = press({ tabs: ['some other tab', ''] });
  assert.ok(lines.some((l) => l.startsWith('spawn_tab=WSL:')), lines.join('\n'));
  assert.ok(lines.includes(`set_title=${TITLE}`), 'the new tab must be marked, or the next press piles up another');
  assert.ok(!lines.some((l) => l.startsWith('activate=')), 'nothing existing should have been activated');
});

test('an existing marked tab is never duplicated', { skip }, () => {
  const lines = press({ tabs: ['scratch', TITLE], proc: '/usr/bin/bash' });
  assert.ok(!lines.some((l) => l.startsWith('spawn_tab=')), 'a second Agent View tab must never be spawned');
  assert.ok(lines.includes(`activate=${TITLE}`), lines.join('\n'));
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
