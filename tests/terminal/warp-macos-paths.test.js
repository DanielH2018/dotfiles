// Warp reads its config from a different place on each OS
// (docs.warp.dev/terminal/settings/file-locations):
//
//   macOS   ~/.warp/{settings.toml,keybindings.yaml,themes/,tab_configs/}
//   Linux   $XDG_CONFIG_HOME/warp-terminal/{settings.toml,keybindings.yaml}
//           $XDG_DATA_HOME/warp-terminal/{themes/,tab_configs/}
//
// This repo tracked only the Linux paths, so every Warp preference here -- theme, font,
// keybindings, tab configs -- deployed to a Mac and was read by nothing. `chezmoi status` was
// clean the whole time, because the files it manages did match their source. That is the
// failure these tests exist for: nothing else in the repo notices a config that deploys
// correctly to a path the application never opens.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderFile, renderTemplate, chezmoiAvailable, SOURCE } = require('../lib/render');

const skip = chezmoiAvailable ? false : 'chezmoi unavailable';
const MAC = path.join(SOURCE, 'dot_warp');
const XDG = path.join(SOURCE, 'dot_config', 'warp-terminal');
const IGNORE = path.join(SOURCE, '.chezmoiignore');

const ignored = (data) =>
  new Set(renderFile(IGNORE, { data }).split('\n').map((l) => l.trim()).filter(Boolean));

// The two files Warp writes itself exist at both paths, so a recapture on either OS has
// somewhere to land.
for (const name of ['settings.toml', 'keybindings.yaml']) {
  test(`${name} is tracked for both macOS and Linux`, () => {
    assert.ok(fs.existsSync(path.join(MAC, `${name}.tmpl`)), `~/.warp/${name} is not tracked`);
    assert.ok(fs.existsSync(path.join(XDG, `${name}.tmpl`)), `the XDG ${name} is not tracked`);
  });

  test(`both ${name} wrappers render the same bytes`, { skip }, () => {
    // Two wrappers, one body. If they ever diverge the drift is invisible -- each machine reads
    // one of them, so a Mac and a Linux box would disagree with nobody there to compare.
    const mac = renderFile(path.join(MAC, `${name}.tmpl`));
    const xdg = renderFile(path.join(XDG, `${name}.tmpl`));
    assert.strictEqual(mac, xdg, `the ${name} wrappers have drifted apart`);
    assert.ok(mac.length > 0, 'an empty render would satisfy equality and deploy nothing');
  });
}

test('themes and tab_configs are symlinks into the XDG data tree', { skip }, () => {
  // Warp only reads these two, so a symlink is safe -- unlike settings.toml, which Warp
  // rewrites, and where an atomic write+rename would replace the link with a regular file.
  for (const dir of ['themes', 'tab_configs']) {
    const src = path.join(MAC, `symlink_${dir}.tmpl`);
    assert.ok(fs.existsSync(src), `~/.warp/${dir} is not tracked`);
    const target = renderFile(src).trim();
    assert.ok(target.endsWith(`/.local/share/warp-terminal/${dir}`),
      `~/.warp/${dir} points at ${target}, not the XDG data tree`);
    assert.ok(fs.existsSync(path.join(SOURCE, 'dot_local', 'share', 'warp-terminal', dir)),
      `${dir} is symlinked but not tracked, so the link would dangle`);
  }
});

test('the tab-config dir template agrees with the symlink it resolves through', { skip }, () => {
  // On macOS `default_tab_config_path` names ~/.warp/tab_configs, which is the symlink above.
  // Both come from this one template, so they cannot disagree -- this pins that they still do.
  const dir = renderTemplate('{{ includeTemplate "warp-tab-configs-dir" . }}').trim();
  assert.match(dir, /\/(\.warp|\.local\/share\/warp-terminal)\/tab_configs$/,
    `the tab config dir rendered as ${dir}, which is neither OS's path`);
  assert.doesNotMatch(dir, /\{\{|\}\}/, 'the render left a template action unexpanded');
});

test('each machine deploys exactly one of the two settings paths', { skip }, () => {
  // Both are tracked; a machine that deployed both would have a second file that looks
  // authoritative, and a recapture pasted into the wrong one changes nothing at all.
  const gates = ignored({});
  const mac = gates.has('.warp');
  const xdg = gates.has('.config/warp-terminal');
  assert.ok(mac !== xdg, 'exactly one of .warp / .config/warp-terminal must be ignored here');
  assert.strictEqual(xdg, process.platform === 'darwin',
    'the XDG pair is the dead one on macOS and the live one everywhere else');
});

test('both gate arms name a path, on any host profile', { skip }, () => {
  // The gate is on .chezmoi.os, which no test can override -- .data overrides reach .work and
  // .profile only. So the arm for the other OS is unreachable at render time here, and this
  // reads the source text instead. An arm that named nothing would ignore nothing and deploy
  // both copies, silently.
  const raw = fs.readFileSync(IGNORE, 'utf8');
  const gate = raw.match(/\{\{ if eq \.chezmoi\.os "darwin" \}\}\n([^]*?)\{\{ end \}\}/);
  assert.ok(gate, 'the per-OS Warp gate is gone; both copies would deploy everywhere');
  assert.match(gate[1], /^\.config\/warp-terminal$/m, 'the darwin arm must ignore the XDG pair');
  assert.match(gate[1], /^\.warp$/m, 'the non-darwin arm must ignore ~/.warp');
  for (const work of [true, false]) {
    assert.ok(ignored({ work }).has(process.platform === 'darwin' ? '.config/warp-terminal' : '.warp'),
      `the gate stopped firing with work=${work}`);
  }
});
