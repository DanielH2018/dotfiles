// shell/common.sh sets EDITOR to nvim, the editor dot_config/nvim configures, and falls back
// to vim on a host where no installer put nvim on PATH. On macOS that is a host that never ran
// `brew bundle`, since the Brewfile lists neovim.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { have } = require('../lib/probe');
const { srcPath } = require('../lib/paths');

const COMMON = srcPath('dot_config', 'shell', 'common.sh');
const BASE_PATH = '/usr/bin:/bin';
const skip = have('bash') ? false : 'no bash available';

function editorsWith(pathVar) {
  const home = scratch(os.tmpdir(), 'editor-');
  return execFileSync('bash', ['-c', `. "${COMMON}" 2>/dev/null; echo "$EDITOR $VISUAL"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: pathVar },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('EDITOR and VISUAL are nvim when nvim is on PATH', { skip }, () => {
  const bin = scratch(os.tmpdir(), 'editor-bin-');
  fs.writeFileSync(path.join(bin, 'nvim'), '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(editorsWith(`${bin}:${BASE_PATH}`), 'nvim nvim');
});

test('EDITOR and VISUAL fall back to vim without nvim', {
  skip: skip || (['/usr/bin/nvim', '/bin/nvim'].some(fs.existsSync) && 'nvim is in /usr/bin or /bin'),
}, () => {
  assert.strictEqual(editorsWith(BASE_PATH), 'vim vim');
});
