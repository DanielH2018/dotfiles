// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-updatedb-prune.sh.tmpl.
//
// This one edits a file it does not own, which is the whole risk: it must append exactly once,
// leave the rest of /etc/updatedb.conf alone, and recognise its own past work so a second apply
// does not append again. An idempotence bug here is invisible until PRUNEPATHS has the same path
// in it a dozen times.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-updatedb-prune.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const PASSTHROUGH = ['sh', 'grep', 'sed', 'echo', 'printf'];

const SUDO_OK = 'echo "$@" >> "$STATE_DIR/sudo.log"; [ "$1" = "-v" ] && exit 0; exec "$@"';

const STOCK = [
  'PRUNE_BIND_MOUNTS = "yes"',
  'PRUNEFS = "9p afs autofs devfs ntfs3 tmpfs"',
  'PRUNENAMES = ".git .hg .svn"',
  'PRUNEPATHS = "/tmp /media /dev /sys /proc /run /var/cache /var/spool"',
  '',
].join('\n');

function run({ conf = STOCK, prunePath, confPath } = {}) {
  const home = scratch(os.tmpdir(), 'updatedb-prune-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const stateDir = path.join(home, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'sudo'), `#!/bin/sh\n${SUDO_OK}\n`, { mode: 0o755 });

  // The script's own gate is `[ -d "$PRUNE_PATH" ]`, so the path under test is a directory that
  // exists here rather than the real /mnt/games, which a CI box will not have.
  const target = prunePath || path.join(home, 'games');
  if (!prunePath) fs.mkdirSync(target, { recursive: true });

  const target_conf = confPath === null ? path.join(home, 'absent.conf') : path.join(home, 'updatedb.conf');
  if (confPath !== null) fs.writeFileSync(target_conf, conf);

  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderFile(SRC));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, STATE_DIR: stateDir, UPDATEDB_CONF: target_conf, PRUNE_PATH: target },
  });

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    conf: read(target_conf),
    target,
    confPath: target_conf,
    sudoLog: read(path.join(stateDir, 'sudo.log')) || '',
  };
}

const linux = process.platform === 'linux';

test('renders empty off Linux', { skip }, () => {
  if (!linux) assert.strictEqual(renderFile(SRC).trim(), '', 'must render empty off Linux');
});

test('appends the path inside the existing PRUNEPATHS quotes', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.conf, new RegExp(`^PRUNEPATHS = "/tmp /media /dev /sys /proc /run /var/cache /var/spool ${r.target}"$`, 'm'));
  // Fedora's own entries are theirs; this edit adds one path and touches nothing else.
  for (const line of ['PRUNE_BIND_MOUNTS = "yes"', 'PRUNENAMES = ".git .hg .svn"']) {
    assert.ok(r.conf.includes(line), `${line} must survive untouched`);
  }
  assert.match(r.conf, /^PRUNEFS = "9p afs autofs devfs ntfs3 tmpfs"$/m, 'PRUNEFS must not be rewritten');
});

// The failure this guards is silent: without the substring check the path is appended on every
// apply, and PRUNEPATHS grows a duplicate a day.
test('a second apply appends nothing and never probes sudo', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const first = run();
  assert.strictEqual(first.exitCode, 0, first.out);
  const second = run({ conf: first.conf, prunePath: first.target });
  assert.strictEqual(second.exitCode, 0, second.out);
  assert.strictEqual(second.conf, first.conf, 'a converged apply must not rewrite the file');
  assert.strictEqual(second.sudoLog, '', 'a converged apply must not touch sudo');
});

// A file whose shape this edit does not understand is left alone rather than appended to blindly.
test('leaves a file with no PRUNEPATHS line alone', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ conf: 'PRUNEFS = "tmpfs"\n' });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.conf, 'PRUNEFS = "tmpfs"\n', 'the file must be untouched');
  assert.match(r.out, /no PRUNEPATHS line/, 'and it must say why');
});

test('does nothing without an updatedb.conf', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ confPath: null });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.sudoLog, '', 'no config means no work and no sudo');
});

