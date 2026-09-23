// The Linux CLI-tools installer was apt-only until Fedora showed up. Everything below guards the
// distro split: one rendered script has to work on apt and dnf, and the failure mode that
// motivated these assertions is silent — on the wrong distro `dpkg -s` simply errors, every
// package reads as missing, and the script exits 1 on every single `chezmoi apply` forever while
// dotfiles still deploy and the machine looks fine.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_install-cli-tools.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');
const TOOLS = srcPath('.chezmoidata', 'tools.toml');
const tools = fs.readFileSync(TOOLS, 'utf8');

// Renders a chezmoi template; skip cleanly where the binary isn't installed (minimal CI /
// sandbox) rather than failing with a spurious spawn ENOENT.
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// The memo lives in lib/render.js now, along with the correction this file's comment used to
// carry alone: it buys speed, not freedom from the flake it was once credited with fixing.
//
// --source pins that render to THIS checkout. Without it chezmoi resolves .chezmoidata and
// .chezmoitemplates from ~/.local/share/chezmoi, so a branch or worktree would silently be tested
// against main's data — and the shared linux-install.sh this script now includes would resolve to
// whatever main happens to carry, or not at all.
// Pinned to the workstation profile. The template itself renders on a server profile, but the
// podman-docker shim inside it sits behind is-desktop-linux (asserted by 'the podman-docker shim
// is gated away from WSL' below), so on a server host that block vanishes and the shim cases fail
// while rendersHere() still reports true. See the `profile` note in tests/lib/render.js.
const render = () => renderTemplate(body, { source: srcPath(), profile: 'workstation' });
// Nothing to assert against off Linux (or on a minimal profile): the template renders empty.
const rendersHere = () => process.platform === 'linux' && render().trim() !== '';
// One term tighter, for the podman-docker cases. The shim sits behind is-desktop-linux, which
// excludes WSL as well — and unlike `profile` above, that term cannot be pinned from a config
// file, because is-wsl reads the real host. So on a WSL box the surrounding script renders fine
// and rendersHere() stays true while the shim block alone vanishes: the shim cases then ran
// against a script that never contained the code they assert on, two failing outright and two
// passing vacuously.
const shimRendersHere = () => rendersHere() && render().includes('podman-docker');

// Real binaries the script may reach for. Deliberately excludes dpkg/apt-get/dnf/rpm — those are
// only ever supplied as stubs, so PATH alone decides which distro the script believes it is on.
// The first fixture PATH was `${stubDir}:/usr/bin:/bin`, which let the real dnf leak in and made
// the unsupported-distro case silently test the dnf path instead.
const PASSTHROUGH = ['sh', 'mkdir', 'cat', 'rm', 'ln', 'sed', 'head', 'mktemp', 'install', 'find', 'tar', 'gpg', 'tee'];

// Drive the rendered script against a synthetic PATH: `stubs` maps command name -> shell body,
// and every passthrough binary above is symlinked in beside them. No real package manager, sudo
// or network is reachable. Returns the merged stdout+stderr plus the throwaway HOME.
// `opts.home` reuses a previous run's HOME, so a case can start from the .versions state an
// earlier run left. `opts.env` adds to the child environment, which is how INSTALL_LATEST — the
// one route left to the releases/latest redirect — is exercised below.
function runWithStubs(stubs, opts = {}) {
  const home = opts.home || scratch(os.tmpdir(), 'cli-tools-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    // A reused HOME already has these; relinking would throw EEXIST.
    const link = path.join(binDir, name);
    if (real && !fs.existsSync(link)) fs.symlinkSync(real, link);
  }
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, render());
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1 || true`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, ...opts.env },
  });
  return { out, home };
}

// An arch the installer has no asset names for, so every release-binary download is skipped and
// the test never touches the network.
const NO_ARCH = '[ "$1" = "-m" ] && echo unsupported-arch || echo Linux';

// A tripwire for the original bug: `dpkg -s` against Fedora's rpm database. It can be stubbed
// WITHOUT flipping detection to apt, because the apt branch requires apt-get too — leave apt-get
// off PATH and dnf wins while dpkg calls are still caught. Stubbing both would silently make
// every "dnf host" test exercise the apt path instead, which is exactly what it did at first.
const DPKG_TRIPWIRE = 'echo "DPKG WAS CALLED" >&2; exit 1';
// sudo -v must succeed (credentials cached) while `sudo <cmd>` runs the stubbed command.
const SUDO_OK = '[ "$1" = "-v" ] && exit 0; exec "$@"';

// 1. Gating is unchanged: off Linux the script renders to nothing, so `chezmoi apply` never runs
//    it there; a minimal profile also renders empty.
test('script is gated to Linux', { skip }, () => {
  const rendered = render();
  if (process.platform !== 'linux') {
    assert.strictEqual(rendered.trim(), '', 'script must render empty off Linux');
  } else if (rendered.trim() !== '') {
    assert.match(rendered, /^TAG=install-cli-tools$/m, 'Linux render carries the installer');
  }
});

// 2. Both package lists are rendered into the script, and each one is non-empty. A dnf list that
//    rendered empty would make every Fedora check trivially pass and install nothing at all —
//    the quiet failure, not the loud one.
test('both apt and dnf package lists render non-empty', { skip }, () => {
  if (!rendersHere()) return;
  const rendered = render();
  const apt = /PKGS_APT="([^"]*)"/.exec(rendered);
  const dnf = /PKGS_DNF="([^"]*)"/.exec(rendered);
  assert.ok(apt && apt[1].trim(), 'PKGS_APT must render a non-empty list');
  assert.ok(dnf && dnf[1].trim(), 'PKGS_DNF must render a non-empty list');
  // zsh is the load-bearing one: set-default-shell chsh's to it, so losing it from either list
  // leaves a machine on bash with no visible error.
  assert.match(apt[1], /\bzsh\b/, 'apt list must carry zsh');
  assert.match(dnf[1], /\bzsh\b/, 'dnf list must carry zsh');
  assert.match(dnf[1], /ShellCheck/, "dnf list must use Fedora's capitalised ShellCheck");
  assert.match(dnf[1], /\blua\b/, 'dnf list must use unversioned lua, not Debian lua5.4');
  assert.doesNotMatch(dnf[1], /lua5\.4/, 'Debian lua5.4 must not leak into the dnf list');
});

// 3. tools.toml stays the single source of truth: every tool carries a dnf field, so a new entry
//    can't be added with apt coverage and no Fedora answer.
test('every tools.toml entry declares a dnf field', () => {
  const blocks = tools.split('[[tools]]').slice(1);
  assert.ok(blocks.length > 10, 'sanity: parsed the tool blocks');
  for (const b of blocks) {
    const name = /name = "([^"]*)"/.exec(b)?.[1] ?? '(unnamed)';
    assert.match(b, /^\s*dnf = "/m, `tool ${name} is missing a dnf field`);
  }
});

// 4. On a dnf host the script must probe rpm, never dpkg. Stub a Fedora-looking box where every
//    package is already installed and assert it converges (no "still missing", no retry demand).
test('dnf host with everything present converges', { skip }, () => {
  if (!rendersHere()) return;
  const { out } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 0',                       // every `rpm -q` hits
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: 'exit 1',                      // no network: release installs log and move on
    uname: NO_ARCH,
    unzip: 'exit 0',
  });
  assert.doesNotMatch(out, /DPKG WAS CALLED/, 'a dnf host must never shell out to dpkg');
  assert.doesNotMatch(out, /apt-get/, 'a dnf host must never reach for apt-get');
  assert.doesNotMatch(out, /packages still missing/, 'all packages present must converge');
  assert.doesNotMatch(out, /re-run 'chezmoi apply'/, 'converged run must not ask for a re-run');
});

// 5. The gh + WezTerm branches are where the apt path hides its Debian-only machinery (keyrings,
//    sources.list, dpkg --print-architecture). Force both to look absent on a dnf host so those
//    branches actually execute, and assert the Fedora route is taken instead.
test('dnf host installs gh and WezTerm without Debian machinery', { skip }, () => {
  if (!rendersHere()) return;
  const { out, home } = runWithStubs({
    dnf: `echo "dnf $*" >> "$HOME/dnf.log"; exit 0`,
    rpm: 'case "$2" in gh|wezterm) exit 1 ;; *) exit 0 ;; esac',
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: 'echo "CURL WAS CALLED" >&2; exit 1',
    uname: NO_ARCH,
    unzip: 'exit 0',
  });
  // Read defensively: a bare ENOENT here says nothing about WHY the dnf branches never ran.
  // Surface the script's own output instead, which is what actually diagnoses it.
  const logPath = path.join(home, 'dnf.log');
  const dnfLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  assert.ok(dnfLog, `the dnf branches never invoked dnf; script output was:\n${out}`);
  assert.doesNotMatch(out, /DPKG WAS CALLED/, 'the gh/wezterm branches must not reach dpkg');
  assert.doesNotMatch(out, /apt-get/, 'the gh/wezterm branches must not reach apt-get');
  assert.doesNotMatch(out, /CURL WAS CALLED/, 'no keyring fetch belongs on the dnf path');
  assert.match(dnfLog, /copr enable wezfurlong\/wezterm-nightly/, 'WezTerm comes from the COPR on Fedora');
  assert.match(dnfLog, /install -y wezterm/, 'WezTerm must actually be installed after the COPR');
  assert.match(dnfLog, /install -y gh/, 'gh comes straight from the Fedora repo');
});

// 6. The inverse: a dnf host with packages genuinely absent must fail loudly so run_once does not
//    record success and the next apply retries.
test('dnf host with missing packages fails loudly', { skip }, () => {
  if (!rendersHere()) return;
  const { out } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 1',                       // nothing installed, and the install stub is a no-op
    sudo: 'exit 1',                      // sudo -v fails => defer
    curl: 'exit 1',
    uname: NO_ARCH,
  });
  assert.match(out, /packages still missing/, 'missing packages must be reported');
  assert.match(out, /re-run 'chezmoi apply'/, 'must tell the user how to retry');
});

// 7. An unrecognised distro must not fail forever over packages it cannot install: it warns once
//    and still converges, so the release binaries are the whole story there. This is the case the
//    leaky fixture PATH originally hid — with no package manager on PATH at all, PM must be empty.
test('unsupported distro warns once and converges', { skip }, () => {
  if (!rendersHere()) return;
  const { out } = runWithStubs({
    curl: 'exit 1',
    uname: NO_ARCH,
  });
  assert.match(out, /no supported package manager/, 'must say why the package phase was skipped');
  assert.doesNotMatch(out, /re-run 'chezmoi apply'/, 'must not demand a retry it can never satisfy');
  assert.doesNotMatch(out, /packages still missing/, 'there is no package list to be missing');
});

// 8. The podman-docker shim owns /usr/bin/docker, and so does the docker-ce that
//    wsl/install-docker-engine puts on a WSL box. Two packages, one path: apt's podman-docker
//    declares Conflicts: docker-ce and dnf refuses the file conflict outright. The desktop gate is
//    what keeps them apart, so assert both halves of that — the gate here, and the WSL installer
//    it is protecting — rather than trusting a comment to stay true.
test('the podman-docker shim is gated away from WSL', { skip }, () => {
  assert.match(body, /includeTemplate "is-desktop-linux"[\s\S]*podman-docker/,
    'the shim must sit inside the is-desktop-linux gate');
  const gate = fs.readFileSync(srcPath('.chezmoitemplates', 'is-desktop-linux'), 'utf8');
  assert.match(gate, /is-wsl/, 'is-desktop-linux must still exclude WSL');
  const wslDocker = srcPath('.chezmoiscripts', 'os-linux', 'wsl',
    'run_once_after_install-docker-engine.sh.tmpl');
  assert.ok(fs.existsSync(wslDocker), 'WSL still installs real docker-ce; the gate is load-bearing');
});

// 9. A Fedora workstation with no `docker` on PATH gets the shim.
test('dnf host without docker installs the podman-docker shim', { skip }, () => {
  if (!shimRendersHere()) return;
  const { out, home } = runWithStubs({
    dnf: `echo "dnf $*" >> "$HOME/dnf.log"; exit 0`,
    rpm: 'exit 0',
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: 'exit 1',
    uname: NO_ARCH,
    unzip: 'exit 0',
  });
  const logPath = path.join(home, 'dnf.log');
  const dnfLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  assert.match(dnfLog, /install -y podman-docker/,
    `the shim was never installed; script output was:\n${out}`);
});

// 10. …and a host that already has `docker` is left alone. Installing over a hand-installed
//     docker-ce is the failure this guard exists for, so it must hold even on a desktop.
test('an existing docker install is not fought over', { skip }, () => {
  if (!shimRendersHere()) return;
  const { out, home } = runWithStubs({
    dnf: `echo "dnf $*" >> "$HOME/dnf.log"; exit 0`,
    rpm: 'exit 0',
    sudo: SUDO_OK,
    dpkg: DPKG_TRIPWIRE,
    curl: 'exit 1',
    uname: NO_ARCH,
    unzip: 'exit 0',
    docker: 'exit 0',
  });
  const logPath = path.join(home, 'dnf.log');
  const dnfLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  assert.doesNotMatch(dnfLog, /podman-docker/,
    `podman-docker must not be installed when docker already exists; output was:\n${out}`);
});

// A sudo that records instead of executing. SUDO_OK's `exec "$@"` would run the REAL install(1)
// from the passthrough set against the REAL /etc, which is not something a test gets to do.
const SUDO_LOG = '[ "$1" = "-v" ] && exit 0; echo "sudo $*" >> "$HOME/sudo.log"; exit 0';
const readLog = (home, name) => {
  const p = path.join(home, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

// 11. The bug this guards: the install branch stops once `docker` is on PATH, so anything that
//     lives inside it never runs again on a machine that installed the shim on an earlier pass.
//     The marker and socket steps are therefore keyed on the package being installed instead.
//     Prove it with docker already present — the install branch is skipped, the follow-up is not.
test('the shim follow-up runs even when docker is already installed', { skip }, () => {
  if (!shimRendersHere()) return;
  const { out, home } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 0',                       // podman-docker reads as installed
    sudo: SUDO_LOG,
    dpkg: DPKG_TRIPWIRE,
    curl: 'exit 1',
    uname: NO_ARCH,
    unzip: 'exit 0',
    docker: 'exit 0',                    // the install branch short-circuits here
    systemctl: `echo "systemctl $*" >> "$HOME/systemctl.log"; exit 0`,
  });
  assert.match(readLog(home, 'systemctl.log'), /--user enable --now podman\.socket/,
    `the follow-up never ran with docker present; script output was:\n${out}`);
});

// 12. podman-docker does not ship /etc/containers/nodocker — its own banner asks you to create it
//     — so the installer places it. Asserted against the rendered text rather than by running it:
//     the step is a no-op once the file exists, so a runtime check would start skipping on every
//     machine that has applied this change and quietly stop guarding anything.
test('the nodocker marker is created inside the package-keyed block', { skip }, () => {
  if (!shimRendersHere()) return;
  const rendered = render();
  const installBranch = rendered.indexOf('if ! command -v docker');
  const keyedBlock = rendered.indexOf('pkg_installed podman-docker; then');
  const marker = rendered.search(/sudo install -m 644 \/dev\/null \/etc\/containers\/nodocker/);
  assert.ok(installBranch > 0, 'sanity: found the install branch');
  assert.ok(keyedBlock > installBranch, 'sanity: found the package-keyed block after it');
  assert.ok(marker > keyedBlock,
    'the marker must be created in the package-keyed block; inside the install branch it is ' +
    'unreachable on any machine that already has docker on PATH');
});

// 13. A headless, non-lingering box has no user systemd bus. Enabling there is a guaranteed error,
//     so the show-environment probe must gate it — the same contract enable-reap-timer relies on.
test('the podman socket is left alone without a user systemd session', { skip }, () => {
  if (!rendersHere()) return;
  const { home } = runWithStubs({
    dnf: 'exit 0',
    rpm: 'exit 0',
    sudo: SUDO_LOG,
    dpkg: DPKG_TRIPWIRE,
    curl: 'exit 1',
    uname: NO_ARCH,
    unzip: 'exit 0',
    docker: 'exit 0',
    // No user bus: the probe fails, everything else would succeed if it were reached.
    systemctl: `echo "systemctl $*" >> "$HOME/systemctl.log"; [ "$2" = show-environment ] && exit 1; exit 0`,
  });
  assert.doesNotMatch(readLog(home, 'systemctl.log'), /enable/,
    'enabling podman.socket without a user bus only produces an error');
});


// --- Pinned release tags ---------------------------------------------------------------------
//
// Every release binary this script installs used to have its tag resolved at apply time, through
// the GitHub releases/latest redirect. The install DATE therefore decided which build a machine
// got: two machines from one commit, or one machine on two dates, disagreed. The tags now come
// from .chezmoidata/tools.toml, and the three tests below are the halves that keep that true —
// the pins are present, nothing reaches for latest behind them, and the deliberate override
// still works.

// tools.toml's [releases] table, as {name: tag}. Parsed from the `[releases]` section alone so
// the `tag = ` inside an app entry elsewhere in the file cannot be mistaken for one of these.
function pinnedReleases() {
  const section = tools.split(/^\[releases\]$/m)[1] || '';
  const body = section.split(/^\[/m)[0];
  const out = {};
  for (const m of body.matchAll(/^(\S+) = \{ repo = "([^"]+)", tag = "([^"]+)" \}$/gm)) {
    out[m[1]] = { repo: m[2], tag: m[3] };
  }
  return out;
}

// Accept: the render carries, for each `install_release` line, the repo and tag tools.toml
// records. What this catches is a version written into the script instead of read from the data
// file — the shape the pins replaced, and the one a hand-edit reintroduces. It does NOT catch a
// wrong version, because the render and the data file share one source: a bump moves both
// together, which is the point of the data file.
//
// The frozenset is the non-vacuity guard. A regex census of the render returns an empty set the
// moment the call spelling changes, and an assertion over nothing passes — so name the tools the
// census MUST find rather than only counting them.
const MUST_BE_PINNED = ['eza', 'fastfetch', 'curlie', 'sd', 'starship', 'fzf', 'zoxide', 'rg', 'gron'];

test('every release install carries its pinned tag', { skip }, () => {
  if (!rendersHere()) return;
  const pins = pinnedReleases();
  const seen = new Set();
  for (const m of render().matchAll(/^\s*(?:\|\| )?install_release (\S+)\s+(\S+)\s+'([^']*)'/gm)) {
    const [, bin, repo, tag] = m;
    assert.ok(pins[bin], `install_release ${bin} has no [releases] entry in tools.toml`);
    assert.strictEqual(repo, pins[bin].repo, `${bin} installs from a repo tools.toml does not name`);
    assert.strictEqual(tag, pins[bin].tag, `${bin} installs a tag tools.toml does not name`);
    seen.add(bin);
  }
  for (const bin of MUST_BE_PINNED) {
    assert.ok(seen.has(bin), `the census found no pinned install_release line for ${bin}`);
  }
  // nvim and yazi take the same pins through pinned_tag, because their helpers want the tag as
  // an argument rather than resolving it.
  for (const bin of ['nvim', 'yazi']) {
    assert.ok(render().includes(`'${pins[bin].tag}'`), `${bin} must install the tools.toml tag`);
  }
});

// Reject: the release-asset URLs must not route back to whatever is current. A pinned tag
// alongside a `releases/latest/download/` asset path is the worst of both — the machine records
// the pin and runs today's build, so the version it reports is wrong rather than merely stale.
test('no release asset URL resolves to latest', { skip }, () => {
  if (!rendersHere()) return;
  for (const line of render().split('\n')) {
    if (!/^\s*(?:\|\| )?install_release/.test(line)) continue;
    assert.doesNotMatch(line, /releases\/latest\/download/,
      `a pinned install must not fetch from the latest asset path: ${line.trim()}`);
  }
});

// The way out, and the way back in. `latest_tag` survives for one caller — `pinned_tag` under
// INSTALL_LATEST=1 — so an operator can ask what a bump would bring without editing tools.toml.
// The pair is what proves the override is wired: only the HEAD probe against the redirect
// (`curl -fsSLI`) distinguishes the two runs, since both then fetch an asset.
const PIN_STUBS = () => ({
  uname: '[ "$1" = "-m" ] && echo x86_64 || echo Linux',
  curl: 'echo "curl $*" >> "$HOME/curl.log"; exit 1',
  unzip: 'exit 0',
  sudo: SUDO_OK,
});

test('a plain run resolves no tag upstream, INSTALL_LATEST=1 does', { skip }, () => {
  if (!rendersHere()) return;
  const plain = runWithStubs(PIN_STUBS());
  assert.doesNotMatch(readLog(plain.home, 'curl.log'), /-fsSLI/,
    'a pinned run must not probe the releases/latest redirect');

  const latest = runWithStubs(PIN_STUBS(), { env: { INSTALL_LATEST: '1' } });
  assert.match(readLog(latest.home, 'curl.log'), /-fsSLI/,
    'INSTALL_LATEST=1 must resolve tags through the redirect');
});

// --- No script here runs on a clock ----------------------------------------------------------
//
// This installer was the only plain `run_` script in the tree that actually ran on apply, and it
// throttled itself with a wall-clock `.last-check` stamp. Whether an apply reached the network
// therefore depended on the date rather than on any committed input. Every script in this
// directory is now run_once_ or run_onchange_, so the committed tree is the whole trigger.
test('every os-linux script is run_once_ or run_onchange_', () => {
  const dir = path.dirname(SRC);
  const scripts = fs.readdirSync(dir).filter((f) => f.startsWith('run_'));
  assert.ok(scripts.length > 20, `sanity: found only ${scripts.length} scripts in ${dir}`);
  for (const f of scripts) {
    assert.match(f, /^run_(once|onchange)_/,
      `${f} runs on every apply, so something other than the committed tree decides when it acts`);
  }
});
