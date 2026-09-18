// Ghostty's config was macOS-only until Linux was added. The move is riskier than it looks: the
// file is one template rendered for both platforms, and the failure modes are quiet ones —
// a macOS-only key that Ghostty merely warns about on Linux, a cmd+ bind that Linux can never
// produce, or two binds colliding on one chord because the modifier mapping collapsed them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('dot_config', 'ghostty', 'config.tmpl');
const body = fs.readFileSync(SRC, 'utf8');
const ignore = fs.readFileSync(srcPath('.chezmoiignore'), 'utf8');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// --source-pinned so these five tests read this checkout's .chezmoiignore, not the deployed one.
const render = () => renderTemplate(body, { source: srcPath() });

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
  // Ghostty parses cmd as an alias for super, so a cmd chord left in the Linux render would
  // quietly work rather than error — and hide the fact that the template failed to remap it.
  // Scoped to the bound chords rather than the whole file, because the prose that explains the
  // mapping has to name cmd to do so.
  const chords = [...out.matchAll(/^keybind = ([^=]+)=/gm)].map((m) => m[1]);
  assert.deepStrictEqual(chords.filter((c) => c.includes('cmd')), [],
    'the Linux render must spell the modifier super, not cmd');
});

test('the Linux render uses conventional terminal chords', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  const out = render();
  // ctrl+c is SIGINT, so clipboard and reload must sit on ctrl+shift — the Linux convention and
  // Ghostty's own default there.
  assert.match(out, /keybind = ctrl\+shift\+c=copy_to_clipboard/);
  assert.match(out, /keybind = ctrl\+shift\+v=paste_from_clipboard/);
  assert.match(out, /keybind = ctrl\+shift\+r=reload_config/);
  assert.match(out, /keybind = super\+shift\+t=new_window/, 'the shifted variant needs its own modifier');
});

test('the Linux render keeps every Mac chord on super', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  const out = render();
  // super is the point of the Linux mapping: it is the one modifier neither the shell nor a
  // full-screen app claims, so the Mac chords keep their shape instead of being reshuffled.
  assert.match(out, /keybind = super\+t=new_tab/);
  assert.match(out, /keybind = super\+w=close_surface/);
  assert.match(out, /keybind = super\+d=new_split:right/);
  assert.match(out, /keybind = super\+\[=goto_split:previous/);
  assert.match(out, /keybind = super\+\]=goto_split:next/);
  // cmd+c/cmd+v are Ghostty's own defaults on darwin but not on Linux, so the super pair has to
  // be stated explicitly for the Mac reflex to work here.
  assert.match(out, /keybind = super\+c=copy_to_clipboard/);
  assert.match(out, /keybind = super\+v=paste_from_clipboard/);
});

test('no bind steals a control code the terminal needs', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  // The whole reason the mapping is super and not ctrl. Each of these is load-bearing, and
  // Ghostty binding it means the byte never reaches the shell — ctrl+[ is the sharpest, since
  // it *is* Escape and taking it breaks vim outright with no obvious culprit.
  const forbidden = { d: 'EOF', w: 'zsh kill-word and vim window prefix', '[': 'Escape', ']': 'vim tag-jump', c: 'SIGINT' };
  const bound = [...render().matchAll(/^keybind = ([^=]+)=/gm)].map((m) => m[1]);
  for (const [key, why] of Object.entries(forbidden)) {
    assert.ok(!bound.includes(`ctrl+${key}`), `ctrl+${key} is ${why}; it must not be bound`);
  }
  // ctrl+t is the deliberate exception: its only occupant is fzf's file widget, which
  // dot_zshrc.tmpl moves to alt+t. If this bind goes, that rebind is dead weight.
  assert.ok(bound.includes('ctrl+t'), 'ctrl+t=new_tab is the alias for Mac muscle memory');
  const zshrc = fs.readFileSync(srcPath('dot_zshrc.tmpl'), 'utf8');
  assert.match(zshrc, /bindkey '\^\[t' fzf-file-widget/, 'fzf needs a home once ctrl+t is taken');
});

test('KDE gives up every super chord the config claims', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  // A KWin global shortcut is consumed before the focused window sees the key, so a super bind
  // that collides with one is not a conflict Ghostty can win — it just silently does nothing.
  const script = fs.readFileSync(srcPath('.chezmoiscripts', 'os-linux',
    'run_onchange_kde-free-ghostty-chords.sh.tmpl'), 'utf8');
  const freed = [...script.matchAll(/^\s*'[a-z]+\|([^|]+)\|Meta\+Ctrl\+/gm)].map((m) => m[1]);
  for (const key of ['Edit Tiles', 'Overview', 'Show Desktop', 'show-on-mouse-pos']) {
    assert.ok(freed.includes(key), `KWin's ${key} still owns a chord Ghostty needs`);
  }
  // The script must re-run when the keybinds change, or a newly added super chord would collide
  // with a KDE default and nothing would prompt anyone to check.
  assert.match(script, /include "dot_config\/ghostty\/config\.tmpl" \| sha256sum/,
    'run_onchange must be keyed on the ghostty config it exists to support');
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
    srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_install-nerd-font.sh.tmpl'), 'utf8');
  const family = render().match(/^font-family = "([^"]+)"/m)[1];
  // The installer takes only the Mono faces, so a config asking for a proportional or variable
  // face would render with a fallback font and no Nerd Font glyphs.
  assert.match(family, /IosevkaTerm Nerd Font Mono/,
    'the configured family must be one the installer actually installs');
  assert.match(fontScript, /IosevkaTerm Nerd Font Mono/);
  assert.match(fontScript, /Mono\*\.ttf/, 'the installer must filter to the Mono faces');
});

test('selections land in the clipboard, not only PRIMARY', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  // `copy-on-select = true` (the default) writes PRIMARY only, so Ctrl+V pastes whatever was in
  // the clipboard beforehand. Anchored to the value, not the key: `true` would satisfy a bare
  // presence check while reintroducing the bug.
  assert.match(render(), /^copy-on-select = clipboard$/m);
});

test('Ghostty accepts the copy-on-select value', { skip }, (t) => {
  if (process.platform !== 'linux') return t.skip('renders the darwin branch off Linux');
  try {
    execFileSync('ghostty', ['--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('ghostty not installed');
  }
  // A rejected value leaves the key at its default and Ghostty only warns, so the config would
  // look right and behave wrong. Validation goes through a file: `+validate-config` exits 1 on
  // the `--copy-on-select=...` flag form regardless of whether the value is legal.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostty-cfg-'));
  try {
    const conf = path.join(dir, 'config');
    fs.writeFileSync(conf, `${render().match(/^copy-on-select = .*$/m)[0]}\n`);
    execFileSync('ghostty', ['+validate-config', `--config-file=${conf}`], { stdio: 'ignore' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
