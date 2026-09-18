// Warp reads its config from a different place on each OS
// (docs.warp.dev/terminal/settings/file-locations):
//
//   macOS   ~/.warp/{settings.toml,keybindings.yaml,themes/,tab_configs/}
//   Linux   $XDG_CONFIG_HOME/warp-terminal/{settings.toml,keybindings.yaml}
//           $XDG_DATA_HOME/warp-terminal/{themes/,tab_configs/}
//   Windows %LOCALAPPDATA%\warp\Warp\config\{settings.toml,keybindings.yaml}
//           %APPDATA%\warp\Warp\data\{themes\,tab_configs\}
//
// Windows gets a real file tree rather than the symlink bridge macOS uses, because creating a
// symlink there needs administrator privilege even with Developer Mode on. The files are
// one-line wrappers that `include` the XDG copy unrendered, so the content has one source.
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
const { renderFile, renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const skip = chezmoiAvailable ? false : 'chezmoi unavailable';
const MAC = srcPath('dot_warp');
const XDG = srcPath('dot_config', 'warp-terminal');
const WINDOWS = srcPath('AppData', 'Local', 'warp', 'Warp', 'config');
const IGNORE = srcPath('.chezmoiignore');

const ignored = (data) =>
  new Set(renderFile(IGNORE, { data }).split('\n').map((l) => l.trim()).filter(Boolean));

// The two files Warp writes itself exist at both paths, so a recapture on either OS has
// somewhere to land.
for (const name of ['settings.toml', 'keybindings.yaml']) {
  test(`${name} is tracked for macOS, Linux and Windows`, () => {
    assert.ok(fs.existsSync(path.join(MAC, `${name}.tmpl`)), `~/.warp/${name} is not tracked`);
    assert.ok(fs.existsSync(path.join(XDG, `${name}.tmpl`)), `the XDG ${name} is not tracked`);
    assert.ok(fs.existsSync(path.join(WINDOWS, `${name}.tmpl`)), `the Windows ${name} is not tracked`);
  });

  test(`all three ${name} wrappers render the same bytes`, { skip }, () => {
    // Three wrappers, one body. If they ever diverge the drift is invisible -- each machine
    // reads one of them, so the boxes would disagree with nobody there to compare.
    const mac = renderFile(path.join(MAC, `${name}.tmpl`));
    const xdg = renderFile(path.join(XDG, `${name}.tmpl`));
    const win = renderFile(path.join(WINDOWS, `${name}.tmpl`));
    assert.strictEqual(mac, xdg, `the macOS and XDG ${name} wrappers have drifted apart`);
    assert.strictEqual(mac, win, `the macOS and Windows ${name} wrappers have drifted apart`);
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
    assert.ok(fs.existsSync(srcPath('dot_local', 'share', 'warp-terminal', dir)),
      `${dir} is symlinked but not tracked, so the link would dangle`);
  }
});

test('the Windows data tree wraps the XDG themes and tab configs', () => {
  // Warp reads these from %APPDATA% on Windows, which the symlink bridge above cannot reach.
  // A wrapper that does not name its XDG source deploys an empty file, and Warp falls back to
  // its own defaults without reporting anything.
  const data = srcPath('AppData', 'Roaming', 'warp', 'Warp', 'data');
  for (const [dir, file] of [['themes', 'catppuccin_mocha.yaml'], ['tab_configs', 'local-shell.toml']]) {
    const src = path.join(data, dir, `${file}.tmpl`);
    assert.ok(fs.existsSync(src), `the Windows ${dir}/${file} wrapper is not tracked`);
    assert.ok(fs.readFileSync(src, 'utf8').includes(`include "dot_local/share/warp-terminal/${dir}/${file}"`),
      `the Windows ${dir}/${file} wrapper does not include its XDG source`);
  }
});

test('the tab-config dir template agrees with the symlink it resolves through', { skip }, () => {
  // On macOS `default_tab_config_path` names ~/.warp/tab_configs, which is the symlink above.
  // Both come from this one template, so they cannot disagree -- this pins that they still do.
  const dir = renderTemplate('{{ includeTemplate "warp-tab-configs-dir" . }}').trim();
  assert.match(dir, /\/(\.warp|\.local\/share\/warp-terminal|AppData\/Roaming\/warp\/Warp\/data)\/tab_configs$/,
    `the tab config dir rendered as ${dir}, which is no OS's path`);
  assert.doesNotMatch(dir, /\{\{|\}\}/, 'the render left a template action unexpanded');
});

test('each machine deploys exactly one of the three settings paths', { skip }, () => {
  // All three are tracked; a machine that deployed two would have a second file that looks
  // authoritative, and a recapture pasted into the wrong one changes nothing at all.
  const gates = ignored({});
  const live = {
    mac: !gates.has('.warp'),
    xdg: !gates.has('.config/warp-terminal'),
    windows: !gates.has('AppData'),
  };
  assert.strictEqual(Object.values(live).filter(Boolean).length, 1,
    `exactly one Warp config path must deploy here, got ${JSON.stringify(live)}`);
  const expected = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'xdg';
  assert.ok(live[expected], `the live path here should be the ${expected} one`);
});

test('both gate arms name a path, on any host profile', { skip }, () => {
  // The gate is on .chezmoi.os, which no test can override -- .data overrides reach .work and
  // .profile only. So the arm for the other OS is unreachable at render time here, and this
  // reads the source text instead. An arm that named nothing would ignore nothing and deploy
  // both copies, silently.
  const raw = fs.readFileSync(IGNORE, 'utf8');
  const gate = raw.match(/\{\{ if eq \.chezmoi\.os "darwin" \}\}\n([^]*?)\{\{ end \}\}/);
  assert.ok(gate, 'the per-OS Warp gate is gone; every copy would deploy everywhere');
  assert.match(gate[1], /\{\{ else if eq \.chezmoi\.os "windows" \}\}/, 'the Windows arm is gone');
  assert.match(gate[1], /^\.config\/warp-terminal$/m, 'the darwin arm must ignore the XDG pair');
  assert.match(gate[1], /^\.warp$/m, 'the non-darwin arms must ignore ~/.warp');
  assert.match(gate[1], /^AppData$/m, 'the non-Windows arms must ignore the Windows tree');
  assert.match(gate[1], /^\.local\/share\/warp-terminal$/m,
    'the Windows arm must ignore the XDG data tree, which Warp does not read there');
  for (const work of [true, false]) {
    const dead = process.platform === 'darwin' ? '.config/warp-terminal'
      : process.platform === 'win32' ? '.local/share/warp-terminal'
        : '.warp';
    assert.ok(ignored({ work }).has(dead), `the gate stopped firing with work=${work}`);
  }
});
