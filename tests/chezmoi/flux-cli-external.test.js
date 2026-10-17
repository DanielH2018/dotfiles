// The Flux CLI external (#857): daniel-box only, pinned to the server repo's flux_version.
// Rendered under a named hostname for the reason tests/settings/agent-flow-trial.test.js gives;
// that file also checks that every other host renders the externals file empty.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');

test('daniel-box installs the flux binary from the pinned v2.9.6 release', { skip }, () => {
  const toml = execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box' } }),
  ], { input: fs.readFileSync(srcPath('.chezmoiexternal.toml.tmpl'), 'utf8'), encoding: 'utf8' });
  const entry = toml.split(/^\["\.local\/bin\/flux"\]$/m)[1];
  assert.ok(entry, 'the daniel-box render has no .local/bin/flux external');
  const body = entry.split(/^\[/m)[0];
  assert.match(body, /^\s*type = "archive-file"$/m);
  assert.match(body, /^\s*url = "https:\/\/github\.com\/fluxcd\/flux2\/releases\/download\/v2\.9\.6\/flux_2\.9\.6_linux_amd64\.tar\.gz"$/m);
  assert.match(body, /^\s*checksum\.sha256 = "[0-9a-f]{64}"$/m);
  assert.match(body, /^\s*path = "flux"$/m);
  assert.match(body, /^\s*executable = true$/m);
});
