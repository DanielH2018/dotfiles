// The auto-mode classifier denied a sub-coordinator's first fan-out launch twice on
// 2026-11-20, because the project came from the root coordinator's brief and not from words
// the operator typed in that session. The allow list clears that launch and nothing wider:
// `launch` checks no milestone, so the entry has to carry that condition itself.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function launchHints() {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box', homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' }))
    .autoMode.allow.filter((e) => e.includes('scripts/dev/fanout.py place launch'));
}

test('one auto-mode hint clears a launch from a coordinator-locked worktree for the brief\'s milestone', { skip }, () => {
  const hints = launchHints();
  assert.strictEqual(hints.length, 1);
  assert.ok(hints[0].includes('coordinator: project <title>'), hints[0]);
  assert.ok(hints[0].includes("brief names that project's milestone title"), hints[0]);
  assert.ok(hints[0].includes('needs no approval typed'), hints[0]);
});

test('the launch hint excludes an unlocked worktree, another milestone, the review opt-out and the other verbs', { skip }, () => {
  const [, excluded] = launchHints()[0].split('does NOT cover');
  assert.ok(excluded, 'the hint states what it does not cover');
  for (const out of ['no such lock', 'outside that milestone', '`--no-review`', '`--allow-shared-file`',
    '`place abandon`', '`place clean`', '`land.sh`']) {
    assert.ok(excluded.includes(out), out);
  }
});
