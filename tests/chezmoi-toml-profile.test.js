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

const TMPL = path.join(__dirname, '..', 'home', '.chezmoi.toml.tmpl');
function have(cmd) { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const skip = !have('chezmoi') ? 'chezmoi unavailable' : false;

const WORK_PROMPT = 'Is this a work machine';
const PROFILE_PROMPT = 'Machine profile (workstation/server/minimal)';

const isolatedConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chezmoi-toml-')), 'nonexistent-chezmoi.toml');

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
