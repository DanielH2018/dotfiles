// Covers home/dot_local/bin/executable_discord and the desktop entry that calls it.
//
// The wrapper exists to keep Discord off the Mullvad exit address, because Cloudflare 403s the
// app shell from exits whose reputation has drifted. Everything worth testing is a failure mode:
// whether the exclusion is actually taken, whether a broken Mullvad still lets Discord start
// (refusing to launch a chat client because a VPN detour is unavailable is the worst outcome
// available), whether the opt-out works, and whether arguments survive — the desktop entry
// passes `--url -- %u`, so an argument dropped here breaks the discord:// scheme handler.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');

const SRC = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_discord');
const body = fs.readFileSync(SRC, 'utf8');

const DESKTOP = path.join(
  __dirname, '..', 'home', 'dot_local', 'share', 'applications', 'discord.desktop.tmpl',
);
const desktop = fs.readFileSync(DESKTOP, 'utf8');

// `true` earns its place: the capability probe is `mullvad-exclude true`, and mullvad-exclude
// execs its argument rather than interpreting it, so the shell builtin is not what runs.
const PASSTHROUGH = ['bash', 'sh', 'cat', 'rm', 'mkdir', 'true'];

function run({ mullvadExclude, args = [], realExecutable = true, env = {} } = {}) {
  const home = scratch(os.tmpdir(), 'discord-wrapper-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('bash', ['-c', `type -P ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const log = path.join(home, 'calls.log');

  // Stands in for /usr/bin/discord. Records its arguments so argument passing can be asserted.
  const realBin = path.join(home, 'discord-real');
  fs.writeFileSync(realBin, '#!/bin/sh\necho "discord $*" >> "$LOG"\n', { mode: realExecutable ? 0o755 : 0o644 });

  if (mullvadExclude) {
    fs.writeFileSync(path.join(binDir, 'mullvad-exclude'), `#!/bin/sh\n${mullvadExclude}\n`, { mode: 0o755 });
  }

  const script = path.join(home, 'discord');
  fs.writeFileSync(script, body, { mode: 0o755 });
  const argv = args.map((a) => JSON.stringify(a)).join(' ');
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `${JSON.stringify(script)} ${argv} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, LOG: log, DISCORD_BIN: realBin, ...env },
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

test('launches Discord outside the tunnel when it can', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^excluded /m, 'the launch must go through mullvad-exclude');
  assert.match(r.calls, /^discord/m, 'and Discord must still start');
});

// The reason the probe runs a command instead of checking the binary exists: a present but
// non-functional mullvad-exclude would otherwise stop Discord from starting at all.
test('still starts Discord when mullvad-exclude is present but broken', () => {
  const r = run({ mullvadExclude: EXCLUDE_BROKEN });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^discord/m, 'Discord must start even with no exclusion available');
});

test('starts Discord on a machine with no Mullvad at all', () => {
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.match(r.calls, /^discord/m);
});

// The opt-out — for putting Discord back inside the tunnel once an exit is known good.
test('DISCORD_NO_EXCLUDE keeps Discord inside the tunnel', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK, env: { DISCORD_NO_EXCLUDE: '1' } });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.doesNotMatch(r.calls, /excluded/, 'nothing may be excluded when the opt-out is set');
  assert.match(r.calls, /^discord/m);
});

// The desktop entry passes `--url -- %u`; a dropped argument breaks the discord:// handler.
test('passes its arguments through, excluded or not', () => {
  const args = ['--url', '--', 'discord://-/channels/@me'];
  for (const mullvadExclude of [EXCLUDE_OK, undefined]) {
    const r = run({ mullvadExclude, args });
    assert.strictEqual(r.exitCode, 0, r.out);
    assert.match(r.calls, /^discord --url -- discord:\/\/-\/channels\/@me$/m, r.calls);
  }
});

// A missing Discord must fail loudly rather than exit 0 and leave nothing running.
test('reports a missing Discord binary instead of silently succeeding', () => {
  const r = run({ mullvadExclude: EXCLUDE_OK, realExecutable: false });
  assert.strictEqual(r.exitCode, 127, r.out);
  assert.match(r.out, /is not executable/);
  assert.strictEqual(r.calls, '', 'nothing may run when there is no Discord to run');
});

// The wrapper only covers the shell; the desktop entry is what the application menu launches, and
// it must point at the wrapper rather than back at /usr/bin/discord.
test('the desktop entry launches the wrapper, not the system binary', () => {
  assert.match(desktop, /^Exec=\{\{ \.chezmoi\.homeDir \}\}\/\.local\/bin\/discord /m);
  assert.doesNotMatch(desktop, /^Exec=\/usr\/bin\/discord/m);
});

// Shadowing only works if the filename matches the system entry it overrides.
test('the desktop entry keeps the fields that make it shadow the system one', () => {
  assert.match(desktop, /^StartupWMClass=discord$/m, 'window matching must survive the override');
  assert.match(desktop, /^MimeType=x-scheme-handler\/discord;$/m, 'the discord:// handler must survive');
  assert.match(desktop, /^Icon=discord$/m);
});

