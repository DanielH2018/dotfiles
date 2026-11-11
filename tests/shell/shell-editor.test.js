// shell/common.sh sets EDITOR to nano, and falls back to vi on a host without nano.
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

test('EDITOR and VISUAL are nano when nano is on PATH', { skip }, () => {
  const bin = scratch(os.tmpdir(), 'editor-bin-');
  fs.writeFileSync(path.join(bin, 'nano'), '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(editorsWith(`${bin}:${BASE_PATH}`), 'nano nano');
});

test('EDITOR and VISUAL fall back to vi without nano', {
  skip: skip || (['/usr/bin/nano', '/bin/nano'].some(fs.existsSync) && 'nano is in /usr/bin or /bin'),
}, () => {
  assert.strictEqual(editorsWith(BASE_PATH), 'vi vi');
});
