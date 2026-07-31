// Ghostty's config was macOS-only until Linux was added. The move is riskier than it looks: the
// file is one template rendered for both platforms, and the failure modes are quiet ones —
// a macOS-only key that Ghostty merely warns about on Linux, a cmd+ bind that Linux can never
// produce, or two binds colliding on one chord because the modifier mapping collapsed them.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'home');
const SRC = path.join(SOURCE, 'dot_config', 'ghostty', 'config.tmpl');
const body = fs.readFileSync(SRC, 'utf8');
const ignore = fs.readFileSync(path.join(SOURCE, '.chezmoiignore'), 'utf8');

let toolsOk = true;
try { execFileSync('chezmoi', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'chezmoi not on PATH';

// Memoised, and --source-pinned, for the same reasons as install-cli-tools.test.js: the template
// does not vary between these tests, and every `chezmoi execute-template` opens chezmoi's
// bolt-backed state, so re-rendering in each of five tests contends with the parallel suite.
let rendered;
const render = () =>
  (rendered ??= execFileSync('chezmoi', ['--source', SOURCE, 'execute-template'], { input: body, encoding: 'utf8' }));

test('the darwin branch keeps its original modifiers', () => {
  // The macOS render must be unchanged by the Linux port, so the defaults stay cmd-based and only
  // a non-darwin OS reassigns them.
  assert.match(body, /\$mod := "cmd"/);
  assert.match(body, /\$mod2 := "cmd\+shift"/);
  assert.match(body, /\$clip := "cmd\+shift"/);
  assert.match(body, /if ne \.chezmoi\.os "darwin"/, 'only non-darwin remaps the modifiers');
  assert.match(body, /if eq \.chezmoi\.os "darwin"/, 'the macos-* block must be darwin-gated');
});

test('ghostty config deploys on Linux but not Windows', () => {
  // It used to be ignored on everything but darwin. Ghostty has no Windows build, so the gate
  // moved rather than disappeared — if it vanished entirely, Windows would get a dead config.
  const windowsBlock = ignore.match(/{{ if eq \.chezmoi\.os "windows" }}([\s\S]*?){{ end }}/);
  assert.ok(windowsBlock, 'the windows ignore block must exist');
  assert.match(windowsBlock[1], /^\.config\/ghostty$/m, 'ghostty config is ignored on Windows');
  const darwinBlock = ignore.match(/{{ if ne \.chezmoi\.os "darwin" }}([\s\S]*?){{ end }}/);
  assert.doesNotMatch(darwinBlock[1], /\.config\/ghostty/,
    'ghostty config must no longer be ignored on every non-darwin OS');
});

test('the Linux render carries no macOS-only settings', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  const out = render();
  assert.doesNotMatch(out, /^macos-/m, 'macos-* keys are dead weight on Linux');
  assert.doesNotMatch(out, /display-p3/, 'display-p3 is a macOS-only colorspace');
  assert.doesNotMatch(out, /cmd\+/, 'no cmd chord can be produced on Linux');
});

test('the Linux render uses conventional terminal chords', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  const out = render();
  // ctrl+c is SIGINT, so clipboard and reload must sit on ctrl+shift — the Linux convention and
  // Ghostty's own default there.
  assert.match(out, /keybind = ctrl\+shift\+c=copy_to_clipboard/);
  assert.match(out, /keybind = ctrl\+shift\+v=paste_from_clipboard/);
  assert.match(out, /keybind = ctrl\+shift\+r=reload_config/);
  assert.match(out, /keybind = ctrl\+alt\+t=new_window/, 'the shifted variant needs its own modifier');
});

test('no two keybinds claim the same chord', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  // The real hazard of collapsing cmd/cmd+shift onto ctrl+shift: two actions silently landing on
  // one chord, where Ghostty keeps the last and the other action just stops working.
  const chords = [...render().matchAll(/^keybind = ([^=]+)=/gm)].map((m) => m[1]);
  const seen = new Set();
  for (const c of chords) {
    assert.ok(!seen.has(c), `chord ${c} is bound twice`);
    seen.add(c);
  }
  assert.ok(chords.length >= 13, 'sanity: the keybind block rendered');
});

test('no config key is emitted twice', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  // Gating a key by wrapping it in a conditional is easy to get wrong by leaving the original in
  // place; Ghostty would then take the last value silently.
  const keys = [...render().matchAll(/^([a-z][a-z0-9-]*) = /gm)].map((m) => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i && k !== 'keybind' && k !== 'font-feature');
  assert.deepStrictEqual([...new Set(dupes)], [], 'these keys render more than once');
});

test('the font family matches what the nerd-font installer provides', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  const fontScript = fs.readFileSync(
    path.join(SOURCE, '.chezmoiscripts', 'os-linux', 'run_onchange_install-nerd-font.sh.tmpl'), 'utf8');
  const family = render().match(/^font-family = "([^"]+)"/m)[1];
  // The installer takes only the Mono faces, so a config asking for a proportional or variable
  // face would render with a fallback font and no Nerd Font glyphs.
  assert.match(family, /IosevkaTerm Nerd Font Mono/,
    'the configured family must be one the installer actually installs');
  assert.match(fontScript, /IosevkaTerm Nerd Font Mono/);
  assert.match(fontScript, /Mono\*\.ttf/, 'the installer must filter to the Mono faces');
});
