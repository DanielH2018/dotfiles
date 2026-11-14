// The bootstrap path and the non-Linux template branches, as CI and the docs describe them.
//
// The gate runs on Linux with a hand-written chezmoi config, so two things never ran in CI:
// a template branch for darwin or windows, and `chezmoi init` with its prompts. ci.yml's
// `render` and `bootstrap` jobs cover them; these tests keep those jobs from being dropped,
// and keep README and RESTORE giving one bootstrap command.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { repoPath, srcPath } = require('./lib/paths');
const { renderFile, chezmoiAvailable } = require('./lib/render');

const ci = fs.readFileSync(repoPath('.github', 'workflows', 'ci.yml'), 'utf8');

// The body of one top-level job: from its `  <name>:` line to the next job or end of file.
function job(name) {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|(?![\\s\\S]))`, 'm').exec(ci);
  assert.ok(m, `ci.yml has no ${name} job`);
  return m[1];
}

function bootstrapCommand(file) {
  const lines = fs.readFileSync(repoPath(file), 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => /\binit --apply DanielH2018\/dotfiles\b/.test(l));
  assert.strictEqual(lines.length, 1, `${file} should give exactly one bootstrap command`);
  return lines[0];
}

test('README and RESTORE give the same bootstrap command', () => {
  assert.strictEqual(bootstrapCommand('docs/RESTORE.md'), bootstrapCommand('README.md'));
});

test('CI renders every template on macOS and on Windows', () => {
  const body = job('render');
  assert.match(body, /os: \[[^\]]*macos-[^\]]*\]/);
  assert.match(body, /os: \[[^\]]*windows-[^\]]*\]/);
  assert.match(body, /apply --dry-run/);
});

test('CI runs chezmoi init --apply from zero in a clean container', () => {
  const body = job('bootstrap');
  assert.match(body, /^    container: ubuntu:/m);
  assert.match(body, /chezmoi" init --apply/);
});

test('CI runs chezmoi init --apply from zero on a Windows runner', () => {
  const body = job('bootstrap-windows');
  assert.match(body, /^    runs-on: windows-/m);
  assert.match(body, /chezmoi init --apply/);
  assert.match(body, /winget --version/, 'without winget the apply passes having installed nothing');
});

test('CI runs chezmoi init --apply from zero on a macOS runner', () => {
  const body = job('bootstrap-macos');
  assert.match(body, /^    runs-on: macos-/m);
  assert.match(body, /chezmoi init --apply/);
  assert.match(body, /brew --version/, 'without Homebrew install-brew-bundle defers and the apply fails');
});

// bootstrap-macos applies profile=server on a runner with no App Store sign-in and no GUI session.
test('the Brewfile installs 1Password on every profile, other GUI apps on a workstation only', { skip: chezmoiAvailable ? false : 'chezmoi not on PATH' }, () => {
  const gui = /^(cask "(?!1password)|mas |vscode )/m;
  const server = renderFile(srcPath('Brewfile.tmpl'), { profile: 'server' });
  const workstation = renderFile(srcPath('Brewfile.tmpl'), { profile: 'workstation' });
  assert.doesNotMatch(server, gui);
  assert.match(server, /^brew "util-linux"$/m);
  assert.match(server, /^cask "1password"$/m, 'dot_gitconfig.tmpl signs every darwin commit with op-ssh-sign');
  assert.match(workstation, /^cask "visual-studio-code"$/m);
  assert.match(workstation, /^mas "Keynote"/m);
  assert.match(workstation, /^vscode "/m);
});

// The ruleset and bin/land wait on the `gate` check alone, so a job outside its `needs:` cannot
// stop a landing. A skipped required check counts as passing, hence `always()` plus a result read.
test('the required gate check waits on render and every bootstrap job', () => {
  const body = job('gate');
  const needs = /^    needs: \[([^\]]*)\]/m.exec(body);
  assert.ok(needs, 'gate has no needs: list');
  for (const name of ['suite', 'render', 'bootstrap', 'bootstrap-windows', 'bootstrap-macos']) {
    assert.ok(needs[1].split(/,\s*/).includes(name), `gate does not wait on ${name}`);
  }
  assert.match(body, /^    if: always\(\)$/m, 'a skipped gate reads as passing to the ruleset');
  assert.match(body, /needs\.\*\.result/);
});
