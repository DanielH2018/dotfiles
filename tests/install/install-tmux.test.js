const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');

const { shConst } = require('../lib/sh-const');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_install-tmux.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

// The pinned version, read from the script rather than restated. The idempotence test below
// stubs a local tmux AT this version to make the script take its already-current branch, so a
// stale copy here would not go red -- it would silently exercise the upgrade path instead.
const TMUX_VERSION = shConst(SRC, 'TMUX_VERSION');

// This test renders a chezmoi template; skip cleanly where the binary isn't installed
// (minimal CI / sandbox) rather than failing with a spurious spawn ENOENT.
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

// 1. The script is gated to Linux: off Linux it renders to nothing (so `chezmoi apply` never
//    runs it there); on Linux + non-minimal it renders the builder. A minimal profile also
//    renders empty, so on Linux only assert the shape when something rendered.
test('script is gated to Linux', { skip }, () => {
  const rendered = renderTemplate(body);
  if (process.platform !== 'linux') {
    assert.strictEqual(rendered.trim(), '', 'script must render empty off Linux');
  } else if (rendered.trim() !== '') {
    assert.ok(rendered.includes(`TMUX_VERSION=${TMUX_VERSION}`), 'Linux render carries the builder');
  }
});

// 2. The version stays written out HERE, deliberately, and in exactly one place. Bumping the
//    pin is a config decision, so it should turn one test red and get looked at -- the same
//    reason dns.test.js writes out 10.0.0.243. What must not be restated is the STUB the
//    build cases below build from it, which is where a stale copy went green testing the
//    wrong branch; that one derives.
test('the pinned tmux version', () => {
  assert.strictEqual(TMUX_VERSION, '3.7b');
});

// 3. The profile half of the gate (the os half is test 1): a minimal profile renders nothing.
test('a minimal profile renders no builder', { skip }, () => {
  assert.strictEqual(renderTemplate(body, { profile: 'minimal' }).trim(), '');
  if (process.platform === 'linux') {
    assert.notStrictEqual(renderTemplate(body, { profile: 'workstation' }).trim(), '');
  }
});

// Drive the rendered builder on a HOME with no tmux. Every command that would reach the
// package manager, sudo, or the network is a stub on PATH that logs its argv. The env is built
// from scratch rather than spread from process.env: linux-install.sh honours an inherited
// BIN_DIR, and real sudo can succeed from a cached timestamp and run a real apt-get.
//
// dpkg reports every package missing, so the build deps always need installing. `sudoOk`
// decides whether `sudo -v` succeeds. curl serves a fake release tarball whose configure
// records --prefix, and the make stub installs a tmux reporting the pinned version there.
function build(t, { sudoOk }) {
  const root = scratch(os.tmpdir(), 'tmux-build-', t);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);

  // The release tarball unpacks to tmux-<version>/, which the shell assembles. Spelling that
  // directory with fs.* would put TMUX_VERSION (read from the repo file) in an fs write path,
  // which tests/sandbox/sandbox-escape.test.js reads as a write into the checkout.
  fs.writeFileSync(path.join(root, 'configure'),
    '#!/bin/sh\nfor a in "$@"; do case "$a" in --prefix=*) printf %s "${a#--prefix=}" > .prefix ;; esac; done\n',
    { mode: 0o755 });
  const tarball = path.join(root, 'tmux.tar.gz');
  execFileSync('sh', ['-c',
    'mkdir -p "$1/tarball/tmux-$2" && cp "$1/configure" "$1/tarball/tmux-$2/" && tar czf "$1/tmux.tar.gz" -C "$1/tarball" "tmux-$2"',
    'sh', root, TMUX_VERSION]);

  const stub = (name, text) => fs.writeFileSync(path.join(bin, name),
    `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "${log}"\n${text}\n`, { mode: 0o755 });
  stub('dpkg', 'exit 1');
  stub('apt-get', 'exit 0');
  stub('sudo', `[ "$1" = -v ] && exit ${sudoOk ? 0 : 1}\nexec "$@"`);
  stub('curl', `while [ $# -gt 0 ]; do [ "$1" = -o ] && cp "${tarball}" "$2"; shift; done`);
  stub('make', `[ "$1" = install ] || exit 0
p="$(cat .prefix)"; mkdir -p "$p/bin"
printf '#!/bin/sh\\necho "tmux ${TMUX_VERSION}"\\n' > "$p/bin/tmux"; chmod +x "$p/bin/tmux"`);

  const scriptFile = path.join(root, 'render.sh');
  fs.writeFileSync(scriptFile, renderTemplate(body, { profile: 'workstation' }));
  const res = { status: 0, out: '' };
  try {
    res.out = execFileSync('sh', [scriptFile], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    res.status = e.status;
    res.out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  res.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  res.tmux = path.join(home, '.local', 'bin', 'tmux');
  return res;
}

const linuxSkip = skip || (process.platform !== 'linux' && 'the builder renders only on Linux');

// 4. Without sudo the build deps cannot be installed, so the run defers: it names what is
//    missing and exits 1 (chezmoi retries next apply) without fetching or building anything.
test('a sudo-less run defers the build deps and builds nothing', { skip: linuxSkip }, (t) => {
  const { status, out, calls, tmux } = build(t, { sudoOk: false });
  assert.strictEqual(status, 1, 'a deferred run must fail so the next apply retries it');
  assert.match(out, /libevent-dev/);
  assert.match(out, /bison/);
  assert.doesNotMatch(calls, /^curl /m, 'nothing may be fetched before the deps are in');
  assert.doesNotMatch(calls, /^apt-get install/m);
  assert.ok(!fs.existsSync(tmux));
});

// 5. With sudo it installs the deps, fetches the pinned release tarball, and builds it into
//    ~/.local, where ~/.local/bin/tmux shadows the distro one.
test('with sudo it installs the deps and builds the pinned release into ~/.local', { skip: linuxSkip }, (t) => {
  const { status, out, calls, tmux } = build(t, { sudoOk: true });
  assert.strictEqual(status, 0, out);
  assert.match(calls, /^apt-get install -y .*libevent-dev.*bison/m);
  assert.match(calls,
    new RegExp(`^curl .*https://github\\.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}\\.tar\\.gz`, 'm'));
  assert.strictEqual(execFileSync(tmux, ['-V'], { encoding: 'utf8' }).trim(), `tmux ${TMUX_VERSION}`);
});

// 6. Idempotence: an already-current ~/.local/bin/tmux must short-circuit before any apt/build,
//    so `chezmoi apply` on an up-to-date host is a no-op. Drive the rendered script with a
//    HOME whose .local/bin/tmux reports the target version and assert it skips at exit 0.
test('idempotence: current local tmux skips the rebuild', { skip }, () => {
  const rendered = renderTemplate(body);
  if (process.platform === 'linux' && rendered.trim() !== '') {
    const home = scratch(os.tmpdir(), 'tmux-inst-');
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "tmux ${TMUX_VERSION}"\n`, { mode: 0o755 });
    const scriptFile = path.join(home, 'render.sh');
    fs.writeFileSync(scriptFile, rendered);
    // Merge stderr (where the script logs) into stdout so the skip message is captured.
    const out = execFileSync('sh', ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1`], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.match(out, /skipping build/, 'a current local tmux must skip the rebuild');
  }
});

