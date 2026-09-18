// Covers home/dot_local/bin/executable_steam and the desktop entry that calls it.
//
// The wrapper exists to keep Steam's peer connections off the Mullvad exit, whose NAT drops the
// unsolicited inbound UDP that Steam's ICE-style traversal needs — the failure the user sees is
// `5008, Timed out attempting to negotiate rendezvous` when joining a lobby. Everything worth
// testing is a failure mode: whether the exclusion is actually taken, whether a broken Mullvad
// still lets Steam start (refusing to launch the games library because a VPN detour is
// unavailable is the worst outcome available), whether the opt-out works, and whether arguments
// survive — the desktop entry passes %U and nine steam:// URLs, so a dropped argument breaks the
// scheme handler and every context-menu action.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { srcPath } = require('./lib/paths');

const SRC = srcPath('dot_local', 'bin', 'executable_steam');
const body = fs.readFileSync(SRC, 'utf8');

const DESKTOP = srcPath('dot_local', 'share', 'applications', 'steam.desktop.tmpl');
const desktop = fs.readFileSync(DESKTOP, 'utf8');

// `true` earns its place: the capability probe is `mullvad-exclude true`, and mullvad-exclude
// execs its argument rather than interpreting it, so the shell builtin is not what runs.
const PASSTHROUGH = ['bash', 'sh', 'cat', 'rm', 'mkdir', 'true'];

function run({ mullvadExclude, args = [], realExecutable = true, env = {} } = {}) {
  const home = scratch(os.tmpdir(), 'steam-wrapper-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('bash', ['-c', `type -P ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const log = path.join(home, 'calls.log');

  // Stands in for /usr/bin/steam. Records its arguments so argument passing can be asserted.
  const realBin = path.join(home, 'steam-real');
  fs.writeFileSync(realBin, '#!/bin/sh\necho "steam $*" >> "$LOG"\n', { mode: realExecutable ? 0o755 : 0o644 });

  if (mullvadExclude) {
    fs.writeFileSync(path.join(binDir, 'mullvad-exclude'), `#!/bin/sh\n${mullvadExclude}\n`, { mode: 0o755 });
  }

  const script = path.join(home, 'steam');
  fs.writeFileSync(script, body, { mode: 0o755 });
  const argv = args.map((a) => JSON.stringify(a)).join(' ');
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `${JSON.stringify(script)} ${argv} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, LOG: log, STEAM_BIN: realBin, ...env },
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

test('launches Steam outside the tunnel when it can', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^excluded /m, 'the launch must go through mullvad-exclude');
  assert.match(r.calls, /^steam/m, 'and Steam must still start');
});

// The reason the probe runs a command instead of checking the binary exists: a present but
// non-functional mullvad-exclude would otherwise stop Steam from starting at all.
test('still starts Steam when mullvad-exclude is present but broken', () => {
  const r = run({ mullvadExclude: EXCLUDE_BROKEN });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^steam/m, 'Steam must start even with no exclusion available');
});

test('starts Steam on a machine with no Mullvad at all', () => {
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^steam/m);
});

// The opt-out — for putting a launch back inside the tunnel when peer connections do not matter.
test('STEAM_NO_EXCLUDE keeps Steam inside the tunnel', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK, env: { STEAM_NO_EXCLUDE: '1' } });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.doesNotMatch(r.calls, /excluded/, 'nothing may be excluded when the opt-out is set');
  assert.match(r.calls, /^steam/m);
});

// The desktop actions pass a steam:// URL each; a dropped argument breaks every one of them.
test('passes its arguments through, excluded or not', () => {
  const args = ['steam://open/games'];
  for (const mullvadExclude of [EXCLUDE_OK, undefined]) {
    const r = run({ mullvadExclude, args });
    assert.strictEqual(r.exitCode, 0, r.out);
    assert.match(r.calls, /^steam steam:\/\/open\/games$/m, r.calls);
  }
});

// A missing Steam must fail loudly rather than exit 0 and leave nothing running.
test('reports a missing Steam binary instead of silently succeeding', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK, realExecutable: false });
  assert.strictEqual(r.exitCode, 127, r.out);
  assert.match(r.out, /is not executable/);
  assert.strictEqual(r.calls, '', 'nothing may run when there is no Steam to run');
});

// The wrapper only covers the shell; the desktop entry is what the application menu launches.
// Actions do not inherit the top-level Exec, so every one of them has to be redirected — a
// missed action is a menu item that quietly starts Steam inside the tunnel.
test('every Exec in the desktop entry launches the wrapper, not the system binary', () => {
  const execs = desktop.match(/^Exec=.*$/gm) || [];
  assert.ok(execs.length >= 10, `expected the main entry plus nine actions, got ${execs.length}`);
  for (const line of execs) {
    assert.match(line, /^Exec=\{\{ \.chezmoi\.homeDir \}\}\/\.local\/bin\/steam(\s|$)/, line);
  }
  assert.doesNotMatch(desktop, /^Exec=\/usr\/bin\/steam/m);
});

// Guards the reverse drift: an action declared in the header but never given a section, or a
// section added without being declared, is a menu item that falls back to the system entry.
test('the declared actions and the action sections agree', () => {
  const declared = (desktop.match(/^Actions=(.*)$/m) || [])[1].split(';').filter(Boolean);
  const sections = (desktop.match(/^\[Desktop Action (.+)\]$/gm) || [])
    .map((s) => s.replace(/^\[Desktop Action (.+)\]$/, '$1'));
  assert.deepStrictEqual(sections.sort(), declared.slice().sort());
});

// Shadowing only works if the filename matches the system entry it overrides and the fields that
// route launches to it survive.
test('the desktop entry keeps the fields that make it shadow the system one', () => {
  assert.match(desktop, /^MimeType=x-scheme-handler\/steam;x-scheme-handler\/steamlink;$/m,
    'both steam:// scheme handlers must survive the override');
  assert.match(desktop, /^Icon=steam$/m);
  assert.match(desktop, /^Categories=Network;FileTransfer;Game;$/m);
});

