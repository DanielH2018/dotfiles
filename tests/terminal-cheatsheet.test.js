// Tests for the terminal-cheatsheet generator's Claude + WezTerm parsing. The generator
// reads DEPLOYED configs off disk, so each test points $HOME / $XDG_CONFIG_HOME at a temp
// fixture, runs `node terminal-cheatsheet <out>`, and asserts over the emitted HTML.
//
// WSL_DISTRO_NAME is stripped from the child env so the /mnt/c WezTerm fallback stays off
// and the parser is exercised against fixtures only — except the one test that opts into it.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const GEN = path.join(REPO, 'home', 'dot_local', 'bin', 'executable_terminal-cheatsheet');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cheatsheet-')); }

// Run the generator against a fixture and return the emitted HTML. keepWsl=false strips
// WSL_DISTRO_NAME so the /mnt/c reach-across is disabled (deterministic fixture-only runs).
function runGen({ home, xdg, keepWsl = false }) {
  const dir = tmpdir();
  const out = path.join(dir, 'out.html');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
  delete env.YAZI_CONFIG_HOME;
  delete env.TERMINAL_CHEATSHEET_OUT;
  if (!keepWsl) delete env.WSL_DISTRO_NAME;
  execFileSync('node', [GEN, out], { env, stdio: 'ignore' });
  return fs.readFileSync(out, 'utf8');
}

function writeKeybindings(home, obj) {
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keybindings.json'), JSON.stringify(obj));
}

const SAMPLE_BINDINGS = {
  bindings: [
    { context: 'Global', bindings: { 'ctrl+k ctrl+t': 'app:toggleTodos', 'ctrl+k ctrl+s': 'app:globalSearch' } },
    { context: 'Chat', bindings: { 'ctrl+k ctrl+k': 'chat:killAgents', 'alt+v': 'chat:imagePaste', 'ctrl+alt+v': 'chat:imagePaste' } },
  ],
};

// A WezTerm config exercising the constructs the old line-by-line parser choked on:
// action_callback bodies (no `act.X` on the key line) and multiline SpawnCommandInNewTab
// tabs whose distinguishing string sits below the key line.
const WEZTERM_FIXTURE = `local wezterm = require("wezterm")
local act = wezterm.action
local config = wezterm.config_builder()

config.keys = {
	{ key = "Enter", mods = "SHIFT", action = act.SendString("\\n") },
	{ key = "t", mods = "CTRL", action = act.SpawnTab("CurrentPaneDomain") },
	{ key = "w", mods = "CTRL", action = wezterm.action_callback(function(window, pane)
		if pane:get_foreground_process_name():find("fzf") then
			window:perform_action(act.SendKey({ key = "Escape" }), pane)
		else
			window:perform_action(act.CloseCurrentPane({ confirm = false }), pane)
		end
	end) },
	{ key = "T", mods = "CTRL|SHIFT", action = wezterm.action_callback(function()
		wezterm.mux.spawn_window({ domain = { DomainName = "WSL:Ubuntu" } })
	end) },
	{ key = "S", mods = "CTRL|SHIFT", action = act.SpawnCommandInNewTab({
		domain = { DomainName = "local" },
		args = { "bash", "-c", "agentview" },
	}) },
	{ key = "N", mods = "CTRL|SHIFT", action = act.SpawnCommandInNewTab({
		domain = { DomainName = "local" },
		args = { "bash", "-c", "agentview --spawn" },
	}) },
	{ key = "H", mods = "CTRL|SHIFT", action = act.SpawnCommandInNewTab({
		domain = { DomainName = "local" },
		args = { "bash", "-c", "ssh -t daniel-server 'tmux new-session -A -s main'" },
	}) },
	{ key = "B", mods = "CTRL|SHIFT", action = act.SpawnTab({ DomainName = "local" }) },
}

for i = 1, 9 do
	table.insert(config.keys, { key = tostring(i), mods = "CTRL", action = act.ActivateTab(i - 1) })
end

return config
`;

function writeWezterm(xdg, src) {
  const dir = path.join(xdg, 'wezterm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wezterm.lua'), src);
}

test('Claude card: grouped by context, readable labels, two-step chords', () => {
  const home = tmpdir(), xdg = tmpdir();
  writeKeybindings(home, SAMPLE_BINDINGS);
  const html = runGen({ home, xdg });

  assert.match(html, /<h2>Claude Code<\/h2>/);
  assert.match(html, /--accent:var\(--peach\)/);
  assert.match(html, /Custom overrides/);
  // Grouped by context.
  assert.match(html, /<h3>Global<\/h3>/);
  assert.match(html, /<h3>Chat<\/h3>/);
  // Known action ids mapped to friendly labels.
  for (const label of ['Toggle to-do panel', 'Global search', 'Kill running agents', 'Paste image from clipboard']) {
    assert.ok(html.includes(label), `missing label: ${label}`);
  }
  // Two-stroke chord renders each step as <kbd> runs joined by a "then".
  assert.match(html, /<span class="then">then<\/span>/);
});

test('Claude labels: unknown action id falls back to a de-camel-cased phrase', () => {
  const home = tmpdir(), xdg = tmpdir();
  writeKeybindings(home, { bindings: [{ context: 'Chat', bindings: { 'ctrl+g': 'chat:someNewThing' } }] });
  const html = runGen({ home, xdg });
  assert.match(html, /Some new thing/);
});

test('Claude card omitted (no crash) when keybindings.json is absent', () => {
  const home = tmpdir(), xdg = tmpdir(); // neither populated
  const html = runGen({ home, xdg });
  assert.ok(!html.includes('<h2>Claude Code</h2>'), 'Claude card should be absent');
  assert.match(html, /No WezTerm \/ Ghostty \/ Neovim \/ Yazi \/ Claude Code configs found/);
});

test('Claude card omitted (no crash) when keybindings.json is malformed', () => {
  const home = tmpdir(), xdg = tmpdir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'keybindings.json'), '{ this is not json');
  const html = runGen({ home, xdg });
  assert.ok(!html.includes('<h2>Claude Code</h2>'), 'malformed config must be skipped, not crash');
});

test('WezTerm: action_callback and multiline spawn binds are parsed and labeled', () => {
  const home = tmpdir(), xdg = tmpdir();
  writeWezterm(xdg, WEZTERM_FIXTURE);
  const html = runGen({ home, xdg });
  const wez = html.split('data-tool="wezterm"')[1].split('</section>')[0];

  assert.match(html, /<h2>WezTerm<\/h2>/);
  // Callback binds the old parser dropped entirely.
  assert.ok(wez.includes('Close tab / pane'), 'Ctrl+W (CloseCurrentPane callback) missing');
  assert.ok(wez.includes('New window'), 'Ctrl+Shift+T (mux.spawn_window callback) missing');
  // Spawn tabs the old parser collapsed to a generic "SpawnCommandInNewTab".
  assert.ok(wez.includes('Agent View'), 'agentview label missing');
  assert.ok(wez.includes('New sandbox session'), 'agentview --spawn label missing');
  assert.ok(wez.includes('New homelab tab (daniel-server)'), 'homelab label missing');
  assert.ok(wez.includes('New Git Bash tab (local)'), 'local SpawnTab label missing');
  // No bind is left labeled with a raw action name.
  assert.ok(!wez.includes('SpawnCommandInNewTab'), 'a spawn bind kept its raw action name');
  // The ActivateTab loop still contributes one summarized row.
  assert.match(wez, /Jump straight to tab/);
});

test('WezTerm reach-across: WSL sheet finds the Windows-side config on /mnt/c', {
  skip: (process.env.WSL_DISTRO_NAME && fs.existsSync('/mnt/c/Users')) ? false
    : 'requires WSL with a Windows-side wezterm.lua',
}, () => {
  // Empty local XDG + empty HOME, but WSL_DISTRO_NAME kept -> the generator should probe
  // /mnt/c/Users/*/.config/wezterm/wezterm.lua and surface WezTerm anyway.
  const home = tmpdir(), xdg = tmpdir();
  const html = runGen({ home, xdg, keepWsl: true });
  assert.match(html, /<h2>WezTerm<\/h2>/);
});
