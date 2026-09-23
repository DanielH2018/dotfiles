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
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const GEN = srcPath('dot_local', 'bin', 'executable_terminal-cheatsheet');

// Run the generator against a fixture and return the emitted HTML. keepWsl=false strips
// WSL_DISTRO_NAME so the /mnt/c reach-across is disabled (deterministic fixture-only runs).
function runGen({ home, xdg, keepWsl = false }) {
  const dir = scratch(os.tmpdir(), 'cheatsheet-');
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
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeKeybindings(home, SAMPLE_BINDINGS);
  const html = runGen({ home, xdg });

  assert.match(html, /<h2>Claude Code<\/h2>/);
  assert.match(html, /--accent:var\(--peach\)/);
  assert.match(html, /Built-ins \+ custom overrides/);
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

test('Each card is a collapsible <details> with a clickable summary header', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeKeybindings(home, SAMPLE_BINDINGS);
  writeWezterm(xdg, WEZTERM_FIXTURE);
  const html = runGen({ home, xdg });

  // No card is a bare <section> anymore; every card renders as an open <details>.
  assert.ok(!html.includes('<section class="card"'), 'cards must not be <section> elements');
  const details = html.match(/<details class="card"[^>]*>/g) || [];
  assert.strictEqual(details.length, 2, 'one <details> per rendered card (WezTerm + Claude in this fixture)');
  for (const tag of details) assert.match(tag, /\bopen\b/, 'cards start expanded');
  // Header is the <summary> click target and carries the rotating chevron.
  const summaries = html.match(/<summary class="card-head">/g) || [];
  assert.strictEqual(summaries.length, details.length, 'each card has a summary header');
  assert.ok(html.includes('<span class="chev">'), 'chevron affordance present');
});

test('Claude labels: unknown action id falls back to a de-camel-cased phrase', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeKeybindings(home, { bindings: [{ context: 'Chat', bindings: { 'ctrl+g': 'chat:someNewThing' } }] });
  const html = runGen({ home, xdg });
  assert.match(html, /Some new thing/);
});

test('Claude card omitted (no crash) when keybindings.json is absent', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-'); // neither populated
  const html = runGen({ home, xdg });
  assert.ok(!html.includes('<h2>Claude Code</h2>'), 'Claude card should be absent');
  assert.match(html, /No WezTerm \/ Ghostty \/ Neovim \/ Yazi \/ Claude Code configs found/);
});

test('Claude card: malformed keybindings.json falls back to built-ins only (no crash)', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'keybindings.json'), '{ this is not json');
  const html = runGen({ home, xdg });
  assert.match(html, /<h2>Claude Code<\/h2>/);
  assert.match(html, /<h3>Built-in<\/h3>/);
  assert.match(html, /built-in keymap/);
  assert.ok(!html.includes('Toggle to-do panel'), 'custom overrides must not render from malformed json');
});

test('Claude card: built-in defaults render alongside custom overrides', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeKeybindings(home, SAMPLE_BINDINGS);
  const html = runGen({ home, xdg });
  assert.match(html, /<h3>Built-in<\/h3>/);
  assert.match(html, /<h3>Transcript mode \(Ctrl\+O\)<\/h3>/);
  assert.match(html, /<kbd>Ctrl<\/kbd><span class="plus">\+<\/span><kbd>O<\/kbd>/);
  assert.ok(html.includes('Transcript mode — browse the full session history'), 'Ctrl+O built-in missing');
  // Custom context groups still render next to the built-in ones.
  assert.match(html, /<h3>Global<\/h3>/);
  assert.match(html, /Toggle to-do panel/);
});

// The built-ins are hand-curated rather than parsed, so nothing but a test stops a wrong
// row from shipping. These pin the two the docs contradict most easily.
test('Claude built-ins match the documented keymap', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeKeybindings(home, SAMPLE_BINDINGS);
  const html = runGen({ home, xdg });
  // Extended thinking is Alt+T / Option+T. Tab is autocomplete and must never claim it.
  assert.match(html, /<kbd>Alt<\/kbd><span class="plus">\+<\/span><kbd>T<\/kbd>/);
  assert.ok(html.includes('Toggle extended thinking'), 'extended-thinking row missing');
  assert.ok(!/<kbd>Tab<\/kbd>[^]{0,120}extended thinking/.test(html),
    'Tab must not be labeled as the extended-thinking toggle');
  // Permission modes are named default(Manual)/acceptEdits/plan — "auto-accept" is not a
  // mode, and `auto` is a separate one, so the old label was actively misleading.
  assert.ok(html.includes('acceptEdits'), 'permission mode names must match the docs');
  assert.ok(!html.includes('auto-accept'), 'auto-accept is not a permission mode name');
});

// The common real-world state: everyone running Claude Code has ~/.claude, almost nobody
// has keybindings.json. This is the branch the built-ins exist to serve.
test('Claude card: built-ins render when ~/.claude exists but keybindings.json does not', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const html = runGen({ home, xdg });
  assert.match(html, /<h2>Claude Code<\/h2>/);
  assert.match(html, /<h3>Built-in<\/h3>/);
  assert.match(html, /<h3>Transcript mode \(Ctrl\+O\)<\/h3>/);
  assert.match(html, /built-in keymap/);
  assert.match(html, /<span class="chip"><b>Scope<\/b>Built-ins<\/span>/);
});

test('Claude card: a custom context colliding with a built-in group keeps both', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeKeybindings(home, { bindings: [{ context: 'Built-in', bindings: { 'ctrl+g': 'chat:someNewThing' } }] });
  const html = runGen({ home, xdg });
  assert.ok(html.includes('Some new thing'), 'custom bind dropped by the built-in group of the same name');
  assert.ok(html.includes('Transcript mode — browse the full session history'), 'built-in rows dropped');
});

test('Layout: cards flow into independent columns, not shared grid rows', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeKeybindings(home, SAMPLE_BINDINGS);
  writeWezterm(xdg, WEZTERM_FIXTURE);
  const html = runGen({ home, xdg });
  // Grid rows size to the tallest card in the row, pushing down cards in other columns.
  assert.ok(!html.includes('grid-template-columns'), 'main must not lay cards out on a shared grid');
  assert.match(html, /\.col\{[^}]*flex-direction:column/, 'per-column stack CSS missing');
  assert.ok(html.includes("className:'col'"), 'column-building script missing');
  // The .col wrappers are script-built, so the served markup has none: main must stack in a
  // single column until they exist, or every card flashes squeezed into one flex row.
  assert.ok(!html.includes('class="col"'), 'columns are built by script, not emitted');
  assert.match(html, /main\{[^}]*flex-direction:column/, 'pre-script main must be a single-column stack');
  assert.match(html, /main:has\(\.col\)\{flex-direction:row/, 'main must go horizontal only once columns exist');
  // Filtering changes which cards are visible, so the deal has to be redone — otherwise a
  // hidden card holds its slot and leaves a blank column 1/n of the page wide.
  assert.match(html, /relayout\(true\); \/\/ the visible set changed/, 'filter must force a redeal');
});

test('WezTerm: action_callback and multiline spawn binds are parsed and labeled', () => {
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  writeWezterm(xdg, WEZTERM_FIXTURE);
  const html = runGen({ home, xdg });
  const wez = html.split('data-tool="wezterm"')[1].split('</details>')[0];

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
  const home = scratch(os.tmpdir(), 'cheatsheet-'), xdg = scratch(os.tmpdir(), 'cheatsheet-');
  const html = runGen({ home, xdg, keepWsl: true });
  assert.match(html, /<h2>WezTerm<\/h2>/);
});

// --- the library seam ---------------------------------------------------------------
// Everything above runs the generator as a subprocess, which is blind to how the code is
// arranged behind the CLI. These load the modules directly: each parser has to stand on
// its own, and each takes its config root as an argument, which is what makes a parser
// testable without staging a whole fixture $HOME.

const LIB = srcPath('dot_local', 'share', 'terminal-cheatsheet');

test('each parser module loads on its own and declines an empty config root', () => {
  const empty = scratch(os.tmpdir(), 'cheatsheet-');
  // The same /mnt/c reach-across the subprocess runs disable with keepWsl=false, applied to the
  // in-process seam. These require() the parsers directly, so they inherit THIS process's
  // environment: on a WSL box weztermFile() then falls back to /mnt/c/Users/*/.config/wezterm and
  // parseWezterm returned the host's real binds for an empty root. That is a correct answer to a
  // different question than the one this test asks, which is whether a parser handed an empty
  // config root declines it.
  const wsl = process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_DISTRO_NAME;
  try {
    const cases = [
      ['wezterm', 'parseWezterm'], ['ghostty', 'parseGhostty'],
      ['nvim', 'parseNvim'], ['yazi', 'parseYazi'],
    ];
    for (const [file, fn] of cases) {
      const mod = require(path.join(LIB, 'parsers', `${file}.js`));
      assert.strictEqual(typeof mod[fn], 'function', `${file}.js must export ${fn}`);
      assert.strictEqual(mod[fn](empty), null, `${fn} must return null for an empty root`);
    }
    // Claude keys off $HOME rather than a config root, and reports nothing when ~/.claude
    // is absent — the one card that renders from built-ins alone when the dir does exist.
    const { parseClaude } = require(path.join(LIB, 'parsers', 'claude.js'));
    assert.strictEqual(parseClaude(empty), null);
  } finally {
    if (wsl !== undefined) process.env.WSL_DISTRO_NAME = wsl;
  }
});

test('a parser reads a fixture root passed as an argument', () => {
  const xdg = scratch(os.tmpdir(), 'cheatsheet-');
  fs.mkdirSync(path.join(xdg, 'ghostty'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'ghostty', 'config'),
    'font-family = "Test Mono"\nkeybind = ctrl+shift+t=new_tab\n# keybind = ctrl+q=quit\n');
  const { parseGhostty } = require(path.join(LIB, 'parsers', 'ghostty.js'));
  const card = parseGhostty(xdg);
  assert.strictEqual(card.title, 'Ghostty');
  assert.deepStrictEqual(card.binds, [{ combo: '⌃+⇧+T', desc: 'New tab' }], 'commented-out binds stay out');
  assert.deepStrictEqual(card.settings.find((s) => s[0] === 'Font'), ['Font', 'Test Mono']);
});

test('assets are interpolated without their trailing newline', () => {
  // Inline, the stylesheet and script ended at their last brace. As files they end with a
  // newline, and emitting it would shift every byte after it in the page.
  const { asset } = require(path.join(LIB, 'render.js'));
  for (const name of ['page.css', 'page.js']) {
    assert.ok(!/\n$/.test(asset(name)), `${name} must be interpolated without a trailing newline`);
    assert.ok(fs.readFileSync(path.join(LIB, 'assets', name), 'utf8').endsWith('\n'),
      `${name} must still be a well-formed file on disk`);
  }
  const { THEME_CSS } = require(path.join(LIB, '..', 'html-kit'));
  assert.ok(!/\n$/.test(asset(THEME_CSS)), 'the shared theme must be interpolated without a trailing newline');
  assert.ok(asset(THEME_CSS).startsWith(':root{'), 'the shared theme starts at the palette');
});

test('a missing asset fails when the page is built, not when render.js loads', () => {
  // render.js is already loaded by the test above without throwing, which is half of this.
  const { asset } = require(path.join(LIB, 'render.js'));
  assert.throws(() => asset('no-such-asset.css'), /ENOENT/);
});

test('the browser asset parses as JavaScript', () => {
  // Nothing reads this file until a browser does, so a syntax error in it would otherwise
  // only show up as a dead filter box on the rendered page.
  const r = require('node:child_process').spawnSync(
    process.execPath, ['--check', path.join(LIB, 'assets', 'page.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `page.js must parse: ${r.stderr}`);
});

