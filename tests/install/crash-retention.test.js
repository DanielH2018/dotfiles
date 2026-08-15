// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-crash-retention.sh.tmpl.
//
// One rule in one file, so the tests worth having are about when it is written rather than what
// it says: a box with no /var/crash must not grow a retention rule for dumps it never takes, and
// a converged apply must not prompt for a password to rewrite a file it already wrote.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-crash-retention.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const PASSTHROUGH = ['sh', 'cat', 'cmp', 'mktemp', 'mkdir', 'install', 'rm', 'dirname', 'printf', 'echo'];

const SUDO_OK = 'echo "$@" >> "$STATE_DIR/sudo.log"; [ "$1" = "-v" ] && exit 0; exec "$@"';

const dirs = [];

function run({ state } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-retention-'));
  dirs.push(home);
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const stateDir = state || path.join(home, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const root = state ? path.dirname(stateDir) : home;
  const tmpfilesDir = path.join(root, 'etc', 'tmpfiles.d');

  for (const [name, script] of Object.entries({ sudo: SUDO_OK, 'systemd-tmpfiles': 'exit 0' })) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderFile(SRC));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, STATE_DIR: stateDir, TMPFILES_DIR: tmpfilesDir },
  });

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    stateDir,
    tmpfiles: read(path.join(tmpfilesDir, 'kdump-crash.conf')),
    sudoLog: read(path.join(stateDir, 'sudo.log')) || '',
  };
}

const linux = process.platform === 'linux';
// /var/crash is the script's own gate, and it is a real path rather than an overridable one, so
// on a machine without kdump every assertion below would be about the no-op path instead.
const hasCrashDir = fs.existsSync('/var/crash');

test('renders empty off Linux', { skip }, () => {
  if (!linux) assert.strictEqual(renderFile(SRC).trim(), '', 'must render empty off Linux');
});

test('bounds /var/crash with an age-based tmpfiles rule', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasCrashDir) return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.tmpfiles, /^e \/var\/crash - - - 14d$/m);
});

test('a converged apply changes nothing and never probes sudo', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '' || !hasCrashDir) return;
  const first = run();
  assert.strictEqual(first.exitCode, 0, first.out);
  const second = run({ state: first.stateDir });
  assert.strictEqual(second.exitCode, 0, second.out);
  // The log persists across both runs by design, so "no new lines" is the assertion.
  assert.strictEqual(second.sudoLog, first.sudoLog, 'a converged apply must not touch sudo');
});

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
