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
const skip = chezmoiAvailable ? false : 'chezmoi unavailable';

const PERSONAL = ['daniel-box.toml', 'daniel-server.toml', 'local-server.toml'];
const target = (name) => `.local/share/warp-terminal/tab_configs/${name}`;

// The rendered ignore file is a plain newline-separated path list.
const ignored = (work) =>
  new Set(renderFile(IGNORE, { data: { work } }).split('\n').map((l) => l.trim()).filter(Boolean));

test('a work machine ignores exactly the personal tab configs', { skip }, () => {
  const gated = [...ignored(true)].filter((l) => l.includes('warp-terminal/tab_configs'));
  assert.deepStrictEqual(gated.sort(), PERSONAL.map(target).sort());
});

test('a personal machine ignores none of them', { skip }, () => {
  const gated = [...ignored(false)].filter((l) => l.includes('warp-terminal/tab_configs'));
  assert.deepStrictEqual(gated, [], 'the gate is inverted; personal machines get every config');
});

test('every gated path names a tab config that exists', { skip }, () => {
  // A path that matches nothing is the silent failure: chezmoi reports no error for an ignore
  // rule with no target, so renaming a config quietly un-gates it.
  for (const name of PERSONAL) {
    assert.ok(fs.existsSync(path.join(CONFIGS, name)), `${name} is gated but not tracked`);
  }
});

test('the general tab configs reach a work machine', { skip }, () => {
  // Asserted by name rather than by "whatever is left", so adding a personal config without
  // gating it fails here instead of silently widening what work machines get.
  const gated = ignored(true);
  for (const name of ['local-shell.toml', 'local-chezmoi.toml', 'local-vault.toml', 'ssh-other.toml']) {
    assert.ok(fs.existsSync(path.join(CONFIGS, name)), `${name} is expected on every machine but is not tracked`);
    assert.ok(!gated.has(target(name)), `${name} is general machinery and must not be gated`);
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
