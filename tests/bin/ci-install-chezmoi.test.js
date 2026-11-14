// Unit tests for bin/ci-install-chezmoi, the one installer every CI job uses for chezmoi.
//
// `curl` and `uname` are stubs on PATH: curl copies the requested URL's basename out of a
// fixture release directory and logs the URL, and uname answers for the OS under test. So
// these check which asset the script asks for and what it does with the checksum, offline.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { repoPath, srcPath } = require('../lib/paths');

const SCRIPT = repoPath('bin', 'ci-install-chezmoi');
const skip = have('bash') && have('tar') ? false : 'bash or tar unavailable';

const pin = /^chezmoi = "([^"]+)"$/m.exec(
  fs.readFileSync(srcPath('.chezmoidata', 'tools.toml'), 'utf8').split(/^\[toolchain\]$/m)[1],
)[1];

// A release directory holding one tarball for `asset`, and a checksums.txt that lists it with
// its real digest, or with `badSum` in its place.
function release(t, asset, { badSum } = {}) {
  const root = scratch(os.tmpdir(), 'ci-install-chezmoi-', t);
  const stage = path.join(root, 'stage');
  const rel = path.join(root, 'release');
  fs.mkdirSync(stage);
  fs.mkdirSync(rel);
  fs.writeFileSync(path.join(stage, 'chezmoi'), `#!/bin/sh\necho "fake chezmoi ${asset}"\n`, { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(rel, asset), '-C', stage, 'chezmoi']);
  const sum = badSum || crypto.createHash('sha256').update(fs.readFileSync(path.join(rel, asset))).digest('hex');
  fs.writeFileSync(path.join(rel, `chezmoi_${pin}_checksums.txt`), `${sum}  ${asset}\n`);
  return { root, rel };
}

function run(root, rel, { system, machine }) {
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'curl'), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "${root}/urls"
cp "${rel}/\${url##*/}" "$out"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'uname'), `#!/bin/sh
case "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac
`, { mode: 0o755 });
  const bindir = path.join(root, 'bin');
  const r = spawnSync('bash', [SCRIPT, bindir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
  });
  return { ...r, bindir, urls: fs.existsSync(path.join(root, 'urls')) ? fs.readFileSync(path.join(root, 'urls'), 'utf8') : '' };
}

test('installs the pinned release asset for the runner OS and arch', { skip }, (t) => {
  const asset = `chezmoi_${pin}_darwin_arm64.tar.gz`;
  const { root, rel } = release(t, asset);
  const r = run(root, rel, { system: 'Darwin', machine: 'arm64' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.urls, new RegExp(`/download/v${pin.replace(/\./g, '\\.')}/${asset}$`, 'm'));
  assert.strictEqual(execFileSync(path.join(r.bindir, 'chezmoi'), { encoding: 'utf8' }).trim(), `fake chezmoi ${asset}`);
});

test('refuses an asset whose digest is not the one checksums.txt lists', { skip }, (t) => {
  const asset = `chezmoi_${pin}_linux_amd64.tar.gz`;
  const { root, rel } = release(t, asset, { badSum: '0'.repeat(64) });
  const r = run(root, rel, { system: 'Linux', machine: 'x86_64' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /checksum mismatch/);
  assert.ok(!fs.existsSync(path.join(r.bindir, 'chezmoi')), 'a mismatched binary must not be installed');
});
