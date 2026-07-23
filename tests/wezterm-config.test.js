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

const REPO = path.join(__dirname, '..');
const TMPL = path.join(REPO, 'home', 'dot_config', 'wezterm', 'wezterm.lua.tmpl');

function have(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const skip = process.platform !== 'win32' ? 'windows-only config'
  : !have('chezmoi') ? 'chezmoi unavailable' : false;

let rendered;
function render() {
  if (rendered === undefined) {
    rendered = execFileSync('chezmoi', ['execute-template'], {
      input: fs.readFileSync(TMPL, 'utf8'), cwd: REPO, encoding: 'utf8',
    });
  }
  return rendered;
}

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
    'config.default_domain = "WSL:Ubuntu"',
    'config.default_prog = { git_bash',
    'local git_bash = first_existing(',   // single-source Git Bash path (probed at runtime)
    '"-c", "agentview"',                    // CTRL+SHIFT+S picker tab
    'tmux new-session -A -s main',          // CTRL+SHIFT+H homelab tab
  ]) {
    assert.ok(out.includes(needle), `rendered config contains: ${needle}`);
  }
});

test('rendered Lua is syntactically valid', { skip: skip || (!have('luacheck') && !have('luac')) && 'no lua linter' }, () => {
  const out = render();
  const tmp = path.join(os.tmpdir(), `wezterm-render-${process.pid}.lua`);
  fs.writeFileSync(tmp, out);
  try {
    if (have('luac')) {
      // Parse-only: exits non-zero solely on a syntax error (never runs require).
      execFileSync('luac', ['-p', tmp], { stdio: 'pipe' });
    } else {
      // luacheck lumps style warnings into its exit code, so grep its report for a
      // real syntax error instead of trusting the code — `wezterm` is an undefined global.
      let report = '';
      try { execFileSync('luacheck', ['--globals', 'wezterm', tmp], { stdio: 'pipe' }); }
      catch (e) { report = `${e.stdout || ''}${e.stderr || ''}`; }
      assert.doesNotMatch(report, /syntax error/i, 'no Lua syntax error in rendered config');
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});
