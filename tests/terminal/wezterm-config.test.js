// Render + lint checks for the WezTerm config template. The template is Windows-only
// and Lua, so there was no coverage: a renamed `.chezmoidata/terminal.toml` key would
// silently emit `config.font_size = .0` and only surface live. These tests render the
// real template with `chezmoi execute-template` and assert the output is complete and
// well-formed. Skips off-Windows (data + `.chezmoi.os` differ) or when chezmoi is absent.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile } = require('../lib/render');
const { have } = require('../lib/probe');

const REPO = path.join(__dirname, '..', '..');
const TMPL = path.join(REPO, 'home', 'dot_config', 'wezterm', 'wezterm.lua.tmpl');

const skip = process.platform !== 'win32' ? 'windows-only config'
  : !have('chezmoi') ? 'chezmoi unavailable' : false;

// Locate a parse-only Lua checker. DEVCOM.Lua (provisioned by the winget installer) drops
// luac.exe under %LOCALAPPDATA%\Programs\Lua\bin and does NOT add it to PATH, so probe that
// dir before falling back to a bare `luac` on PATH. Returns the command, or '' if absent.
function findLuac() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Lua', 'bin', 'luac.exe');
  if (fs.existsSync(local)) return local;
  try { execFileSync('luac', ['-v'], { stdio: 'ignore' }); return 'luac'; } catch { return ''; }
}
const luac = findLuac();

const render = () => renderFile(TMPL, { source: null, cwd: REPO });

test('template renders with no unexpanded chezmoi directives', { skip }, () => {
  const out = render();
  assert.ok(out.length > 0, 'render produced output');
  assert.ok(!out.includes('{{') && !out.includes('}}'), 'no leftover {{ }} template markers');
});

test('font_size renders as a numeric literal (catches a missing data key)', { skip }, () => {
  const out = render();
  // A dropped `.terminal.font_size` would leave `config.font_size = .0` — invalid Lua.
  assert.match(out, /config\.font_size = \d+(?:\.\d+)?\b/, 'font_size is a number');
  assert.doesNotMatch(out, /config\.font_size = \.\d/, 'no leading-dot font_size');
});

test('required config keys survive rendering', { skip }, () => {
  const out = render();
  for (const needle of [
    'config.front_end = "WebGpu"',
    'config.max_fps = 255',                   // u8 ceiling — 299Hz display headroom
    'config.webgpu_present_mode = "Mailbox"', // Windows input-latency fix (wezterm#5400)
    'config.window_decorations = "INTEGRATED_BUTTONS|RESIZE"',
    'config.mouse_bindings',                          // copy-on-select / right-click paste
    'wezterm.on("format-tab-title"',                  // custom tab titles
    'config.default_domain = "WSL:Ubuntu"',
    'default_cwd = "~/dev"',                          // trusted non-$HOME landing dir (trust persistence)
    'config.default_prog = { git_bash',
    'local git_bash = first_existing(',   // single-source Git Bash path (probed at runtime)
    '"agentview; exec bash -li"',           // CTRL+SHIFT+S picker tab
    'tmux new-session -A -s main',          // CTRL+SHIFT+H homelab tab
    'act.SpawnTab({ DomainName = "WSL:Ubuntu" })', // CTRL+ALT+T WSL-pinned tab
    'config.inactive_pane_hsb',             // ghostty unfocused-split-opacity parity
    'config.use_resize_increments = true',  // ghostty window-step-resize parity
    'config.notification_handling = "SuppressFromFocusedPane"', // command-finish notify
    'act.ScrollToPrompt(',                  // prompt jumps over OSC 133 marks
  ]) {
    assert.ok(out.includes(needle), `rendered config contains: ${needle}`);
  }
});

test('rendered Lua parses cleanly (luac -p)', { skip: skip || (!luac && 'luac not installed') }, () => {
  const out = render();
  const tmp = path.join(os.tmpdir(), `wezterm-render-${process.pid}.lua`);
  fs.writeFileSync(tmp, out);
  try {
    // Parse-only: exits non-zero solely on a syntax error (never runs require), so this
    // catches an unexpanded `{{ ... }}` directive or malformed render, not just style.
    execFileSync(luac, ['-p', tmp], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// --- open-uri: WSL file:// -> UNC -------------------------------------------------
// Everything above skips off-Windows, which leaves the one piece of real logic in this
// config unexercised on the machine that edits it. `wsl_file_uri_to_unc` takes `distro`
// as a parameter and calls no wezterm API precisely so it can be lifted out and run
// under plain `lua` anywhere.
function findLua() {
  for (const cmd of ['lua', 'lua5.4']) {
    try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return cmd; } catch { /* try next */ }
  }
  return '';
}
const lua = findLua();
const luaSkip = lua ? false : 'lua not installed';

function translate(uris, distro = 'Ubuntu') {
  const fn = fs.readFileSync(TMPL, 'utf8').match(/^local function wsl_file_uri_to_unc[\s\S]*?^end$/m);
  assert.ok(fn, 'wsl_file_uri_to_unc must be liftable from the template');
  const harness = `${fn[0]}
for _, uri in ipairs({ ${uris.map((u) => JSON.stringify(u)).join(', ')} }) do
\tlocal out = wsl_file_uri_to_unc(uri, ${JSON.stringify(distro)})
\tprint(out == nil and "<nil>" or out)
end
`;
  const tmp = path.join(os.tmpdir(), `wezterm-openuri-${process.pid}.lua`);
  fs.writeFileSync(tmp, harness);
  try {
    return execFileSync(lua, [tmp], { encoding: 'utf8' }).replace(/\n$/, '').split('\n');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

test('a WSL file:// link is rewritten onto the wsl.localhost share', { skip: luaSkip }, () => {
  assert.deepStrictEqual(translate([
    'file:///home/daniel/.claude/artifacts/report.html',
    'file://localhost/home/daniel/notes.md',
    'file:///home/daniel/my%20report.html',      // spaces survive the decode
  ]), [
    '\\\\wsl.localhost\\Ubuntu\\home\\daniel\\.claude\\artifacts\\report.html',
    '\\\\wsl.localhost\\Ubuntu\\home\\daniel\\notes.md',
    '\\\\wsl.localhost\\Ubuntu\\home\\daniel\\my report.html',
  ]);
});

test('links Windows can already resolve are left to WezTerm', { skip: luaSkip }, () => {
  // Rewriting any of these would break a link that works today.
  assert.deepStrictEqual(translate([
    'file:///C:/Users/daniel/report.html',        // drive path
    'file:///c%3A/Users/daniel/report.html',      // drive path, colon percent-encoded
    'file://wsl.localhost/Ubuntu/home/daniel/x',  // already UNC
    'file://otherhost/share/x',                   // another machine
    'https://example.com/x',                      // not a file link
    'mailto:someone@example.com',
  ]), ['<nil>', '<nil>', '<nil>', '<nil>', '<nil>', '<nil>']);
});

test('a percent-escape cannot smuggle a separator into the rewritten path', { skip: luaSkip }, () => {
  // %5C decodes to a backslash, so without the guard the opened path would not be the
  // one the link displayed.
  assert.deepStrictEqual(translate(['file:///home/daniel/a%5C..%5Cb']), ['<nil>']);
});

test('the distro is a parameter, not baked into the translation', { skip: luaSkip }, () => {
  assert.deepStrictEqual(translate(['file:///home/daniel/x'], 'Debian'),
    ['\\\\wsl.localhost\\Debian\\home\\daniel\\x']);
});

test('the open-uri handler is registered and suppresses the default open', () => {
  const src = fs.readFileSync(TMPL, 'utf8');
  assert.match(src, /wezterm\.on\("open-uri"/, 'handler is registered');
  // Without `return false` WezTerm ALSO hands the original /home/... URI to
  // ShellExecute, reopening the broken path behind the rewritten one.
  assert.match(src, /wezterm\.open_with\(unc\)\s*\n\s*return false/, 'default open suppressed');
});
