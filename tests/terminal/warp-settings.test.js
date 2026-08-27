// Render checks for home/.chezmoitemplates/warp-settings.toml, the shared settings body that
// both per-OS wrappers include (macOS reads ~/.warp, Linux reads $XDG_CONFIG_HOME/warp-terminal).
// Asserted against the body rather than either wrapper: the wrappers are one includeTemplate
// line each, so a check on one of them would pass while the content it names was broken.
//
// This file is unusual for a chezmoi source: Warp WRITES its own settings.toml whenever a
// setting changes in its UI. So the source drifts behind the deployed copy by design, and the
// maintenance step is a recapture -- copy the deployed file back over the template. A plain
// `cp` does that correctly for the settings and wrongly for everything else, because it also
// discards the header and the one template action in the file.
//
// That is what these tests pin. They deliberately assert nothing about the VALUE of any
// preference: a test that pins `honor_ps1 = true` would fail the moment Daniel turns it off in
// the UI, which is not a regression. What must survive a recapture is the structure -- valid
// TOML, no absolute /home/daniel, and the two references that point at other tracked files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { renderFile, renderTemplate, chezmoiAvailable, SOURCE } = require('../lib/render');

const TMPL = path.join(SOURCE, '.chezmoitemplates', 'warp-settings.toml');
const skip = chezmoiAvailable ? false : 'chezmoi unavailable';

let pyOk = true;
try { execFileSync('python3', ['-c', 'import tomllib'], { stdio: 'ignore' }); } catch { pyOk = false; }
const tomlSkip = skip || (pyOk ? false : 'python3 tomllib unavailable');

// Node ships no TOML parser, so validity is checked against the same library Warp's own
// format is specified by. Returns the parsed document as JSON.
function parseToml(text) {
  const out = execFileSync('python3', ['-c', 'import sys,tomllib,json; json.dump(tomllib.loads(sys.stdin.read()), sys.stdout)'],
    { input: text, encoding: 'utf8' });
  return JSON.parse(out);
}

test('the template renders valid TOML', { skip: tomlSkip }, () => {
  const doc = parseToml(renderFile(TMPL));
  assert.ok(doc.appearance && doc.terminal, 'a parse that loses the top-level tables is not a parse');
});

test('the recapture keeps the header and the three template actions', { skip }, () => {
  // A `cp` of the deployed file over this template drops all of them. Nothing else in the file
  // would look wrong afterwards -- it stays valid TOML and deploys -- so this is the only signal.
  const raw = fs.readFileSync(TMPL, 'utf8');
  assert.match(raw, /^# Managed by chezmoi/, 'the header explaining the recapture must survive it');
  assert.match(raw, /\{\{ includeTemplate "warp-tab-configs-dir" \. \}\}/,
    'default_tab_config_path must stay templated; the dir it names differs per OS');

  // The two os guards are the ones a recapture on Windows silently turns into literals: the
  // deployed file there HAS the keys, so copying it back deploys a Windows bash.exe path and a
  // dx12 backend to Linux and macOS, where neither exists.
  const guards = raw.match(/\{\{- if eq \.chezmoi\.os "windows" \}\}/g) || [];
  assert.strictEqual(guards.length, 2,
    'the shell overrides and the graphics keys must each stay behind an os guard');
});

test('the non-Windows render is still valid TOML', { skip: tomlSkip }, () => {
  // This machine is Windows, so the render above only ever exercises the true branch. Stripping
  // the guarded blocks is what the false branch produces, and the failure it guards against is
  // a `[session]` header left with no keys and no subtable under it.
  const raw = fs.readFileSync(TMPL, 'utf8');
  const stripped = raw.replace(/\{\{- if eq \.chezmoi\.os "windows" \}\}[\s\S]*?\{\{- end \}\}/g, '');
  // Matched on the key names, not on "bash.exe" -- the header names that path in prose, so a
  // looser pattern fails here while the strip is working correctly.
  assert.doesNotMatch(stripped, /^(startup_shell_override|preferred_graphics_backend)/m,
    'the strip must actually remove the Windows-only keys, or this test proves nothing');
  const doc = parseToml(renderTemplate(stripped));
  assert.ok(doc.session.working_directory_config.advanced_mode,
    'the per-source working directory tables must survive without the Windows block');
});

test('the source names no machine-absolute home path', { skip: false }, () => {
  // Asserted against the SOURCE, not the render -- `{{ .chezmoi.homeDir }}` expands to
  // /home/daniel on this machine, so a render check would pass on a hardcoded path too. The
  // repo is public and shared with a Windows machine; a literal here deploys wrong on both.
  assert.doesNotMatch(fs.readFileSync(TMPL, 'utf8'), /\/home\/daniel\b/,
    'homeDir must come from the template action, not a literal path');
});

test('default_tab_config_path names a tab config that exists', { skip: tomlSkip }, () => {
  // Warp falls back to a bare shell when the path dangles, silently -- so a renamed tab config
  // breaks Cmd+T with no error anywhere. The tab configs are tracked in this repo, so the
  // reference is checkable at test time.
  const doc = parseToml(renderFile(TMPL));
  const target = doc.general.default_tab_config_path;
  assert.ok(target, 'the default session mode is tab_config; it needs a path');
  const name = path.basename(target);
  const src = path.join(SOURCE, 'dot_local', 'share', 'warp-terminal', 'tab_configs', name);
  assert.ok(fs.existsSync(src), `default_tab_config_path points at ${name}, which is not tracked`);
});

test('the custom theme names a theme file that exists', { skip: tomlSkip }, () => {
  const doc = parseToml(renderFile(TMPL));
  const custom = doc.appearance.themes.theme.custom;
  assert.ok(custom, 'the theme binding is a custom theme, not a built-in');
  const src = path.join(SOURCE, 'dot_local', 'share', 'warp-terminal', 'themes', custom.path);
  assert.ok(fs.existsSync(src), `theme path ${custom.path} is not tracked`);
});

test('use_latest_prompt_as_title stays off', { skip: tomlSkip }, () => {
  // The one preference worth pinning, because it is not a preference -- it is a conflict.
  // Warp names vertical-tab rows from the latest prompt when this is on, which overwrites the
  // OSC 0 title that warp-session-title.sh writes to label a Claude session (PR #375). The
  // setting reads as a harmless sidebar tweak in the UI, which is exactly why it needs a test.
  const doc = parseToml(renderFile(TMPL));
  const vt = doc.appearance.vertical_tabs || {};
  assert.notStrictEqual(vt.use_latest_prompt_as_title, true,
    'this overrides the session-title hook; leave it at its default of false');
});
