// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-firewall.sh.tmpl.
//
// The script's whole reason to exist is that the stock FedoraWorkstation zone opens 1025-65535
// to any source, and this box has routable IPv6 — so the two assertions that matter are that the
// unscoped ports are gone and that the source-scoped replacements are present. Getting the first
// without the second is a broken Spotify Connect and a broken KDE Connect; getting the second
// without the first is a no-op that looks like a fix.
//
// The rollback path is tested too, because a zone file that firewalld rejects is worse than no
// override at all: firewalld would drop the zone and fall back to something neither policy
// intended, and it would do it at reload time rather than at apply time.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');

const SRC = path.join(__dirname, '..', '..', 'home', '.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-firewall.sh.tmpl');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const PASSTHROUGH = ['sh', 'cat', 'cmp', 'mktemp', 'mkdir', 'install', 'rm', 'dirname', 'printf', 'echo', 'grep'];

const SUDO_OK = 'echo "$@" >> "$STATE_DIR/sudo.log"; [ "$1" = "-v" ] && exit 0; exec "$@"';

// firewall-cmd over a state directory, so a --reload is observable and --check-config can be
// made to fail without inventing a second stub.
const FIREWALL_CMD = `
echo "$@" >> "$STATE_DIR/firewall.log"
case "$1" in
  --check-config) [ -f "$STATE_DIR/badconfig" ] && exit 1; exit 0 ;;
esac
exit 0`;

function run({ state, firewalld = true, badConfig = false, stockZone = true } = {}) {
  const home = scratch(os.tmpdir(), 'firewall-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }

  const stateDir = state || path.join(home, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  if (badConfig) fs.writeFileSync(path.join(stateDir, 'badconfig'), '');

  const root = state ? path.dirname(stateDir) : home;
  const zoneDir = path.join(root, 'etc', 'firewalld', 'zones');
  const stock = path.join(root, 'usr', 'lib', 'firewalld', 'zones', 'FedoraWorkstation.xml');
  if (stockZone) {
    fs.mkdirSync(path.dirname(stock), { recursive: true });
    fs.writeFileSync(stock, '<zone/>\n');
  }

  const stubs = { sudo: SUDO_OK };
  // Presence on PATH is what the script tests, so a machine without firewalld is one where this
  // stub is simply absent.
  if (firewalld) stubs['firewall-cmd'] = FIREWALL_CMD;
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderFile(SRC));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, STATE_DIR: stateDir, FIREWALLD_ZONE_DIR: zoneDir, STOCK_ZONE: stock },
  });

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out,
    exitCode: Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]),
    stateDir,
    zone: read(path.join(zoneDir, 'FedoraWorkstation.xml')),
    sudoLog: read(path.join(stateDir, 'sudo.log')) || '',
    firewallLog: read(path.join(stateDir, 'firewall.log')) || '',
  };
}

const linux = process.platform === 'linux';

test('renders empty off Linux', { skip }, () => {
  if (!linux) assert.strictEqual(renderFile(SRC).trim(), '', 'must render empty off Linux');
});

// The change itself, stated both ways round. An unscoped <port> surviving means the hole is
// still there; a missing rich rule means Spotify's dynamic port and KDE Connect are now blocked.
test('replaces the unscoped high ports with subnet-scoped rules', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  assert.strictEqual(r.exitCode, 0, r.out);
  // A <port> directly under <zone> is open to any source; the same element inside a <rule> is
  // scoped by that rule's <source>. Only the first kind is the hole, so the rules are stripped
  // before looking — matching on indentation alone would not tell the two apart.
  const outsideRules = r.zone.replace(/<rule[\s\S]*?<\/rule>/g, '');
  assert.doesNotMatch(outsideRules, /<port /,
    'a zone-level <port> is open to any source; that is the hole being closed');
  for (const proto of ['tcp', 'udp']) {
    assert.match(r.zone, new RegExp(`<source address="10\\.0\\.0\\.0/24"/>\\s*<port protocol="${proto}" port="1025-65535"/>`),
      `${proto} must stay open to the LAN or LAN peer-to-peer breaks`);
    assert.match(r.zone, new RegExp(`<source address="fe80::/10"/>\\s*<port protocol="${proto}" port="1025-65535"/>`),
      `${proto} must stay open on link-local`);
  }
  // A rule naming today's delegated prefix would stop matching when the ISP rotates it.
  assert.doesNotMatch(r.zone, /2601:/, 'no global IPv6 prefix may be hard-coded');
});

// ssh is in here because losing it on a remote apply is unrecoverable; mdns because Spotify and
// KDE Connect both discover over it.
test('keeps the services the stock zone shipped, plus mdns', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  for (const svc of ['ssh', 'dhcpv6-client', 'samba-client', 'mdns']) {
    assert.match(r.zone, new RegExp(`<service name="${svc}"/>`), `${svc} must be allowed`);
  }
});

test('reloads firewalld so the override is live before the apply returns', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run();
  assert.match(r.firewallLog, /--reload/, 'a permanent zone file nobody reloaded is not policy');
});

// The same contract every other root-touching script here holds: a no-op apply must not prompt.
test('a converged apply changes nothing and never probes sudo', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const first = run();
  assert.strictEqual(first.exitCode, 0, first.out);
  const second = run({ state: first.stateDir });
  assert.strictEqual(second.exitCode, 0, second.out);
  // The log persists across both runs by design, so "no new lines" is the assertion — an empty
  // log would only prove the first run had not happened either.
  assert.strictEqual(second.sudoLog, first.sudoLog, 'a converged apply must not touch sudo');
  assert.strictEqual(second.zone, first.zone, 'a converged apply must not rewrite the zone');
});

// Rolled back rather than left in place: firewalld drops a zone it cannot parse at reload time,
// which would silently replace this policy with a stricter one nobody chose.
test('removes the override and fails when firewalld rejects it', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ badConfig: true });
  assert.notStrictEqual(r.exitCode, 0, 'a rejected config must fail the script');
  assert.strictEqual(r.zone, null, 'the rejected override must not be left on disk');
  assert.doesNotMatch(r.firewallLog, /--reload/, 'a rejected config must not be reloaded');
});

test('does nothing without firewalld', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ firewalld: false });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.zone, null, 'no firewalld means no zone to override');
});

// A packaged zone that has moved is a signal Fedora redefined it, and papering an override over
// a zone whose defaults are unknown is how a firewall quietly stops matching its own comments.
test('does nothing when the packaged zone is missing', { skip }, () => {
  if (!linux || renderFile(SRC).trim() === '') return;
  const r = run({ stockZone: false });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.strictEqual(r.zone, null);
});

