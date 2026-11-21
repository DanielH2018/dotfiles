// Every mcp__ rule in the rendered permissions names a tool its server exposes, and every
// write tool prompts. bin/lib/mcp-tools.json is the list config-lint checks against.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath, repoPath } = require('../lib/paths');
const { checkMcpRules } = require('../../bin/config-lint');

const skip = skipUnless('chezmoi');

test('the mcp__ permission rules match bin/lib/mcp-tools.json', { skip }, () => {
  const settings = JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box', homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(srcPath('.chezmoitemplates', 'settings.base.json'), 'utf8'), encoding: 'utf8' }));
  const tools = JSON.parse(fs.readFileSync(repoPath('bin', 'lib', 'mcp-tools.json'), 'utf8'));
  assert.ok(settings.permissions.ask.some((r) => r.startsWith('mcp__gitguardian__')), 'the ask rules were rendered');
  assert.deepStrictEqual(checkMcpRules(settings.permissions, tools), []);
});
