// The auto-mode classifier denied `findings.py comment` as "External System Writes" on
// 2026-11-10 after letting five `findings.py open` runs through (#1200). classifyAllShell
// suspends the `Bash(gh issue …)` rules, so the allow list names the register's verbs itself.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function allow() {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box', homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' })).autoMode.allow;
}

test('one auto-mode entry clears the findings.py write verbs and excludes the bulk ones', { skip }, () => {
  const hits = allow().filter((e) => e.startsWith('`uv run python scripts/dev/findings.py'));
  assert.strictEqual(hits.length, 1);
  for (const verb of ['open', 'comment', 'touch', 'claim', 'release', 'close', 'defer', 'block']) {
    assert.ok(hits[0].includes(`\`${verb}\``), verb);
  }
  const excluded = hits[0].slice(hits[0].indexOf('does NOT cover'));
  for (const verb of ['reap', 'manual', 'board-dates', 'sync-labels']) {
    assert.ok(excluded.includes(`\`${verb}\``), verb);
  }
});

test('the named-tool caveat covers findings.py', { skip }, () => {
  const caveat = allow().find((e) => e.startsWith('Every entry in this list that clears a named tool'));
  assert.ok(caveat.includes('`scripts/dev/findings.py`'), caveat);
});
