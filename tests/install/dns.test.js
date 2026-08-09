// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-dns.sh.tmpl.
//
// The interesting part is not "does it call nmcli" — it is the ordering and the two refusals.
// Mullvad's `~.` routing domain outranks every LAN link, so the Mullvad half has to land
// first or there is a window where the profiles claim the Pi-hole and the tunnel still wins.
// And the script must refuse twice rather than half-apply: once when Mullvad's firewall would
// swallow LAN traffic, once when there is no sudo.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-dns.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const PIHOLE = '10.0.0.243';

// Real binaries the script needs; PATH is replaced wholesale by the stub dir, so anything not
// listed here and not stubbed simply won't exist.
const PASSTHROUGH = ['sh', 'grep', 'cat', 'mkdir'];

// sudo that authenticates and otherwise execs through, so the wrapped nmcli logs its own argv.
const SUDO_OK = '[ "$1" = "-v" ] && exit 0; exec "$@"';
const SUDO_NONE = '[ "$1" = "-v" ] && exit 1; exec "$@"';

// Both stubs log one pipe-joined line per call. Pipe-joined rather than space-joined because
// "Wired connection 1" contains spaces and the whole point is asserting it arrived as one arg.
// The name is baked in rather than read from $0, which is the stub's full temp path.
const logArgv = (name) => `i=${name}; for a in "$@"; do i="$i|$a"; done; echo "$i" >> "$LOG"`;

const NMCLI = `${logArgv('nmcli')}
if [ "$1" = "-t" ]; then printf '%s\\n' "\${NM_CONNS:-Wired connection 1
HUNTER-5G}"; fi
exit 0`;

const MULLVAD = `${logArgv('mullvad')}
if [ "$1" = "lan" ]; then echo "Local network sharing setting: \${MULLVAD_LAN:-allow}"; fi
exit 0`;

const dirs = [];

function run({ sudo = SUDO_OK, mullvad = MULLVAD, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dns-'));
  dirs.push(home);
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }
  const stubs = { sudo, nmcli: NMCLI };
  if (mullvad !== null) stubs.mullvad = mullvad;
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const log = path.join(home, 'argv.log');
  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderTemplate(body));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, LOG: log, ...env },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { out, exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]), calls };
}

// Renders to nothing off a personal Linux desktop, so `chezmoi apply` never runs it on the
// homelab (server profile), the Pi (minimal) or WSL. The behavior tests below would drive an
// empty script there and vacuously pass, so they return early on the same condition.
const inert = () => process.platform !== 'linux' || renderTemplate(body).trim() === '';

test('gated to a personal Linux desktop', { skip }, () => {
  assert.match(body, /\{\{ if includeTemplate "is-desktop-linux" \. -\}\}/);
  if (process.platform !== 'linux') {
    assert.strictEqual(renderTemplate(body).trim(), '', 'must render empty off Linux');
  }
});

// Mullvad before nmcli. Reversed, there is a window where the links advertise the Pi-hole while
// the tunnel's `~.` domain still captures every query — the exact state that made the manual
// change look like it had not worked.
test('points Mullvad at the Pi-hole before touching NetworkManager', { skip }, () => {
  if (inert()) return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  const dnsSet = r.calls.findIndex((c) => c === `mullvad|dns|set|custom|${PIHOLE}`);
  const firstMod = r.calls.findIndex((c) => c.startsWith('nmcli|connection|modify'));
  assert.ok(dnsSet >= 0, `no mullvad dns set in ${JSON.stringify(r.calls)}`);
  assert.ok(firstMod >= 0, 'expected an nmcli modify');
  assert.ok(dnsSet < firstMod, 'Mullvad must be pointed at the Pi-hole before the links are');
});

// Both address families, on both LAN profiles. Leaving ipv6.ignore-auto-dns off keeps the ISP's
// v6 resolvers alive and queries bypass the Pi-hole, which reads as broken filtering.
test('sets v4 DNS and suppresses DHCP resolvers on both families', { skip }, () => {
  if (inert()) return;
  const r = run();
  for (const conn of ['Wired connection 1', 'HUNTER-5G']) {
    assert.ok(
      r.calls.includes(`nmcli|connection|modify|${conn}|ipv4.dns|${PIHOLE}|ipv4.ignore-auto-dns|yes|ipv6.ignore-auto-dns|yes`),
      `missing modify for ${conn} in ${JSON.stringify(r.calls)}`,
    );
    assert.ok(r.calls.includes(`nmcli|connection|up|${conn}`), `missing re-activation for ${conn}`);
  }
});

// A modify without the re-activation leaves the live link on the DHCP resolvers, so the apply
// reports success while nothing has actually changed until the next reconnect.
test('re-activates each connection after modifying it', { skip }, () => {
  if (inert()) return;
  const r = run();
  const mod = r.calls.indexOf('nmcli|connection|modify|HUNTER-5G|ipv4.dns|10.0.0.243|ipv4.ignore-auto-dns|yes|ipv6.ignore-auto-dns|yes');
  const up = r.calls.indexOf('nmcli|connection|up|HUNTER-5G');
  assert.ok(mod >= 0 && up > mod, 'up must follow modify');
});

// Mullvad's firewall blocking LAN traffic makes a LAN resolver inert — the queries are dropped
// and the box has no DNS at all. Refuse; do not widen the VPN firewall from an apply script.
test('refuses when Mullvad LAN sharing is off, without touching NetworkManager', { skip }, () => {
  if (inert()) return;
  const r = run({ env: { MULLVAD_LAN: 'block' } });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(!r.calls.some((c) => c.startsWith('nmcli|connection|modify')), 'must not reconfigure links it cannot reach the resolver from');
  assert.ok(!r.calls.some((c) => c.startsWith('mullvad|dns|set')), 'must not set a custom DNS that would be swallowed');
  assert.match(r.out, /local network sharing is off/);
  assert.match(r.out, /mullvad lan set allow/);
});

// No Mullvad at all is not an error — a desktop without the VPN just needs the nmcli half.
test('configures NetworkManager on a machine with no Mullvad', { skip }, () => {
  if (inert()) return;
  const r = run({ mullvad: null });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.ok(r.calls.some((c) => c.startsWith('nmcli|connection|modify|Wired connection 1')));
});

// A connection this machine doesn't have is skipped, not fatal: the names are this desktop's,
// and another workstation reaching this script should still get whatever it does have.
test('skips a connection that does not exist here', { skip }, () => {
  if (inert()) return;
  const r = run({ env: { NM_CONNS: 'Wired connection 1' } });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.ok(r.calls.some((c) => c.startsWith('nmcli|connection|modify|Wired connection 1')));
  assert.ok(!r.calls.some((c) => c.includes('HUNTER-5G')), 'must not configure an absent connection');
  assert.match(r.out, /no connection named 'HUNTER-5G'/);
});

// Without sudo, defer loudly so the next apply retries. The Mullvad half has already landed by
// then, which is deliberate: that half needs no root, and Mullvad pointed at the Pi-hole while
// the links still hold DHCP resolvers is a state that resolves.
test('without sudo it defers and reconfigures no connection', { skip }, () => {
  if (inert()) return;
  const r = run({ sudo: SUDO_NONE });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(!r.calls.some((c) => c.startsWith('nmcli|connection|modify')), 'must not modify anything without sudo');
  assert.match(r.out, /sudo unavailable; deferring the Pi-hole DNS settings/);
});

// A failing nmcli must not be reported as a successful apply.
test('a failing nmcli modify exits non-zero', { skip }, () => {
  if (inert()) return;
  const r = run({ sudo: '[ "$1" = "-v" ] && exit 0; [ "$2" = "connection" ] && [ "$3" = "modify" ] && exit 1; exec "$@"' });
  assert.strictEqual(r.exitCode, 1);
  assert.match(r.out, /failed to modify/);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
