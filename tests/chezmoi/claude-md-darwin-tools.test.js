// CLAUDE.md names helper tools that .chezmoiignore leaves off darwin (secretq, killown, envq) or
// that only daniel-box and daniel-server carry. The bullets for them render on Linux only, so a
// macOS session is never told to run a command it does not have. Both halves are rendered under
// a named OS, because the suite runs on whichever machine pushes.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');
const TMPL = srcPath('private_dot_claude', 'CLAUDE.md.tmpl');
const LINUX_ONLY = ['takeover-check', 'secretq', 'unitq', 'rootq', 'killown', 'envq'];

function renderAs(os) {
  return execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { os } }),
  ], { input: fs.readFileSync(TMPL, 'utf8'), encoding: 'utf8' });
}

test('linux names every host-only helper', { skip }, () => {
  const md = renderAs('linux');
  for (const tool of LINUX_ONLY) assert.ok(md.includes(`\`${tool}`), `missing on linux: ${tool}`);
});

test('darwin names none of them, and the ghread hint uses printenv', { skip }, () => {
  const md = renderAs('darwin');
  for (const tool of LINUX_ONLY) assert.ok(!md.includes(`\`${tool}`), `rendered on darwin: ${tool}`);
  assert.match(md, /printenv TMPDIR/);
  assert.match(md, /\S\n- To read GitHub/, 'the gate leaves a blank line or joins bullets');
});
