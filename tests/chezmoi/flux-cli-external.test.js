// The Flux CLI external (#857): daniel-box only, pinned to the server repo's flux_version.
// Rendered under a named hostname for the reason tests/settings/agent-flow-trial.test.js gives;
// that file also checks that every other host renders the externals file empty.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('../lib/probe');
const { HOMELAB_CANDIDATES, homelabFile } = require('../lib/homelab');
const { SOURCE, srcPath } = require('../lib/paths');

const skip = skipUnless('chezmoi');

test('daniel-box installs the flux binary from a pinned release', { skip }, () => {
  const toml = execFileSync('chezmoi', [
    '--source', SOURCE, 'execute-template',
    '--override-data', JSON.stringify({ chezmoi: { hostname: 'daniel-box' } }),
  ], { input: fs.readFileSync(srcPath('.chezmoiexternal.toml.tmpl'), 'utf8'), encoding: 'utf8' });
  const entry = toml.split(/^\["\.local\/bin\/flux"\]$/m)[1];
  assert.ok(entry, 'the daniel-box render has no .local/bin/flux external');
  const body = entry.split(/^\[/m)[0];
  assert.match(body, /^\s*type = "archive-file"$/m);
  assert.match(body, /^\s*url = "https:\/\/github\.com\/fluxcd\/flux2\/releases\/download\/v\d+\.\d+\.\d+\/flux_\d+\.\d+\.\d+_linux_amd64\.tar\.gz"$/m);
  assert.match(body, /^\s*checksum\.sha256 = "[0-9a-f]{64}"$/m);
  assert.match(body, /^\s*path = "flux"$/m);
  assert.match(body, /^\s*executable = true$/m);
});

// --- Lockstep with the server's flux_version ---------------------------------------------------
//
// The CLI diffs against the controllers the server repo installs, so its release has to be the
// server's flux_version. Renovate cannot move this pin: it could rewrite the URL but not
// recompute checksum.sha256, and it would offer releases the server has not adopted (#858).
// This test is what reports a server bump that the pin here has not followed.
//
// The URL is read from the template text, not a chezmoi render, so the check runs in CI, where
// chezmoi may be absent.
const FLUX_DEFAULTS = 'ansible/roles/k8s/flux/defaults/main.yml';

// The release in the flux external's URL, or why it cannot be read. The URL names the release
// twice, as the tag and in the tarball name, and a URL whose two disagree is a problem too.
function pinnedFluxRelease(templateText) {
  const block = templateText.split(/^\["\.local\/bin\/flux"\]$/m)[1]?.split(/^\[/m)[0] ?? '';
  const m = /^\s*url = "https:\/\/github\.com\/fluxcd\/flux2\/releases\/download\/v([^/"]+)\/flux_([^_"]+)_linux_amd64\.tar\.gz"$/m
    .exec(block);
  if (!m) return { problem: 'the .local/bin/flux external has no flux2 release URL in the shape this test reads' };
  if (m[1] !== m[2]) return { problem: `the flux URL names tag v${m[1]} but tarball ${m[2]}` };
  return { version: `v${m[1]}` };
}

// Why the pin and the server disagree, or null when they agree. A server file the parser cannot
// read is a disagreement too, so a reshaped defaults file cannot pass by yielding nothing.
function fluxLockstepProblem(templateText, defaultsText) {
  const theirs = /^flux_version: (\S+)$/m.exec(defaultsText)?.[1];
  if (!theirs) return `the server ${FLUX_DEFAULTS} no longer sets flux_version in the shape this test reads`;
  const ours = pinnedFluxRelease(templateText);
  if (ours.problem) return ours.problem;
  return ours.version === theirs ? null : `the flux CLI is ${ours.version} here and flux_version is ${theirs} on the server`;
}

test('the flux lockstep check accepts equal versions and reports every mismatch', () => {
  const external = (tag, tarball) => [
    '[".local/bin/flux"]',
    '    type = "archive-file"',
    `    url = "https://github.com/fluxcd/flux2/releases/download/v${tag}/flux_${tarball}_linux_amd64.tar.gz"`,
    '',
  ].join('\n');
  const defaults = (v) => `# renovate: datasource=github-releases depName=fluxcd/flux2\nflux_version: ${v}\n`;
  assert.strictEqual(fluxLockstepProblem(external('2.9.6', '2.9.6'), defaults('v2.9.6')), null);
  assert.match(fluxLockstepProblem(external('2.9.6', '2.9.6'), defaults('v2.10.0')),
    /v2\.9\.6 here and flux_version is v2\.10\.0/);
  assert.match(fluxLockstepProblem(external('2.10.0', '2.9.6'), defaults('v2.10.0')),
    /tag v2\.10\.0 but tarball 2\.9\.6/);
  assert.match(fluxLockstepProblem(external('2.9.6', '2.9.6'), 'flux_namespace: flux-system\n'),
    /no longer sets flux_version/);
  assert.match(fluxLockstepProblem('[".local/bin/other"]\n', defaults('v2.9.6')),
    /no flux2 release URL/);
});

test('the flux URL parser reads this repo\'s own pin', () => {
  // This half needs no server copy, so it runs wherever the suite does.
  const ours = pinnedFluxRelease(fs.readFileSync(srcPath('.chezmoiexternal.toml.tmpl'), 'utf8'));
  assert.match(ours.version ?? ours.problem, /^v\d+\.\d+\.\d+$/);
});

test('the flux CLI pin matches the server\'s flux_version', async (t) => {
  const src = await homelabFile(FLUX_DEFAULTS, HOMELAB_CANDIDATES, fetch);
  if (src.skip) return t.skip(src.skip);
  const problem = fluxLockstepProblem(fs.readFileSync(srcPath('.chezmoiexternal.toml.tmpl'), 'utf8'), src.text);
  assert.strictEqual(problem, null,
    `${problem} (${src.from}); move the URL and checksum.sha256 in home/.chezmoiexternal.toml.tmpl`);
});
