// env.sh inside a distrobox/toolbox: ~/.local/bin is the host's, so the container's own
// /usr/local/bin (its tmux build) must come first. Outside one, PATH order is untouched.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const ENV_SH = srcPath('dot_config', 'shell', 'env.sh');

function pathAfter(t, { toolbox, times = 1 }) {
  const home = scratch(os.tmpdir(), 'env-sh-toolbox-', t);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const marker = path.join(home, toolbox ? 'toolboxenv' : 'absent');
  if (toolbox) fs.writeFileSync(marker, '');
  const source = Array(times).fill('. "$ENV_SH"').join('; ');
  return execFileSync('sh', ['-c', `${source}; printf %s "$PATH"`], {
    env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', ENV_SH, TOOLBOXENV_MARKER: marker },
    encoding: 'utf8',
  }).split(':');
}

test('in a toolbox, /usr/local/bin precedes ~/.local/bin, once however often env.sh runs', (t) => {
  const dirs = pathAfter(t, { toolbox: true, times: 2 });
  assert.strictEqual(dirs[0], '/usr/local/bin');
  assert.ok(dirs[1].endsWith('/.local/bin'), dirs.join(':'));
  assert.strictEqual(dirs.filter((d) => d === '/usr/local/bin').length, 2, 'only the one front copy is added');
});

test('outside a toolbox, ~/.local/bin stays first', (t) => {
  assert.ok(pathAfter(t, { toolbox: false })[0].endsWith('/.local/bin'));
});
