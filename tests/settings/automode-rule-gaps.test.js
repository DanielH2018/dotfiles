// `claude auto-mode critique` (2026-11-01) found three rules whose wording let the classifier
// allow what the setup means to stop. The sops allow read as covering an editor override that
// prints the decrypted file (#1109). The deploy soft deny exempted `--check`, under which
// `check_mode: false` tasks run for real (#1110). The environment called the live hosts
// "non-production" while three other entries treat a master push as a production deploy (#1111).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function autoMode() {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box', homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' })).autoMode;
}

test('the sops allow names sops set and excludes every editor variable', { skip }, () => {
  const hits = autoMode().allow.filter((e) => e.includes('ansible/vars/secrets.yml') && e.includes('`sops set'));
  assert.strictEqual(hits.length, 1);
  for (const name of ['SOPS_EDITOR', 'EDITOR', 'VISUAL', '`exec-env`', '`--output`']) {
    assert.ok(hits[0].includes(name), name);
  }
});

test('the deploy soft deny covers --check and exempts only --dry-run', { skip }, () => {
  const hits = autoMode().soft_deny.filter((e) => e.startsWith('Running `scripts/deploy.sh`'));
  assert.strictEqual(hits.length, 1);
  assert.ok(!hits[0].includes('WITHOUT `--check`'), hits[0]);
  assert.ok(hits[0].includes('`check_mode: false`'), hits[0]);
  assert.ok(hits[0].includes('`scripts/deploy.sh --dry-run`'), hits[0]);
});

test('no environment entry calls the live hosts non-production', { skip }, () => {
  assert.ok(!autoMode().environment.some((e) => e.includes('non-production')));
});

// server#6880: the classifier cannot see the read that says no hold is standing, so a
// DEPLOY_HOLD set prompts instead of riding an allow entry.
test('no auto-mode allow entry clears a DEPLOY_HOLD set', { skip }, () => {
  assert.ok(!autoMode().allow.some((e) => e.includes('gh variable set DEPLOY_HOLD')));
});

// The second 2026-11-01 critique. "checkout, switch" read as covering the pathspec and discard
// forms, which overwrite uncommitted edits no reflog holds.
test('the branch-level git allow excludes the forms that discard uncommitted work', { skip }, () => {
  const hits = autoMode().allow.filter((e) => e.startsWith('Branch-level git'));
  assert.strictEqual(hits.length, 1);
  for (const form of ['`git checkout -- <path>`', '`git checkout .`', '`git checkout -f`', '`git switch --discard-changes`']) {
    assert.ok(hits[0].includes(form), form);
  }
  assert.ok(hits[0].includes('does NOT cover'), hits[0]);
});

test('the worktree allow excludes --force and names the evidence a branch -D needs', { skip }, () => {
  const hits = autoMode().allow.filter((e) => e.startsWith('Git worktree lifecycle'));
  assert.strictEqual(hits.length, 1);
  assert.ok(!hits[0].includes('fully reversible'), hits[0]);
  assert.ok(hits[0].includes('`git worktree remove --force` or `-f` overrides both refusals and is not covered'), hits[0]);
  assert.ok(hits[0].includes('a merged PR for that branch visible in this transcript'), hits[0]);
});

// Every allow entry that opens on a tool's name clears that tool by what its file does, so
// the shared clause has to name each one, or an edited or shadowed copy rides the entry.
test('the edited-or-shadowed clause names every tool an allow entry opens on', { skip }, () => {
  const allow = autoMode().allow;
  const clause = allow.filter((e) => e.startsWith('Every entry in this list that clears a named tool'));
  assert.strictEqual(clause.length, 1);
  const tools = allow
    .map((e) => /^`((?:[a-z][a-z-]*)(?: replay)?)[ `]/.exec(e))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((t) => !['git', 'uv', 'sudo'].includes(t));
  for (const known of ['secretq', 'rootq', 'ghread', 'gh-rerun-failed', 'claude-guard replay']) {
    assert.ok(tools.includes(known), `census misses ${known}: ${tools}`);
  }
  for (const tool of tools) {
    assert.ok(clause[0].includes(`\`${tool}\``), tool);
  }
});

test('the deploy --dry-run exemption lapses when the session edits what it rests on', { skip }, () => {
  const hits = autoMode().soft_deny.filter((e) => e.startsWith('Running `scripts/deploy.sh`'));
  assert.strictEqual(hits.length, 1);
  assert.ok(hits[0].includes('unless this session edited `deploy.sh`, or removed or changed a `when: not k8s_dry_run` guard'), hits[0]);
});
