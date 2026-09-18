// Render checks for home/.chezmoi.toml.tmpl's `profile` validation (spec finding A13-15).
//
// The bug this pins: `profile = {{ $profile | quote }}` used to accept whatever
// `promptStringOnce` returned verbatim. A typo'd or stale answer (e.g. "workstaton",
// or a leftover value from a renamed profile) would render successfully and produce a
// self-consistent but *wrong* `.chezmoi.toml` - every downstream `{{ if ne .profile
// "minimal" }}` branch silently takes the "not minimal" path, so a would-be minimal
// host gets the full heavy-tool install with no error at any point. The fix adds a
// template-time `fail` for any value outside the three accepted profiles, so a bad
// answer aborts `chezmoi init` instead of producing a misconfigured machine.
//
// `execute-template --init` simulates the prompts this file makes via `promptStringOnce`
// / `promptBoolOnce`, keyed by the literal prompt text (not the variable name) - see
// `chezmoi help execute-template`. `promptStringOnce`/`promptBoolOnce` first check for an
// already-answered value in `.` (data merged from the *real* `chezmoi.toml` on this
// machine) before ever consulting the simulated prompt, so `--config` is pointed at a
// path that does not exist to force every render through the simulated prompt instead of
// this machine's real, already-answered `profile`.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const TMPL = srcPath('.chezmoi.toml.tmpl');
const skip = !have('chezmoi') ? 'chezmoi unavailable' : false;

const WORK_PROMPT = 'Is this a work machine';
const PROFILE_PROMPT = 'Machine profile (workstation/server/minimal)';

const isolatedConfigDir = scratch(os.tmpdir(), 'chezmoi-toml-');
const isolatedConfig = path.join(isolatedConfigDir, 'nonexistent-chezmoi.toml');

function render(profile) {
  return execFileSync('chezmoi', [
    'execute-template', '--init',
    '--config', isolatedConfig,
    '--promptBool', `${WORK_PROMPT}=false`,
    '--promptString', `${PROFILE_PROMPT}=${profile}`,
  ], { input: fs.readFileSync(TMPL, 'utf8'), encoding: 'utf8', stdio: 'pipe' });
}
// Capture a non-zero exit instead of throwing, so status and stderr can be asserted.
function renderFail(profile) {
  try { render(profile); return { status: 0, stderr: '' }; }
  catch (e) { return e; }
}

for (const profile of ['workstation', 'server', 'minimal']) {
  test(`accepts profile=${profile}`, { skip }, () => {
    const out = render(profile);
    assert.match(out, new RegExp(`^\\s*profile = "${profile}"$`, 'm'));
  });
}

test('rejects an unrecognised profile value', { skip }, () => {
  const result = renderFail('bogus');
  assert.notStrictEqual(result.status, 0, 'render must fail, not silently substitute a default');
  assert.match(result.stderr.toString(), /invalid profile "bogus"/);
  assert.match(result.stderr.toString(), /workstation, server, minimal/);
});

test('rejects an empty profile value', { skip }, () => {
  const result = renderFail('');
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr.toString(), /invalid profile ""/);
});

// Without an explicit [interpreters.ps1], chezmoi runs os-windows .chezmoiscripts as
// `powershell -NoLogo <script>`, which Windows' default Restricted execution policy
// refuses ("running scripts is disabled on this system") - so every Windows bootstrap
// fails at install-cli-tools. The interpreter block is OS-independent template text, so
// asserting it on any host is a real check.
test('renders a ps1 interpreter that bypasses the execution policy', { skip }, () => {
  const out = render('workstation');
  assert.match(out, /^\[interpreters\.ps1\]$/m);
  // `powershell`, not `pwsh`: pwsh is installed *by* these scripts, so it cannot be the
  // interpreter that runs them on a fresh box.
  assert.match(out, /^\s*command = "powershell"$/m);
  const args = out.match(/^\s*args = \[(.*)\]$/m);
  assert.ok(args, 'ps1 interpreter must pass explicit args');
  // -File must be last: chezmoi appends the script path, and without -File powershell
  // treats it as a command to interpret, which the execution policy blocks all the same.
  assert.match(args[1], /"-ExecutionPolicy", "Bypass", "-File"$/);
});
