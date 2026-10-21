// The vault's pre-commit secret scan, run against content staged in a scratch repo.
//
// AWS key IDs match case-sensitively and every other pattern matches without case. The
// case-insensitive match once flagged four lines of the vault's minified Obsidian plugin
// bundles, where `asia` and 16 more letters occur as ordinary text.
//
// The fake secrets are assembled at runtime so that the repo's own gitleaks hook does not
// flag this file.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const HOOK = srcPath('private_dot_claude', 'vault-tooling', 'githooks', 'executable_pre-commit');
const skip = skipUnless('bash', 'git');

function runHook(t, content) {
  const repo = scratch(os.tmpdir(), 'vault-pre-commit-', t);
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'note.md'), content);
  git('add', 'note.md');
  const env = { ...process.env };
  delete env.VAULT_ALLOW_SECRET;
  return spawnSync('bash', [HOOK], { cwd: repo, encoding: 'utf8', env });
}

test('an uppercase AWS key ID is blocked', { skip }, (t) => {
  const r = runHook(t, `aws = ${'AKIA'}${'ABCDEFGHIJKLMNOP'}\n`);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /looks like it contains a secret/);
});

test('lowercase text shaped like a key ID is not blocked', { skip }, (t) => {
  const r = runHook(t, `var x="fant${'asia'}bcdefghijklmnopq";\n`);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('the other patterns still match without case', { skip }, (t) => {
  const r = runHook(t, `PassWord = ${'x'.repeat(24)}\n`);
  assert.strictEqual(r.status, 1, r.stderr);
});
