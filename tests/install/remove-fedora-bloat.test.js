// The Fedora bloat remover is the only script in this repo that *deletes* packages, so its
// failure modes are asymmetric: installing something twice is a wasted minute, removing the wrong
// thing costs a desktop. Three of those failure modes are silent and motivate most of what
// follows:
//   1. A package added to removals.toml that packages.toml also installs. The two run_onchange
//      scripts then fight on every apply — install-apps puts it back, remove-bloat takes it away —
//      and neither ever reports an error.
//   2. A guard name in the data with no matching arm in the script. guard_ok fails closed, so the
//      group is silently never removed and the data lies about what the machine does.
//   3. A package deliberately kept (kleopatra, okular, LibreOffice) drifting into the list. dnf
//      would remove it without complaint on the next apply.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_remove-bloat.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');
const removalsToml = fs.readFileSync(srcPath('.chezmoidata', 'removals.toml'), 'utf8');
const packagesToml = fs.readFileSync(srcPath('.chezmoidata', 'packages.toml'), 'utf8');

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// --source pins the render to THIS checkout, so a branch is not tested against main's data.
const render = () => renderTemplate(body, { source: srcPath() });

// Gated to a personal non-WSL workstation, so it renders empty on a server/minimal profile, on a
// work machine, and under WSL. Those hosts have nothing to assert against.
const rendersHere = () => process.platform === 'linux' && render().trim() !== '';

// Parse the rendered REMOVALS block back into records — this is exactly what the shell
// `while read` loop consumes, so asserting on it tests the real contract, not the template text.
function records() {
  const block = render().match(/REMOVALS='\n([\s\S]*?)\n'/);
  assert.ok(block, 'REMOVALS block must render');
  return block[1].split('\n').filter(Boolean).map((line) => {
    const cols = line.split('|');
    const [name, guard, pkgs] = cols;
    return { name, guard, packages: pkgs.split(/\s+/).filter(Boolean), fields: cols.length };
  });
}

const allPackages = () => records().flatMap((r) => r.packages);

// Packages this machine keeps on purpose. Each is either load-bearing (a filesystem checker for a
// partition that is actually mounted) or the only thing on the box that does its job. LibreOffice
// is here because it was explicitly excluded from the removal set when this list was agreed.
const MUST_KEEP = [
  'kleopatra',            // GPG/smartcard GUI; this machine authenticates with a YubiKey
  'okular',               // the only PDF viewer
  'gwenview',             // the only image viewer
  'kcalc',                // the only calculator
  'dosfstools',           // fsck for the vfat EFI partition
  'btrfs-progs',          // root filesystem
  'e2fsprogs',            // /boot
  'ibus',                 // kept for emoji/compose even though the CJK engines go
  'ibus-typing-booster',
  'sane-backends',        // a Tier 3 judgement call, deliberately not encoded
  'cups',
  'avahi',
];

test('script is gated to a personal, non-WSL Linux workstation', { skip }, () => {
  // The linux/workstation/non-WSL checks themselves now live in the shared is-desktop-linux
  // template (home/.chezmoitemplates/is-desktop-linux), reused by every desktop-only script.
  // `not .work` stays here: it is this script's alone, since no other desktop-only script
  // cares whether the machine is a work one.
  assert.match(body, /includeTemplate "is-desktop-linux"/);
  assert.match(body, /not \.work/, 'the work machine package set is not this repo to trim');
  const gate = fs.readFileSync(srcPath('.chezmoitemplates', 'is-desktop-linux'), 'utf8');
  assert.match(gate, /eq \.chezmoi\.os "linux"/);
  assert.match(gate, /eq \.profile "workstation"/);
  assert.match(gate, /includeTemplate "is-wsl"/,
    'WSL has no desktop of its own and must be excluded');
  if (process.platform !== 'linux') {
    assert.strictEqual(render().trim(), '', 'script must render empty off Linux');
  }
});

test('removal is Fedora-only at runtime', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  assert.match(render(), /\[ "\$PM" != dnf \]/,
    'every name in removals.toml is an rpm name; apt machines must bail out');
});

test('every rendered record has all three columns and a name', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const recs = records();
  assert.ok(recs.length > 0, 'at least one removal group must render');
  for (const r of recs) {
    assert.strictEqual(r.fields, 3, `record for ${r.name} must have 3 columns`);
    assert.ok(r.name.trim(), 'every record must carry a name');
    assert.ok(r.packages.length > 0, `${r.name} must list at least one package`);
  }
});

// Failure mode 2: a guard the script has no arm for fails closed, so the group is never removed
// and nobody finds out.
test('every guard used in the data is implemented in the script', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const arms = new Set(
    [...render().matchAll(/^\s{4}([a-z-]+)\)$/gm)].map((m) => m[1]),
  );
  for (const r of records()) {
    if (!r.guard) continue;
    assert.ok(arms.has(r.guard),
      `group "${r.name}" declares guard '${r.guard}' but guard_ok has no arm for it`);
  }
});

// Failure mode 3.
test('packages kept on purpose never appear in the removal list', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const removing = new Set(allPackages());
  for (const keep of MUST_KEEP) {
    assert.ok(!removing.has(keep), `${keep} is kept on purpose but is queued for removal`);
  }
  for (const p of removing) {
    assert.ok(!/^libreoffice/.test(p),
      `LibreOffice was explicitly excluded from the removal set, but ${p} is listed`);
  }
});

// Failure mode 1: the two run_onchange scripts would undo each other on every apply, forever.
test('nothing installed by packages.toml is also removed', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const installs = new Set(
    [...packagesToml.matchAll(/^dnf\s*=\s*"([^"]+)"/gm)].map((m) => m[1]),
  );
  assert.ok(installs.size > 0, 'sanity: packages.toml must declare some dnf packages');
  for (const p of allPackages()) {
    assert.ok(!installs.has(p),
      `${p} is installed by packages.toml and removed by removals.toml — the two scripts will fight`);
  }
});

test('no package is listed in two removal groups', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const seen = new Map();
  for (const r of records()) {
    for (const p of r.packages) {
      assert.ok(!seen.has(p), `${p} appears in both "${seen.get(p)}" and "${r.name}"`);
      seen.set(p, r.name);
    }
  }
});

// The list outlives the person who wrote it; an entry with no stated reason is one nobody can
// safely audit later.
test('every removal group explains itself', () => {
  const groups = removalsToml.split(/^\[\[removals\]\]$/m).slice(1);
  assert.ok(groups.length > 0, 'removals.toml must declare groups');
  for (const g of groups) {
    const name = g.match(/^name\s*=\s*"([^"]+)"/m);
    assert.ok(name, 'every removal group needs a name');
    assert.match(g, /^why\s*=/m, `group "${name[1]}" must say why the machine doesn't need it`);
  }
});

// Unmarking is what stops `dnf system-upgrade` restoring kmail and kmahjongg at the next Fedora
// release. anaconda-tools must stay marked: most of its members (grub2, btrfs-progs, efibootmgr)
// are load-bearing and stay installed.
test('group unmarking covers the trimmed groups but spares anaconda-tools', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const line = render().match(/^for g in (.+); do$/m);
  assert.ok(line, 'the unmark loop must render a group list');
  const groups = line[1].split(/\s+/).filter(Boolean);
  for (const expected of ['kde-pim', 'kde-apps', 'kde-media', 'input-methods']) {
    assert.ok(groups.includes(expected), `${expected} must be unmarked or upgrades restore it`);
  }
  assert.ok(!groups.includes('anaconda-tools'),
    'anaconda-tools holds grub2/btrfs-progs/efibootmgr and must stay marked');
  assert.match(render(), /--no-packages/,
    'unmarking must not touch packages, or the deliberately-kept members go too');
});

// The incident this whole mechanism exists for: on its first run the script removed 260 packages
// when 52 were named. mdadm looked safe (no MD arrays) but libblockdev-mdraid requires it and
// udisks2 requires libblockdev-mdraid, so removable-media mounting went with it. gssproxy took
// nfs-utils and rpcbind. Both must stay out of the list permanently.
test('packages that caused the 260-package cascade are not in the removal list', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const removing = new Set(allPackages());
  assert.ok(!removing.has('mdadm'),
    'mdadm is load-bearing: libblockdev-mdraid requires it and udisks2 requires that');
  assert.ok(!removing.has('gssproxy'),
    'gssproxy removal takes nfs-utils and rpcbind with it');
});

// A protect list that does not cover the things the write-up promised to keep is decoration.
test('the protect list covers the storage, GPG and desktop essentials', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const line = render().match(/^\s*PROTECT='(.+)'$/m);
  assert.ok(line, 'the protect list must render into the script');
  const protectedPkgs = new Set(line[1].split(/\s+/).filter(Boolean));
  for (const p of [
    'udisks2', 'mdadm', 'libblockdev',            // removable media chain
    'gnupg2-scdaemon', 'gnupg2-smime', 'kleopatra', // YubiKey GPG chain
    'nfs-utils', 'rpcbind',                        // homelab NFS
    'tmux',                                        // anaconda pulled it; stock-PATH callers need it
    'dosfstools', 'btrfs-progs', 'e2fsprogs',      // mounted filesystems
    'plasma-workspace', 'kwin', 'okular', 'gwenview', 'kcalc',
    'ibus', 'libreoffice-core',
  ]) {
    assert.ok(protectedPkgs.has(p), `${p} must be protected from the dependency cascade`);
  }
});

test('protected packages are never also queued for removal', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const line = render().match(/^\s*PROTECT='(.+)'$/m);
  const protectedPkgs = new Set(line[1].split(/\s+/).filter(Boolean));
  for (const p of allPackages()) {
    assert.ok(!protectedPkgs.has(p), `${p} is both protected and queued for removal`);
  }
});

// Knowing a package is unused says nothing about what leaves alongside it. Only a resolved
// transaction answers that, so the resolve must happen and must be able to stop the run.
test('the cascade is resolved and can abort the run before anything changes', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const out = render();
  assert.match(out, /dnf remove --assumeno \$QUEUE/,
    'the transaction must be resolved read-only before it is committed');
  assert.match(out, /REFUSING to remove/, 'a protected hit must abort, not warn');

  // The abort has to come before the destructive steps, or it fires after livesys is disabled
  // and Akonadi is stopped.
  const abortAt = out.indexOf('REFUSING to remove');
  const realRemove = out.indexOf('sudo dnf remove -y $QUEUE');
  const stopsAt = out.indexOf('akonadictl stop');
  assert.ok(abortAt > 0 && abortAt < realRemove, 'the guard must precede the real removal');
  assert.ok(abortAt < stopsAt, 'the guard must precede stopping services');
});

test('the removal runs as one transaction after a sudo check', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const out = render();
  assert.match(out, /have_sudo/, 'must confirm sudo before starting a destructive transaction');
  assert.match(out, /sudo dnf remove -y \$QUEUE/,
    'one transaction so the dependency cascade is resolved once and reviewed once');
  assert.match(out, /exit 1/, 'a failed removal must not be recorded as success');
});

// Akonadi's datadir is only orphaned once the agents are gone; deleting it while KDE PIM is
// installed by hand would destroy a live mail store.
test('the Akonadi store is only cleared once the agents are absent', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  assert.match(render(), /rpm -q kdepim-runtime[\s\S]{0,160}?\.local\/share\/akonadi/,
    'the rm must be conditioned on kdepim-runtime no longer being installed');
});

// The flip-flop trap: kleopatra requires akonadi-mime, which requires akonadi-server. Removing
// the server takes the GPG/YubiKey GUI with it, and reinstalling kleopatra pulls the server back
// — so the next apply removes it again, on every apply, forever. The daemon is D-Bus activated
// and idle without the agents, so leaving it installed costs nothing.
test('akonadi-server is left installed so kleopatra survives', { skip }, (t) => {
  if (!rendersHere()) return t.skip('renders empty on this host');
  const removing = new Set(allPackages());
  assert.ok(!removing.has('akonadi-server'),
    'removing akonadi-server takes kleopatra with it and flip-flops on every apply');
  assert.ok(removing.has('kdepim-runtime'),
    'kdepim-runtime ships the agent fleet and is what actually needs to go');
});
