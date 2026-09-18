// Guards the one property that makes home/.chezmoitemplates/linux-install.sh safe to exercise:
// its install destinations must stay *overridable* from the environment.
//
// This is not a hypothetical. The module used to open with `BIN_DIR="$HOME/.local/bin"` — a plain
// assignment — so sourcing it silently overwrote whatever a caller had exported. A test harness
// that believed it had sandboxed itself by exporting BIN_DIR/VER_DIR/APP_DIR at a throwaway
// directory installed its fixtures straight into the real ~/.local/bin instead, replacing the
// live `yazi` and `ya` binaries with 27-byte stubs and stamping bogus tags into .versions. The
// damage was invisible until someone ran the tools. Nothing failed; the harness reported success.
//
// The `: "${VAR:=default}"` form fixes that, but nothing stopped it regressing — hence this file.
//
// Every case below redirects HOME as well as the overrides, which is load-bearing rather than
// belt-and-braces: if the module regresses to plain assignment it recomputes `$HOME/.local/bin`,
// so a test that pinned only the overrides would install into the tester's real home *while
// reporting a failure*. The guard would inflict the exact damage it exists to catch. With HOME
// pointed at the sandbox too, even a fully reverted module can only write inside the temp dir.
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');

const SOURCE = path.join(__dirname, '..', '..', 'home');
const LIB = path.join(SOURCE, '.chezmoitemplates', 'linux-install.sh');
const source = fs.readFileSync(LIB, 'utf8');

// Every destination the module resolves at source time. APT_LIST_DIR/APT_KEYRING_DIR joined the
// list late: apt_repo_add wrote /etc/apt/... inline, so the apt half of the repo helpers could not
// be aimed at a throwaway directory the way the dnf half already could via REPO_DIR.
const DESTINATIONS = ['BIN_DIR', 'VER_DIR', 'APP_DIR', 'REPO_DIR', 'APT_LIST_DIR', 'APT_KEYRING_DIR'];
// The subset deriving from $HOME — the ones redirecting HOME alone is enough to contain. The rest
// are system paths that no amount of HOME juggling moves, which is why they need explicit overrides.
const HOME_DERIVED = ['BIN_DIR', 'VER_DIR', 'APP_DIR'];

// Skip cleanly where chezmoi isn't installed (minimal CI / sandbox) rather than failing with a
// spurious spawn ENOENT. --source pins the render to THIS checkout; without it chezmoi resolves
// .chezmoitemplates from ~/.local/share/chezmoi and a branch would be tested against main's copy.
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const render = () =>
  renderTemplate('{{ includeTemplate "linux-install.sh" . }}', { source: SOURCE });

const sandbox = () => scratch(os.tmpdir(), 'linux-install-lib-');

// Sources the rendered module under `env` and reports where it decided to write. sh, not bash:
// the module is inlined into `#!/bin/sh` scripts, so that is the interpreter that has to accept it.
const resolve = (env) => {
  const emit = DESTINATIONS.map((v) => `printf '%s\\n' "$${v}"`).join('\n');
  const out = execFileSync('sh', ['-c', `${render()}\n${emit}`], {
    encoding: 'utf8',
    // A deliberately minimal env: only PATH (the module probes for apt-get/dnf) plus what the
    // case under test sets. Anything inherited could mask a variable the module failed to honour.
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'ignore'], // the module narrates its package-manager choice on stderr
  });
  const lines = out.trim().split('\n');
  return Object.fromEntries(DESTINATIONS.map((v, i) => [v, lines[i]]));
};

test('exported install destinations survive sourcing the module', { skip }, () => {
  const root = sandbox();
  const want = Object.fromEntries(DESTINATIONS.map((v) => [v, path.join(root, v.toLowerCase())]));
  const got = resolve({ HOME: path.join(root, 'home'), ...want });

  for (const name of DESTINATIONS) {
    assert.strictEqual(got[name], want[name],
      `${name} was overwritten on sourcing — a harness cannot sandbox this module`);
  }

  // Sourcing has a side effect: `mkdir -p "$BIN_DIR" "$VER_DIR"` runs at the top level, before any
  // helper is called. Asserting on the directories rather than only the variables is what proves
  // the override reached the code that writes, not just the code that reports.
  assert.ok(fs.existsSync(want.BIN_DIR), 'BIN_DIR should have been created inside the sandbox');
  assert.ok(fs.existsSync(want.VER_DIR), 'VER_DIR should have been created inside the sandbox');
  assert.ok(!fs.existsSync(path.join(root, 'home', '.local', 'bin')),
    'the module fell back to $HOME despite an explicit override — this is the regression that stubbed yazi/ya');
});

test('with no overrides at all, every $HOME destination stays under $HOME', { skip }, () => {
  // The other half of the contract, and the sandboxing route the module recommends: a harness that
  // redirects HOME alone is contained, with no way to half-cover it by forgetting one variable.
  const root = sandbox();
  const got = resolve({ HOME: root });

  for (const name of HOME_DERIVED) {
    assert.ok(got[name].startsWith(`${root}/`),
      `${name} resolved to ${got[name]}, outside the redirected HOME`);
  }
  assert.strictEqual(got.VER_DIR, `${got.BIN_DIR}/.versions`, 'VER_DIR should follow BIN_DIR, not $HOME directly');
});

// apt_repo_add's idempotence guard. Stubs apt-get/dpkg onto the front of PATH so the module
// picks PM=apt on any host, and stubs curl/sudo to leave a marker: the guard holding means
// neither is ever reached, which is the only observable difference between "already configured"
// and "configured it again".
const aptRepoAdd = (root, preexisting) => {
  const bin = path.join(root, 'bin');
  const lists = path.join(root, 'lists');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(lists, { recursive: true });
  for (const name of ['apt-get', 'dpkg']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  for (const name of ['curl', 'sudo']) {
    fs.writeFileSync(path.join(bin, name),
      `#!/bin/sh\ntouch "${root}/reached-${name}"\nexit 1\n`, { mode: 0o755 });
  }
  if (preexisting) fs.writeFileSync(path.join(lists, preexisting), 'x\n');

  const call = "apt_repo_add github-cli https://example.invalid/key "
    + "'deb [signed-by=__KEYRING__] https://example.invalid stable main'";
  const r = spawnSync('sh', ['-c', `${render()}\n${call}\necho "rc=$?"`], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: path.join(root, 'home'),
      APT_LIST_DIR: lists,
      APT_KEYRING_DIR: path.join(root, 'keyrings'),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return {
    rc: /rc=(\d+)/.exec(r.stdout)?.[1],
    fetched: fs.existsSync(path.join(root, 'reached-curl'))
      || fs.existsSync(path.join(root, 'reached-sudo')),
    wroteList: fs.existsSync(path.join(lists, 'github-cli.list')),
  };
};

test('a deb822 .sources counts as already configured', { skip }, () => {
  // The daniel-box collision: ansible writes github-cli.sources and deletes the one-line
  // .list, so a guard watching only .list rewrote it and left apt with the repo twice.
  const r = aptRepoAdd(sandbox(), 'github-cli.sources');
  assert.strictEqual(r.rc, '0', 'should report success without configuring anything');
  assert.strictEqual(r.fetched, false, 'a repo already configured via deb822 must not be re-fetched');
  assert.strictEqual(r.wroteList, false, 'writing the .list back is what double-configures apt');
});

test('an existing one-line .list still short-circuits', { skip }, () => {
  const r = aptRepoAdd(sandbox(), 'github-cli.list');
  assert.strictEqual(r.rc, '0');
  assert.strictEqual(r.fetched, false);
});

test('with neither source file present it proceeds to fetch', { skip }, () => {
  // Guards the two cases above against passing vacuously — if the module returned early
  // regardless, they would still be green.
  const r = aptRepoAdd(sandbox(), null);
  assert.strictEqual(r.fetched, true, 'an unconfigured repo must still be fetched');
});

test('no destination is hardcoded past the override', { skip: false }, () => {
  // Catches what the behavioural cases cannot: a *new* destination added later in the plain form.
  // Two shapes count as the bug — an assignment rooted at $HOME (what stubbed yazi/ya) and one
  // rooted at a literal system directory (what kept apt_repo_add untestable). The `: "${VAR:=...}"`
  // form is what this is steering toward, and it starts with `:`, so it never matches.
  const offenders = source
    .split('\n')
    .map((line, i) => [i + 1, line.trim()])
    .filter(([, line]) => /^[A-Za-z_][A-Za-z0-9_]*="?(\$\{?HOME\b|\/(etc|usr|var|opt)\/)/.test(line));

  assert.deepStrictEqual(offenders, [],
    'use `: "${VAR:=<default>}"` so a caller can redirect it; plain assignment silently clobbers the caller');
});
