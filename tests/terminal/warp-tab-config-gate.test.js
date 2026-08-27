// Gate checks for the Warp tab configs in home/.chezmoiignore.
//
// Warp's tab configs are two different things sharing a directory. Most of them describe how
// Warp behaves and belong on every machine. Three name personal infrastructure — the homelab
// ssh aliases and the repo that provisions it — and a work machine can reach none of them.
//
// The failure this guards against is silent in both directions. A `.chezmoiignore` line that
// matches nothing gates nothing and reports no error, so a typo'd path reads as a working gate
// forever. And the polarity is invisible from the machine you write it on: `{{ if .work }}` and
// `{{ if not .work }}` both render to the same empty output here, where `.work` is false. So
// these render the file as BOTH kinds of machine and compare.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderFile, chezmoiAvailable, SOURCE } = require('../lib/render');

const IGNORE = path.join(SOURCE, '.chezmoiignore');
const CONFIGS = path.join(SOURCE, 'dot_local', 'share', 'warp-terminal', 'tab_configs');
const WINDOWS_CONFIGS = path.join(SOURCE, 'AppData', 'Roaming', 'warp', 'Warp', 'data', 'tab_configs');
const skip = chezmoiAvailable ? false : 'chezmoi unavailable';

const PERSONAL = ['daniel-box.toml', 'daniel-server.toml', 'local-server.toml'];

// Warp's data directory differs by OS, so the gate is spelled twice in .chezmoiignore and only
// the spelling this machine deploys is live. Resolving it here rather than hardcoding the XDG
// form is what keeps these checks meaningful on Windows -- a filter that matched the XDG
// spelling only would find nothing there and pass while gating nothing.
const onWindows = process.platform === 'win32';
// The tree this machine actually deploys. A gated path that names a file in the other tree
// matches no target, and chezmoi reports nothing for an ignore rule that matches nothing.
const TRACKED = onWindows ? WINDOWS_CONFIGS : CONFIGS;
const target = (name) => (onWindows
  ? `AppData/Roaming/warp/Warp/data/tab_configs/${name}`
  : `.local/share/warp-terminal/tab_configs/${name}`);

// The rendered ignore file is a plain newline-separated path list.
const ignored = (work) =>
  new Set(renderFile(IGNORE, { data: { work } }).split('\n').map((l) => l.trim()).filter(Boolean));

// Both spellings end in this, and no other entry in the file does.
const isTabConfig = (line) => line.includes('/tab_configs/');

// The Windows tree is one-line wrappers that `include` the XDG copy, so its sources carry a
// .tmpl suffix the deployed names do not.
const isTracked = (name) => fs.existsSync(path.join(TRACKED, onWindows ? `${name}.tmpl` : name));

test('a work machine ignores exactly the personal tab configs', { skip }, () => {
  const gated = [...ignored(true)].filter(isTabConfig);
  assert.deepStrictEqual(gated.sort(), PERSONAL.map(target).sort());
});

test('a personal machine ignores none of them', { skip }, () => {
  const gated = [...ignored(false)].filter(isTabConfig);
  assert.deepStrictEqual(gated, [], 'the gate is inverted; personal machines get every config');
});

test('every gated path names a tab config that exists', { skip }, () => {
  // A path that matches nothing is the silent failure: chezmoi reports no error for an ignore
  // rule with no target, so renaming a config quietly un-gates it.
  for (const name of PERSONAL) {
    assert.ok(isTracked(name), `${name} is gated but not tracked`);
  }
});

test('the general tab configs reach a work machine', { skip }, () => {
  // Asserted by name rather than by "whatever is left", so adding a personal config without
  // gating it fails here instead of silently widening what work machines get.
  const gated = ignored(true);
  for (const name of ['local-shell.toml', 'local-chezmoi.toml', 'local-vault.toml', 'ssh-other.toml']) {
    assert.ok(isTracked(name), `${name} is expected on every machine but is not tracked`);
    assert.ok(!gated.has(target(name)), `${name} is general machinery and must not be gated`);
  }
});

test('both OS trees carry the same tab configs', () => {
  // The Windows tree is wrappers, not copies, so the contents cannot drift -- but the file
  // lists can. Adding a config to the XDG tree and forgetting the wrapper deploys nothing on
  // Windows, and chezmoi reports no error for a config that simply is not there.
  const xdg = fs.readdirSync(CONFIGS).filter((n) => n.endsWith('.toml')).sort();
  const win = fs.readdirSync(WINDOWS_CONFIGS)
    .filter((n) => n.endsWith('.toml.tmpl'))
    .map((n) => n.replace(/\.tmpl$/, ''))
    .sort();
  assert.deepStrictEqual(win, xdg, 'the Windows wrappers and the XDG configs name different files');
});

test('every Windows wrapper includes its XDG counterpart', () => {
  // A wrapper that names the wrong source silently deploys another tab config's contents under
  // this one's name, which no other check here would notice.
  for (const name of fs.readdirSync(WINDOWS_CONFIGS)) {
    const body = fs.readFileSync(path.join(WINDOWS_CONFIGS, name), 'utf8');
    const want = `dot_local/share/warp-terminal/tab_configs/${name.replace(/\.tmpl$/, '')}`;
    assert.ok(body.includes(`include "${want}"`), `${name} does not include ${want}`);
  }
});

test('the default tab config is never gated', { skip }, () => {
  // settings.toml names one config as `default_tab_config_path`, which is what Cmd+T opens.
  // Gating that one would leave a work machine pointing at a file it does not have, and Warp
  // falls back to a bare shell silently. Read the name from settings rather than hardcoding it,
  // so the two cannot drift apart.
  const settings = renderFile(path.join(SOURCE, 'dot_config', 'warp-terminal', 'settings.toml.tmpl'));
  const m = settings.match(/^default_tab_config_path = "(.+)"$/m);
  assert.ok(m, 'settings.toml must name a default tab config');
  const name = path.basename(m[1]);
  for (const work of [true, false]) {
    assert.ok(!ignored(work).has(target(name)), `${name} is the default config and must deploy when work=${work}`);
  }
});
