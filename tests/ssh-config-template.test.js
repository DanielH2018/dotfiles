// Render checks for home/private_dot_ssh/private_config.tmpl.
//
// The bug these pin: `Host daniel-box` listed `IdentityFile ~/.ssh/daniel-box` and
// `IdentityFile ~/.ssh/id_ed25519` unconditionally, relying on ssh to skip the missing one.
// ssh does skip it, but not quietly -- every Fedora connection printed
// `no such identity: /home/daniel/.ssh/daniel-box: No such file or directory`, because that
// path holds WINDOWS key material and Fedora authenticates with the default key. The file is
// shared by both machines, so the line is now gated on .chezmoi.os instead.
//
// .chezmoi.os comes from the running kernel and cannot be overridden on the command line, so
// the Windows branch is exercised by substituting a literal for the condition. That is a real
// render of the surrounding text, which is where the second bug was: the first attempt used
// `{{ if ... -}}` / `{{ end -}}`, and the right-trim markers ate the four-space indent of the
// IdentityFile lines along with the newline.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { renderFile, renderTemplate, chezmoiAvailable } = require('./lib/render');
const { srcPath } = require('./lib/paths');

const TMPL = srcPath('private_dot_ssh', 'private_config.tmpl');
const skip = chezmoiAvailable ? false : 'chezmoi unavailable';

const WINDOWS = process.platform === 'win32';
const forceWindows = () =>
  fs.readFileSync(TMPL, 'utf8').replace('eq .chezmoi.os "windows"', 'eq "windows" "windows"');

test('the Windows-only key is gated, not offered on every OS', { skip }, () => {
  const out = renderFile(TMPL);
  const danielBox = /^\s*IdentityFile ~\/\.ssh\/daniel-box$/m;
  if (WINDOWS) assert.match(out, danielBox, 'Windows still gets its per-host key');
  else assert.doesNotMatch(out, danielBox, 'and no other machine names a key it does not hold');
});

test('daniel-box always resolves an identity', { skip }, () => {
  // The gate must never leave the host with no IdentityFile at all -- ssh would fall back to
  // agent keys and default names, which is how bring-up worked before the key was pinned.
  assert.match(renderFile(TMPL), /^\s*IdentityFile ~\/\.ssh\/id_ed25519$/m);
  assert.match(renderTemplate(forceWindows()), /^\s*IdentityFile ~\/\.ssh\/id_ed25519$/m);
});

test('Windows gets both keys, per-host first', { skip }, () => {
  const lines = renderTemplate(forceWindows()).split('\n');
  const keys = lines.filter((l) => /IdentityFile ~\/\.ssh\/(daniel-box|id_ed25519)$/.test(l));
  assert.deepStrictEqual(keys, ['    IdentityFile ~/.ssh/daniel-box', '    IdentityFile ~/.ssh/id_ed25519']);
});

test('the gate does not strip the indent of the lines around it', { skip }, () => {
  // ssh_config tolerates flush-left directives, so this is style rather than correctness --
  // but it is the exact symptom of getting the trim markers backwards, and it is invisible
  // in a diff of the template.
  for (const out of [renderFile(TMPL), renderTemplate(forceWindows())]) {
    for (const line of out.split('\n').filter((l) => /^\s*IdentityFile /.test(l))) {
      assert.match(line, /^ {4}IdentityFile /, `indent preserved: ${JSON.stringify(line)}`);
    }
  }
});

test('no blank line is left where the gate was', { skip }, () => {
  const block = renderFile(TMPL).split(/^Host /m).find((s) => s.startsWith('daniel-box'));
  assert.ok(block, 'the daniel-box block renders');
  assert.doesNotMatch(block, /\n\s*\n\s*IdentityFile/, 'the elided branch leaves no gap');
});
