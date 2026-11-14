// The bootstrap path and the non-Linux template branches, as CI and the docs describe them.
//
// The gate runs on Linux with a hand-written chezmoi config, so two things never ran in CI:
// a template branch for darwin or windows, and `chezmoi init` with its prompts. ci.yml's
// `render` and `bootstrap` jobs cover them; these tests keep those jobs from being dropped,
// and keep README and RESTORE giving one bootstrap command.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { repoPath } = require('./lib/paths');

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
