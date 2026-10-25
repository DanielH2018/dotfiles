// classifyAllShell suspends the Bash(rootq:*) allow rule in auto mode, so the classifier needs
// an autoMode.allow entry to read rootq as routine (#1050). The shim is installed on daniel-box
// and daniel-server, and a session reaches either over ssh, so the entry is not host-gated.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const SETTINGS = srcPath('.chezmoitemplates', 'settings.base.json');

function allow(hostname) {
  return JSON.parse(execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname, homeDir: '/home/ubuntu' } }),
  ], { input: fs.readFileSync(SETTINGS, 'utf8'), encoding: 'utf8' })).autoMode.allow;
}

test('every host allows rootq in auto mode and keeps its sudo test seam out', { skip }, () => {
  for (const hostname of ['daniel-box', 'daniel-server', 'daniel-pi', 'work-laptop']) {
    const entries = allow(hostname).filter((e) => e.startsWith('`rootq …`'));
    assert.strictEqual(entries.length, 1, hostname);
    assert.ok(entries[0].includes('HOMELAB_ROOTQ_SUDO'), hostname);
    assert.ok(entries[0].includes('homelab-rootq'), hostname);
  }
});
