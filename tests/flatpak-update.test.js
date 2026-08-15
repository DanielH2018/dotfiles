// Covers home/dot_local/bin/executable_flatpak-update.
//
// The script is three lines of logic around two flatpak calls, and all three are about failure:
// whether the Mullvad detour is taken, whether it is skipped safely when Mullvad cannot provide
// it, and whether a failed update still lets the prune run while surfacing its own exit code.
// The detour is the interesting one — `command -v mullvad-exclude` succeeding does not mean the
// exclusion works, so a probe that only checks the binary would route every update into a
// command that fails, and turn a slow update into no update at all.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_flatpak-update');
const body = fs.readFileSync(SRC, 'utf8');

// `true` earns its place: the capability probe is `mullvad-exclude true`, and mullvad-exclude
// execs its argument rather than interpreting it, so the builtin is not what runs. Without the
// real binary here the probe fails with ENOENT and every test silently exercises the fallback.
const PASSTHROUGH = ['bash', 'sh', 'cat', 'rm', 'mkdir', 'true'];

// Records every invocation so the assertions can read what actually ran, in order.
const FLATPAK = 'echo "flatpak $*" >> "$LOG"; exit ${FLATPAK_RC:-0}';

const dirs = [];

function run({ mullvadExclude, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flatpak-update-'));
  dirs.push(home);
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    // `type -P` rather than `command -v`: the latter answers "true" for the shell builtin, and
    // symlinking that name to itself produces a dangling link that fails as ENOENT at run time.
    let real;
    try { real = execFileSync('bash', ['-c', `type -P ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }
  const log = path.join(home, 'calls.log');
  fs.writeFileSync(path.join(binDir, 'flatpak'), `#!/bin/sh\n${FLATPAK}\n`, { mode: 0o755 });
  if (mullvadExclude) {
    fs.writeFileSync(path.join(binDir, 'mullvad-exclude'), `#!/bin/sh\n${mullvadExclude}\n`, { mode: 0o755 });
  }

  const script = path.join(home, 'flatpak-update');
  fs.writeFileSync(script, body, { mode: 0o755 });
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `${JSON.stringify(script)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, LOG: log, ...env },
  });
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  };
}

// A mullvad-exclude that works: the `true` probe succeeds and it execs what it is given.
const EXCLUDE_OK = 'echo "excluded $*" >> "$LOG"; exec "$@"';
// Present, but the daemon is down or the cgroup is refused — everything fails, probe included.
const EXCLUDE_BROKEN = 'exit 1';

test('routes both flatpak calls outside the tunnel when it can', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /excluded flatpak update --user/);
  assert.match(r.calls, /excluded flatpak uninstall --user --unused/);
});

// The reason the probe runs a command instead of checking the binary exists.
test('falls back to a plain run when mullvad-exclude is present but broken', () => {
  const r = run({ mullvadExclude: EXCLUDE_BROKEN });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^flatpak update --user/m, 'the update must still happen');
  assert.match(r.calls, /^flatpak uninstall --user --unused/m, 'the prune must still happen');
});

test('runs directly on a machine with no Mullvad at all', () => {
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^flatpak update --user/m);
});

// The opt-out, for keeping package fetches inside the tunnel and accepting the throughput.
test('FLATPAK_UPDATE_NO_EXCLUDE keeps everything in the tunnel', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK, env: { FLATPAK_UPDATE_NO_EXCLUDE: '1' } });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.doesNotMatch(r.calls, /excluded/, 'nothing may be excluded when the opt-out is set');
  assert.match(r.calls, /^flatpak update --user/m);
});

// A failed update must not swallow its own status, and must not cost the prune — the runtimes
// nothing references are collectable whether or not the update worked.
test('a failed update still prunes and still reports its exit code', () => {
  const r = run({ env: { FLATPAK_RC: '1' } });
  assert.strictEqual(r.exitCode, 1, 'the update failure must reach the caller');
  assert.match(r.calls, /^flatpak uninstall --user --unused/m, 'the prune must run anyway');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
