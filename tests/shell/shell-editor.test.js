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
const skip = have('bash') ? false : 'no bash available';
// By absolute path: PATH below is a scratch dir, so it cannot resolve bash itself.
const BASH = skip ? '' : execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

// PATH is only `bin`, so the system nano never shadows the case under test.
function editorsWith(bin) {
  const home = scratch(os.tmpdir(), 'editor-');
  return execFileSync(BASH, ['-c', `. "${COMMON}" 2>/dev/null; echo "$EDITOR $VISUAL"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: bin },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('EDITOR and VISUAL are nano when nano is on PATH', { skip }, () => {
  const bin = scratch(os.tmpdir(), 'editor-bin-');
  fs.writeFileSync(path.join(bin, 'nano'), '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(editorsWith(bin), 'nano nano');
});

test('EDITOR and VISUAL fall back to vi without nano', { skip }, () => {
  assert.strictEqual(editorsWith(scratch(os.tmpdir(), 'editor-bin-')), 'vi vi');
});
