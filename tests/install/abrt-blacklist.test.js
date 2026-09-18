// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-abrt-blacklist.sh.tmpl.
//
// Two things here are worth pinning, and neither is "does it write a line".
//
// The first is that the script rewrites its own marker block instead of appending a second
// one. This runs on every `chezmoi apply` whose render changes, so a version that appended
// would grow the file without bound and leave several conflicting BlackListedPaths lines.
//
// The second is the ordering of the convergence check against the sudo probe. A no-op apply
// must not prompt for a password -- get that backwards and every apply on this box asks for
// root to change nothing, which is exactly the kind of friction that gets a script deleted.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-abrt-blacklist.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// What Fedora ships: all comments, no options set.
const STOCK = `# Configuration for the ABRT daemon
# ---------------------------------
#
# This config file is empty by default which means that the preconfigured
# default values will be used by ABRT.
`;

// Only the opening marker is needed: the one test that uses it builds a block deliberately
// missing its close.
const BEGIN = '# >>> chezmoi abrt-blacklist >>>';

// PATH is replaced wholesale by the stub dir, so anything not listed and not stubbed will not
// exist. `install` is real: the script's write goes through it.
const PASSTHROUGH = ['sh', 'cat', 'grep', 'awk', 'cmp', 'mktemp', 'rm', 'printf', 'install'];

// sudo that authenticates and otherwise execs through, so `sudo install` really writes.
const SUDO_OK = '[ "$1" = "-v" ] && exit 0; exec "$@"';
// sudo whose credential probe fails -- the defer path.
const SUDO_NONE = '[ "$1" = "-v" ] && exit 1; exec "$@"';

function run(initialConf, { sudo = SUDO_OK } = {}) {
  const home = scratch(os.tmpdir(), 'abrt-bl-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }
  fs.writeFileSync(path.join(binDir, 'sudo'), `#!/bin/sh\n${sudo}\n`, { mode: 0o755 });

  const conf = path.join(home, 'abrt.conf');
  if (initialConf !== null) fs.writeFileSync(conf, initialConf);

  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderTemplate(body));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, ABRT_CONF: conf },
  });

  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    conf: fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : null,
  };
}

// Skips the behavioural tests where the template renders to nothing (non-Linux), since there
// is no script to run there.
function inert() {
  return process.platform !== 'linux' || renderTemplate(body).trim() === '';
}

test('gated to Linux and the workstation profile', { skip }, () => {
  assert.match(body, /\{\{ if and \(eq \.chezmoi\.os "linux"\) \(eq \.profile "workstation"\) -\}\}/);
  if (process.platform !== 'linux') {
    assert.strictEqual(renderTemplate(body).trim(), '', 'must render empty off Linux');
  }
});

// ABRT replaces the default list rather than extending it, so dropping the four shipped
// defaults would start reporting crashes they exist to silence. Easy to lose in a later edit.
test('keeps ABRT\'s four default paths alongside the added one', { skip }, () => {
  if (inert()) return;
  const r = run(STOCK);
  assert.strictEqual(r.exitCode, 0, r.out);
  for (const p of ['/usr/share/doc/*', '*/example*', '/usr/bin/nspluginviewer', '/usr/lib*/firefox/plugin-container', '/usr/bin/python3.13']) {
    assert.ok(r.conf.includes(p), `default path ${p} must survive`);
  }
});

test('writes the blacklist inside a marker block and preserves existing content', { skip }, () => {
  if (inert()) return;
  const r = run(STOCK);
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.ok(r.conf.startsWith(STOCK), 'must not disturb the shipped comments');
  assert.match(r.conf, /^# >>> chezmoi abrt-blacklist >>>$/m);
  assert.match(r.conf, /^# <<< chezmoi abrt-blacklist <<<$/m);
});

// The reason the marker block exists. run_onchange re-runs whenever the render changes, so an
// appending version would stack blocks and conflicting BlackListedPaths lines.
test('a second run rewrites the block rather than appending another', { skip }, () => {
  if (inert()) return;
  const first = run(STOCK);
  const second = run(first.conf);
  assert.strictEqual(second.exitCode, 0, second.out);
  assert.strictEqual(second.conf, first.conf, 're-running must be a no-op');
  assert.strictEqual(second.conf.match(/BlackListedPaths/g).length, 1, 'exactly one BlackListedPaths line');
  assert.strictEqual(second.conf.match(/>>> chezmoi abrt-blacklist >>>/g).length, 1, 'exactly one managed block');
});

// The ordering that keeps every no-op apply from prompting for root.
test('an already-converged file never reaches the sudo probe', { skip }, () => {
  if (inert()) return;
  const first = run(STOCK);
  // sudo here fails its probe AND refuses to exec. If the script consults sudo at all on a
  // converged file, this run cannot exit 0 silently.
  const second = run(first.conf, { sudo: 'exit 1' });
  assert.strictEqual(second.exitCode, 0, second.out);
  assert.doesNotMatch(second.out, /sudo unavailable/);
  assert.strictEqual(second.conf, first.conf);
});

// Someone pasting the same line in by hand is the expected way this collides -- that is how
// the change was first applied on this box, before it was scripted.
test('a hand-set BlackListedPaths outside the block is left alone', { skip }, () => {
  if (inert()) return;
  const manual = `${STOCK}BlackListedPaths = /usr/bin/python3.13\n`;
  const r = run(manual);
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.conf, manual, 'must not touch a hand-managed value');
  assert.match(r.out, /already set .* outside the managed block/);
});

// An unbalanced block would make the strip swallow the rest of the file, so it must refuse
// rather than truncate the config.
test('an unbalanced marker block is refused, not truncated', { skip }, () => {
  if (inert()) return;
  const broken = `${STOCK}${BEGIN}\nBlackListedPaths = /usr/bin/python3.13\n`;
  const r = run(broken);
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.conf, broken, 'must leave the damaged file exactly as found');
  assert.match(r.out, /unbalanced/);
});

test('without sudo it defers and changes nothing', { skip }, () => {
  if (inert()) return;
  const r = run(STOCK, { sudo: SUDO_NONE });
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.conf, STOCK, 'must not write anything without sudo');
  assert.match(r.out, /sudo unavailable; deferring the ABRT crash-notification blacklist/);
});

test('a missing config file is a no-op, not a failure', { skip }, () => {
  if (inert()) return;
  const r = run(null);
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.out, /does not exist; nothing to configure/);
});

