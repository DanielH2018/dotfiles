// Render + behavior coverage for the ~20 bootstrap scripts under home/.chezmoiscripts/.
//
// Part 1 (render sweep): every *.sh.tmpl is discovered dynamically (so a newly added script
// is covered automatically), rendered via `chezmoi execute-template --source <repo>` (the
// --source flag makes `include` directives resolve against this worktree), and the output is
// checked with `bash -n`. Every *.ps1.tmpl is rendered only (no pwsh on this machine).
//
// Part 2 (behavior): the riskiest scripts (chsh, sudo+/etc edits, sudo+systemctl, curl|sh,
// sudo+apt) are driven as RENDERED scripts under a PATH-shim sandbox. PATH is fully REPLACED (not merely
// prepended) with a temp dir of stub executables that log their argv to a file and exit
// 0/controllable -- so no real chsh/sudo/systemctl/getent call ever reaches the real system,
// regardless of which branch a test takes. Every mutating step in all three scripts is
// wrapped in `sudo`, and the sudo stub never execs the wrapped command, which is what makes
// this safe even for branches that would otherwise touch real system files.
//
// Offline. Skips cleanly if chezmoi or bash unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderFile } = require('../lib/render');
const { ptySkip } = require('../lib/pty');

const REPO = path.join(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO, 'home', '.chezmoiscripts');

let toolsOk = true;
try { execFileSync('chezmoi', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'chezmoi/bash unavailable';

// The os-linux/wsl/ scripts driven in Part 2 open with `{{ if includeTemplate "is-wsl" . }}`,
// so off WSL they render to an EMPTY string. The Part 2 behavior tests would then run an empty
// script and read exit 0 / an empty stub log -- failing on assertions about a script body that
// does not exist there, which is what the homelab (plain Ubuntu, same suite) hits. Gate them on
// os.release(), the same uname release chezmoi reads into .chezmoi.kernel.osrelease.
// Deliberately NOT gated on "did it render empty?" -- that would also silently skip on WSL if
// the guard itself broke, turning a real regression into a green run.
// Note this checks only the substring, while is-wsl also accepts the binfmt_misc WSLInterop
// mount. On a WSL kernel rebuilt without "microsoft" the template renders the script but this
// skips its tests -- the conservative direction (a skip, never a false failure), and the only
// one available here without reaching into /proc from the test process.
const onWsl = /microsoft/i.test(os.release());
const skipWsl = skip || (onWsl ? false : 'WSL-only script (renders empty off WSL)');

// The same argument one OS up, for the os-linux/ scripts driven in parts 2f-2h. dnf-speedups and
// setup-btrfs-snapshots open with `{{ if eq .chezmoi.os "linux" }}` and setup-bt-hid-recovery with
// `{{ if includeTemplate "is-desktop-linux" . }}`, so all three render to an EMPTY string on a Mac
// -- verified by rendering them: 0 bytes each. Their behavior tests then drove an empty script and
// read exit 0 with an empty stub log, which failed the ones asserting a write or a deferral and,
// worse, PASSED the ones asserting that nothing was written or that sudo was never probed. A
// vacuous pass is the failure mode this skip exists to remove, so the whole group is gated, not
// just the red half. Part 1b still renders past the guard for syntax, the same split the WSL
// scripts already use: guard bypassed for `bash -n`, behavior tests skipped off the target OS.
const skipLinux = skip || (process.platform === 'linux' ? false : 'Linux-only script (renders empty off Linux)');

// The same argument one guard narrower, for the 2i script. setup-inotify-limits opens with
// `{{ if and (eq .chezmoi.os "linux") (eq .profile "workstation") }}`, so skipLinux is not enough:
// on daniel-server (Linux, profile=server) it renders EMPTY while skipLinux stays false, and the
// group lands in exactly the vacuous-pass state the note above exists to prevent -- the write test
// fails while "converged run never probes sudo" and "sudo unavailable writes nothing" pass against
// a script that does not exist there.
//
// Reads the profile chezmoi itself resolves rather than testing whether the render came out empty.
// An empty-render probe would also skip silently if the guard itself broke, which is the same trap
// the WSL group calls out -- this asks the question the guard asks, so a broken guard still fails.
let profile = null;
try {
  profile = JSON.parse(execFileSync('chezmoi', ['data', '--source', path.join(REPO, 'home')], { encoding: 'utf8' })).profile;
} catch { /* leave null; handled below */ }
const skipWorkstation = skipLinux
  || (profile === 'workstation' ? false : `workstation-only script (profile=${profile ?? 'unreadable'})`);

// One term narrower still, for the scripts gated on is-desktop-linux rather than on the profile
// alone. That template is linux AND workstation AND *not* WSL, and skipWorkstation covers only the
// first two: on a WSL box with profile=workstation it stays false while the template renders to
// zero bytes, so the bt-hid group asserted against an empty string and failed on every WSL host
// for a script that correctly never deploys there.
//
// Reuses the os.release() probe above rather than testing for an empty render, for the reason the
// skipWorkstation note gives: this asks the same question the guard asks, so a guard that breaks
// still fails its tests instead of silently skipping them.
const skipDesktop = skipWorkstation
  || (onWsl ? 'desktop-only script (is-desktop-linux renders empty under WSL)' : false);

// The two interactive-chsh tests route the rendered script through `script(1)` to hand it a pty.
// Debian ships that in essential util-linux; Fedora splits it into a separate util-linux-script
// package, so a stock Fedora box has none and both tests failed with a bare `1 !== 0` -- that was
// realBin() throwing inside runSh's try, not the script under test misbehaving. tools.toml now
// installs it on Fedora; skip cleanly where it is still absent rather than reporting a phantom
// regression, the same way this suite already skips on a missing chezmoi.
//
// ptySkip(), not `command -v script`: macOS HAS a script(1), but it is the BSD one, which
// takes a different command form AND tcgetattr's its own stdin -- from a node child with piped
// stdio it cannot allocate a pty at all and exits 1 before the rendered script runs. Presence
// was the wrong question; the flavour is the one that decides. Same probe the TUI suites use,
// and the same bare `1 !== 0` symptom the Fedora note above describes.
const skipTty = skip || ptySkip();

function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
}

const ALL_FILES = walk(SCRIPTS_DIR);
const SH_TMPLS = ALL_FILES.filter((f) => f.endsWith('.sh.tmpl')).sort();
const PS1_TMPLS = ALL_FILES.filter((f) => f.endsWith('.ps1.tmpl')).sort();

const dirs = [];
function tmpdir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }

function realBin(name) {
  return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
}

function readLog(logFile) {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

// Runs an already-rendered script file under `env` (which fully replaces process.env).
// tty:true routes it through `script` so `[ -t 0 ]` reads true (the interactive chsh path);
// tty:false leaves stdin a plain pipe so `[ -t 0 ]` reads false (the headless defer path).
function runSh(scriptFile, env, { tty = false } = {}) {
  try {
    const stdout = tty
      ? execFileSync(realBin('script'), ['-qec', `${realBin('sh')} ${scriptFile}`, '/dev/null'], { env, encoding: 'utf8' })
      : execFileSync(realBin('sh'), [scriptFile], { env, encoding: 'utf8', input: '' });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '' };
  }
}

// --- Part 1: render-and-parse sweep ---------------------------------------------------------

for (const file of SH_TMPLS) {
  const rel = path.relative(REPO, file);
  test(`renders and bash -n parses: ${rel}`, { skip }, () => {
    const rendered = renderFile(file);
    const dir = tmpdir('chezmoi-sh-');
    const out = path.join(dir, 'rendered.sh');
    fs.writeFileSync(out, rendered);
    execFileSync('bash', ['-n', out], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
}

for (const file of PS1_TMPLS) {
  const rel = path.relative(REPO, file);
  // No pwsh on this machine -- rendering-only coverage, no syntax check.
  test(`renders: ${rel}`, { skip }, () => {
    renderFile(file);
  });
}

// --- Part 1b: WSL scripts, rendered with the is-wsl guard bypassed ---------------------------
//
// Part 1 renders these to an empty string off WSL, so `bash -n` on the result proves nothing and
// a broken WSL script stays green on every non-WSL machine that runs this suite. Strip the two
// leading `{{ if }}` guards and their two trailing `{{ end }}`s and render the body directly, so
// the includeTemplate resolution and the shell syntax are checked everywhere.
//
// Only the guards are removed -- the body is rendered by the real chezmoi, so a template error
// inside it still fails here.
function renderWslBody(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.match(lines[1], /includeTemplate "is-wsl"/, `${path.basename(file)}: expected an is-wsl guard on line 2`);
  const body = lines.slice(2).filter((l) => l.trim() !== '{{ end -}}').join('\n');
  return execFileSync('chezmoi', ['execute-template', '--source', REPO], { input: body, encoding: 'utf8' });
}

const WSL_TMPLS = SH_TMPLS.filter((f) => f.includes(`${path.sep}wsl${path.sep}`));

test('the WSL script set is non-empty (guards against a silent glob change)', { skip }, () => {
  assert.ok(WSL_TMPLS.length >= 7, `expected >=7 WSL scripts, found ${WSL_TMPLS.length}`);
});

for (const file of WSL_TMPLS) {
  const rel = path.relative(REPO, file);
  test(`renders past the is-wsl guard and bash -n parses: ${rel}`, { skip }, () => {
    const dir = tmpdir('chezmoi-wsl-');
    const out = path.join(dir, 'rendered.sh');
    fs.writeFileSync(out, renderWslBody(file));
    execFileSync('bash', ['-n', out], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
}

// The Docker installer used to hand-roll the keyring/source/apt-get dance that apt_repo_add
// already does for the GitHub CLI and three apps in install-apps. Pin the shared call so it does
// not drift back: the failure it prevents is a second implementation of apt repo setup diverging
// from the one linux-install.sh tests cover.
test('install-docker-engine adds its apt repo via the shared helper', { skip }, () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_install-docker-engine.sh.tmpl'), 'utf8');
  assert.match(src, /apt_repo_add docker https:\/\/download\.docker\.com/);
  assert.match(src, /signed-by=__KEYRING__/, 'the source line must let apt_repo_add fill in the keyring path');
  assert.doesNotMatch(src, /sudo tee "\$DOCKER_LIST"/, 'writing the .list by hand is what apt_repo_add replaced');
  assert.doesNotMatch(src, /gpg --dearmor|install -m 0644 "\$tmpk"/, 'keyring handling belongs to apt_repo_add');

  const rendered = renderWslBody(path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_install-docker-engine.sh.tmpl'));
  assert.match(rendered, /^apt_repo_add\(\) \{/m, 'linux-install.sh must actually be inlined');
});

// --- Part 2: behavior tests for the three riskiest scripts ----------------------------------

const SUDO_STUB = [
  '#!/bin/sh',
  'echo "sudo $*" >> "$STUB_LOG"',
  'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
  '  exit "${SUDO_PROBE_EXIT:-0}"',
  'fi',
  'exit "${SUDO_EXIT:-0}"',
  '',
].join('\n');

// 2a. os-unix/run_once_after_set-default-shell.sh.tmpl ---------------------------------------
{
  const SDS_SRC = path.join(SCRIPTS_DIR, 'os-unix', 'run_once_after_set-default-shell.sh.tmpl');

  const CHSH_STUB = '#!/bin/sh\necho "chsh $*" >> "$STUB_LOG"\nexit 0\n';
  const ID_STUB = '#!/bin/sh\necho testuser\n';
  const ZSH_STUB = '#!/bin/sh\nexit 0\n';
  const GETENT_STUB = [
    '#!/bin/sh',
    'if [ "$1" = "passwd" ]; then',
    '  echo "testuser:x:1000:1000::/home/testuser:${TEST_CURRENT_SHELL:-/bin/bash}"',
    'fi',
    '',
  ].join('\n');

  // currentShell: '/bin/bash' (not zsh yet) or 'zsh' (converged). zshInstalled:false means no
  // zsh stub is placed on PATH, so `command -v zsh` reports nothing.
  function sdsSandbox({ zshInstalled = true, currentShell = '/bin/bash' } = {}) {
    const dir = tmpdir('sds-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), SUDO_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'chsh'), CHSH_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'getent'), GETENT_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'id'), ID_STUB, { mode: 0o755 });
    let zshPath = null;
    if (zshInstalled) {
      zshPath = path.join(dir, 'zsh');
      fs.writeFileSync(zshPath, ZSH_STUB, { mode: 0o755 });
    }
    fs.symlinkSync(realBin('cut'), path.join(dir, 'cut'));
    fs.symlinkSync(realBin('awk'), path.join(dir, 'awk'));
    fs.symlinkSync(realBin('grep'), path.join(dir, 'grep'));
    const rendered = renderFile(SDS_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = {
      PATH: dir, HOME: dir, STUB_LOG: logFile,
      TEST_CURRENT_SHELL: currentShell === 'zsh' ? zshPath : currentShell,
    };
    return { scriptFile, env, logFile, zshPath };
  }

  // Deferring rather than skipping is the whole point: run_once records success against the
  // script's contents, so an exit 0 with zsh absent burns the marker and the login shell is
  // never set on that machine. install-cli-tools defers whenever sudo cannot prompt, which puts
  // an ordinary first apply here before zsh exists -- that is how a freshly provisioned Fedora
  // box ended up stuck on bash with no error to show for it.
  test('set-default-shell.sh.tmpl: zsh not installed -> defers with exit 1, no chsh/sudo calls', { skip }, () => {
    const { scriptFile, env, logFile } = sdsSandbox({ zshInstalled: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1, 'must defer; exit 0 would record run_once done forever');
    assert.strictEqual(readLog(logFile), '');
  });

  test('set-default-shell.sh.tmpl: login shell already zsh -> exits 0, no chsh/sudo calls', { skip }, () => {
    const { scriptFile, env, logFile } = sdsSandbox({ currentShell: 'zsh' });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readLog(logFile), '');
  });

  test('set-default-shell.sh.tmpl: headless (no tty) -> defers with exit 1, no chsh/sudo calls', { skip }, () => {
    const { scriptFile, env, logFile } = sdsSandbox();
    const { status } = runSh(scriptFile, env); // tty:false (default) -> [ -t 0 ] is false
    assert.strictEqual(status, 1);
    assert.strictEqual(readLog(logFile), '');
  });

  test('set-default-shell.sh.tmpl: interactive + sudo available -> sudo chsh invoked with the zsh path', { skip: skipTty }, () => {
    const { scriptFile, env, logFile, zshPath } = sdsSandbox();
    const { status } = runSh(scriptFile, env, { tty: true });
    assert.strictEqual(status, 0);
    const log = readLog(logFile);
    assert.ok(log.includes(`sudo chsh -s ${zshPath} testuser`), `expected sudo chsh call in log:\n${log}`);
  });

  test('set-default-shell.sh.tmpl: interactive + sudo unavailable -> falls back to plain chsh', { skip: skipTty }, () => {
    const { scriptFile, env, logFile, zshPath } = sdsSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env, { tty: true });
    assert.strictEqual(status, 0);
    const log = readLog(logFile);
    assert.ok(log.includes(`\nchsh -s ${zshPath}`), `expected plain chsh fallback in log:\n${log}`);
    assert.ok(!log.includes('sudo chsh'), `sudo chsh should not have been invoked:\n${log}`);
  });
}

// 2b. os-linux/wsl/run_once_after_configure-wsl.sh.tmpl ---------------------------------------
// Only the sudo guard is safely sandboxable: every mutating step (wl-clipboard install,
// /etc/wsl.conf edits) is wrapped in sudo (never really executed by the stub below) but also
// gated on reads of hardcoded absolute /etc paths with no script-level override, so exercising
// those branches deterministically isn't possible without touching real host state.
{
  const CW_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_configure-wsl.sh.tmpl');

  test('configure-wsl.sh.tmpl: sudo unavailable -> defers with exit 1, nothing else attempted', { skip: skipWsl }, () => {
    const dir = tmpdir('configure-wsl-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), SUDO_STUB, { mode: 0o755 });
    const rendered = renderFile(CW_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, SUDO_PROBE_EXIT: '1' };
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readLog(logFile).trim(), 'sudo -v');
  });
}

// 2c. os-linux/wsl/run_once_after_debloat-wsl.sh.tmpl -----------------------------------------
{
  const DW_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_debloat-wsl.sh.tmpl');

  const SYSTEMCTL_STUB = [
    '#!/bin/sh',
    'case "$1" in',
    '  is-enabled)',
    '    unit="$2"',
    '    case " ${MASKED_UNITS:-} " in',
    '      *" $unit "*) echo masked; exit 0 ;;',
    '    esac',
    '    echo enabled; exit 0',
    '    ;;',
    '  cat)',
    '    unit="$2"',
    '    case " ${MISSING_UNITS:-} " in',
    '      *" $unit "*) exit 1 ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n');

  function dwSandbox({ maskedUnits = '', missingUnits = '' } = {}) {
    const dir = tmpdir('debloat-wsl-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), SUDO_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'systemctl'), SYSTEMCTL_STUB, { mode: 0o755 });
    fs.symlinkSync(realBin('grep'), path.join(dir, 'grep'));
    const rendered = renderFile(DW_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = {
      PATH: dir, HOME: dir, STUB_LOG: logFile,
      MASKED_UNITS: maskedUnits, MISSING_UNITS: missingUnits,
    };
    return { scriptFile, env, logFile };
  }

  // The convergence fast-path (masked snapd.service + both /etc drop-ins present) and the
  // MOTD/sysctl/journald writes all key off hardcoded absolute /etc paths with no override --
  // left unasserted (though harmless either way, since sudo never really executes anything);
  // the sudo guard and the systemctl mask/skip decision loop below are fully sandboxed.
  test('debloat-wsl.sh.tmpl: sudo unavailable -> defers with exit 1 before masking anything', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = dwSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readLog(logFile).trim(), 'sudo -v');
  });

  test('debloat-wsl.sh.tmpl: masks an existing unmasked unit, skips missing/already-masked units', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = dwSandbox({
      maskedUnits: 'landscape-client.service',
      missingUnits: 'snapd.socket snapd.seeded.service wsl-pro.service motd-news.timer',
    });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    const log = readLog(logFile);
    assert.ok(log.includes('sudo systemctl mask --now snapd.service'), `existing unmasked unit should be masked:\n${log}`);
    for (const unit of ['snapd.socket', 'snapd.seeded.service', 'wsl-pro.service', 'motd-news.timer', 'landscape-client.service']) {
      assert.ok(!log.includes(`mask --now ${unit}`), `${unit} should not have been masked:\n${log}`);
    }
  });
}

// 2d. os-unix/run_once_after_install-python-tools.sh.tmpl ------------------------------------
// No sudo here, but it curl|sh's a remote installer, so the sandbox stubs curl (never reaches
// the network) and uv (never installs anything). The fake installer the curl stub writes is
// executed for real by the script's `sh`, which is what proves UV_INSTALL_DIR /
// INSTALLER_NO_MODIFY_PATH are actually handed to it.
{
  const PT_SRC = path.join(SCRIPTS_DIR, 'os-unix', 'run_once_after_install-python-tools.sh.tmpl');

  const UNAME_STUB = '#!/bin/sh\necho "${TEST_UNAME_S:-Linux}"\n';

  // Logs its argv, then writes a stand-in for astral's install.sh to the -o path. The stand-in
  // records the env it was invoked with and drops a uv stub in UV_INSTALL_DIR, so the script's
  // post-install `command -v uv` probe resolves exactly as it would after a real install.
  const CURL_STUB = [
    '#!/bin/sh',
    'echo "curl $*" >> "$STUB_LOG"',
    '[ "${CURL_EXIT:-0}" = "0" ] || exit "$CURL_EXIT"',
    'out=""; prev=""',
    'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    'cat > "$out" <<EOF',
    'echo "uv-installer UV_INSTALL_DIR=\\$UV_INSTALL_DIR INSTALLER_NO_MODIFY_PATH=\\$INSTALLER_NO_MODIFY_PATH" >> "$STUB_LOG"',
    'mkdir -p "\\$UV_INSTALL_DIR"',
    'cp "$STUB_DIR/uv.payload" "\\$UV_INSTALL_DIR/uv"',
    'EOF',
    'exit 0',
  ].join('\n');

  // `uv tool install <name>` materializes <name> in the stub dir (always on PATH) so the
  // script's final command -v sweep sees the tools a real install would have produced.
  const UV_STUB = [
    '#!/bin/sh',
    'echo "uv $*" >> "$STUB_LOG"',
    'if [ "$1" = "tool" ] && [ "$2" = "install" ]; then',
    '  printf "#!/bin/sh\\n" > "$STUB_DIR/$3" && chmod 755 "$STUB_DIR/$3"',
    'fi',
    'exit "${UV_EXIT:-0}"',
  ].join('\n');

  function ptSandbox({ uvPresent = false, unameS = 'Linux' } = {}) {
    const dir = tmpdir('python-tools-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'uname'), UNAME_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'curl'), CURL_STUB, { mode: 0o755 });
    // uv.payload is what the fake installer copies into UV_INSTALL_DIR; it sits off PATH so
    // `command -v uv` misses it until the install "runs". uvPresent also drops it on PATH.
    fs.writeFileSync(path.join(dir, 'uv.payload'), UV_STUB, { mode: 0o755 });
    if (uvPresent) fs.writeFileSync(path.join(dir, 'uv'), UV_STUB, { mode: 0o755 });
    for (const b of ['cat', 'chmod', 'cp', 'mkdir', 'mktemp', 'rm', 'sh']) {
      fs.symlinkSync(realBin(b), path.join(dir, b));
    }
    const rendered = renderFile(PT_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = {
      PATH: dir, HOME: dir, STUB_LOG: logFile, STUB_DIR: dir, TEST_UNAME_S: unameS,
    };
    return { scriptFile, env, logFile, dir };
  }

  test('install-python-tools.sh.tmpl: uv missing on Linux -> fetches the installer with UV_INSTALL_DIR pinned and PATH edits off', { skip }, () => {
    const { scriptFile, env, logFile, dir } = ptSandbox({ uvPresent: false });
    const { status } = runSh(scriptFile, env);
    const log = readLog(logFile);
    assert.strictEqual(status, 0, `expected success, log:\n${log}`);
    assert.ok(log.includes('curl -LsSf https://astral.sh/uv/install.sh'), `installer should be fetched:\n${log}`);
    assert.ok(
      log.includes(`uv-installer UV_INSTALL_DIR=${path.join(dir, '.local', 'bin')} INSTALLER_NO_MODIFY_PATH=1`),
      `installer should get a pinned dir and no PATH edits:\n${log}`,
    );
  });

  test('install-python-tools.sh.tmpl: uv already present -> no download, installs python + ruff + prek', { skip }, () => {
    const { scriptFile, env, logFile } = ptSandbox({ uvPresent: true });
    const { status } = runSh(scriptFile, env);
    const log = readLog(logFile);
    assert.strictEqual(status, 0, `expected success, log:\n${log}`);
    assert.ok(!log.includes('curl '), `nothing should be downloaded when uv exists:\n${log}`);
    assert.ok(log.includes('uv python install 3.12'), `managed CPython should be provisioned:\n${log}`);
    assert.ok(log.includes('uv tool install ruff'), `ruff should be installed:\n${log}`);
    assert.ok(log.includes('uv tool install prek'), `prek should be installed:\n${log}`);
  });

  // pytest is intentionally left to each project's own env (`uv run pytest`); a global one
  // could not import the project under test. Asserted so a future edit can't quietly add it.
  test('install-python-tools.sh.tmpl: never installs pytest globally', { skip }, () => {
    const { scriptFile, env, logFile } = ptSandbox({ uvPresent: true });
    runSh(scriptFile, env);
    assert.ok(!/tool install pytest/.test(readLog(logFile)), 'pytest must not be installed as a global uv tool');
  });

  test('install-python-tools.sh.tmpl: non-Linux without uv -> defers with exit 1, no download, no uv calls', { skip }, () => {
    const { scriptFile, env, logFile } = ptSandbox({ uvPresent: false, unameS: 'Darwin' });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readLog(logFile), '');
  });

  test('install-python-tools.sh.tmpl: installer download fails -> exit 1 without touching uv', { skip }, () => {
    const { scriptFile, env, logFile } = ptSandbox({ uvPresent: false });
    env.CURL_EXIT = '22';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.ok(!readLog(logFile).includes('uv tool install'), 'no tool install should be attempted without uv');
  });
}

// 2e. os-linux/wsl/run_once_after_install-wslg-audio.sh.tmpl ---------------------------------
// Installs pulseaudio-utils so play-sound.sh uses WSLg's PulseAudio instead of powershell.exe
// interop (which leaks a spinning CPU thread per launch, microsoft/WSL#41173). Both mutating
// steps are `sudo apt-get ...` and the sudo stub never execs them, so no real apt call happens.
{
  const WA_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'wsl', 'run_once_after_install-wslg-audio.sh.tmpl');

  // Materializes paplay in STUB_DIR on `apt-get install` so the script's post-install
  // `command -v paplay` probe resolves exactly as it would after a real install.
  // APT_INSTALL_FAILS=1 simulates apt exiting non-zero and leaving nothing behind.
  const APT_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
    '  exit "${SUDO_PROBE_EXIT:-0}"',
    'fi',
    'if [ "$2" = "install" ]; then',
    '  [ "${APT_INSTALL_FAILS:-0}" = "0" ] || exit 100',
    '  printf "#!/bin/sh\\n" > "$STUB_DIR/paplay" && chmod 755 "$STUB_DIR/paplay"',
    'fi',
    'exit "${SUDO_EXIT:-0}"',
    '',
  ].join('\n');

  function waSandbox({ paplayPresent = false } = {}) {
    const dir = tmpdir('wslg-audio-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), APT_SUDO_STUB, { mode: 0o755 });
    if (paplayPresent) fs.writeFileSync(path.join(dir, 'paplay'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(realBin('chmod'), path.join(dir, 'chmod')); // used by the sudo stub itself
    // apt-get and dpkg only have to EXIST. linux-install.sh picks its package manager with
    // `command -v apt-get && command -v dpkg`, and PATH is replaced wholesale by this dir, so
    // without them the module finds no package manager at all: pkg_install becomes a no-op, the
    // post-install `command -v paplay` probe fails, and the script exits 1 having logged nothing
    // past `sudo -v`. That reads as a broken script rather than a sandbox missing two stubs.
    // They are never executed — the sudo stub logs its argv and returns without exec'ing.
    for (const name of ['apt-get', 'dpkg']) {
      fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const rendered = renderFile(WA_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, STUB_DIR: dir };
    return { scriptFile, env, logFile };
  }

  test('install-wslg-audio.sh.tmpl: paplay already present -> exits 0 without invoking sudo', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox({ paplayPresent: true });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readLog(logFile), '', 'converged run must not probe or invoke sudo');
  });

  test('install-wslg-audio.sh.tmpl: sudo unavailable -> defers with exit 1 before touching apt', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1, 'must exit 1 so chezmoi does not record success');
    assert.strictEqual(readLog(logFile).trim(), 'sudo -v', 'no apt call should follow a failed sudo probe');
  });

  test('install-wslg-audio.sh.tmpl: paplay missing + sudo available -> installs pulseaudio-utils and nothing else', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox();
    const { status, stdout } = runSh(scriptFile, env);
    const log = readLog(logFile);
    assert.strictEqual(status, 0, `expected success, log:\n${log}`);
    assert.ok(log.includes('sudo apt-get update -qq'), `apt index should be refreshed first:\n${log}`);
    assert.ok(log.includes('sudo apt-get install -y pulseaudio-utils'), `pulseaudio-utils should be installed:\n${log}`);
    // Guards against a future edit quietly widening this into a general audio-stack install.
    const installs = log.split('\n').filter((l) => l.includes('apt-get install'));
    assert.deepStrictEqual(installs, ['sudo apt-get install -y pulseaudio-utils'], `exactly one package expected:\n${log}`);
    assert.match(stdout, /pulseaudio-utils installed/);
  });

  test('install-wslg-audio.sh.tmpl: apt fails to provide paplay -> exit 1 so the next apply retries', { skip: skipWsl }, () => {
    const { scriptFile, env, logFile } = waSandbox();
    env.APT_INSTALL_FAILS = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1, 'a silent fallback to interop must not be recorded as success');
    assert.ok(readLog(logFile).includes('apt-get install -y pulseaudio-utils'), 'the install should have been attempted');
  });
}

// 2f. os-linux/run_onchange_after_dnf-speedups.sh.tmpl ---------------------------------------
{
  const DS_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_dnf-speedups.sh.tmpl');

  // This script's whole job is the resulting file, so unlike the sandboxes above its sudo stub
  // DOES exec what it wraps -- asserting on argv alone would prove nothing about the config that
  // comes out. That is safe only because the stub execs exactly one shape: an `install` whose
  // destination is $DNF_CONF, which the sandbox points at a temp file. Anything else is refused
  // rather than run, so a future edit that adds a second sudo call fails loudly here instead of
  // reaching the real system. Keep that whitelist as narrow as the script's actual writes.
  const DS_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
    '  exit "${SUDO_PROBE_EXIT:-0}"',
    'fi',
    'for dest; do :; done',      // POSIX idiom for the last positional arg
    'if [ "$1" = install ] && [ "$dest" = "$DNF_CONF" ]; then',
    '  exec "$@"',
    'fi',
    'echo "stub sudo refused: $*" >&2',
    'exit 99',
    '',
  ].join('\n');

  const BEGIN = '# >>> chezmoi dnf-speedups >>>';
  const END = '# <<< chezmoi dnf-speedups <<<';
  const MANAGED = ['max_parallel_downloads=10', 'defaultyes=True', 'keepcache=True'];

  // pm:'dnf' places dnf+rpm stubs so linux-install.sh resolves PM=dnf; pm:'apt' places
  // apt-get+dpkg instead, which is how every Debian machine running this suite reaches the
  // early exit.
  function dsSandbox({ conf = '# see `man dnf.conf`\n\n[main]\n', pm = 'dnf' } = {}) {
    const dir = tmpdir('dnf-');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), DS_SUDO_STUB, { mode: 0o755 });
    const TRUE_STUB = '#!/bin/sh\nexit 0\n';
    for (const bin of pm === 'dnf' ? ['dnf', 'rpm'] : ['apt-get', 'dpkg']) {
      fs.writeFileSync(path.join(dir, bin), TRUE_STUB, { mode: 0o755 });
    }
    for (const bin of ['grep', 'awk', 'mktemp', 'cmp', 'cp', 'install', 'mkdir', 'uname', 'rm']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const confFile = path.join(dir, 'dnf.conf');
    fs.writeFileSync(confFile, conf);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, renderFile(DS_SRC));
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, DNF_CONF: confFile };
    return { scriptFile, env, logFile, confFile };
  }

  const readConf = (f) => fs.readFileSync(f, 'utf8');

  test('dnf-speedups.sh.tmpl: bare [main] -> writes the managed block with all three options', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, confFile } = dsSandbox();
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0, `expected success, log:\n${readLog(logFile)}`);
    const out = readConf(confFile);
    assert.ok(out.includes(BEGIN) && out.includes(END), `markers missing:\n${out}`);
    for (const kv of MANAGED) assert.ok(out.includes(kv), `${kv} missing:\n${out}`);
    // Options must land under [main], not before it, or dnf reads a file with no section header.
    assert.ok(out.indexOf('[main]') < out.indexOf(BEGIN), `block precedes [main]:\n${out}`);
    assert.ok(readLog(logFile).includes(`sudo install -m 0644`), 'the write should go through sudo');
  });

  test('dnf-speedups.sh.tmpl: second run over a converged file writes nothing and never probes sudo', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, confFile } = dsSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const afterFirst = readConf(confFile);
    fs.writeFileSync(logFile, '');
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), afterFirst, 'a converged file must not be rewritten');
    // `sudo -v` prompts for a password, so a no-op apply that probes it is a regression even
    // though the file is unchanged.
    assert.strictEqual(readLog(logFile), '', 'converged run must not touch sudo at all');
  });

  test('dnf-speedups.sh.tmpl: an edited block is rewritten rather than duplicated', { skip: skipLinux }, () => {
    const conf = `[main]\n${BEGIN}\nmax_parallel_downloads=3\n${END}\n`;
    const { scriptFile, env, confFile } = dsSandbox({ conf });
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.strictEqual(out.split(BEGIN).length - 1, 1, `exactly one block expected:\n${out}`);
    assert.ok(out.includes('max_parallel_downloads=10'), `stale value not replaced:\n${out}`);
    assert.ok(!out.includes('max_parallel_downloads=3'), `stale value survived:\n${out}`);
  });

  test('dnf-speedups.sh.tmpl: a hand-set option is left alone, not duplicated', { skip: skipLinux }, () => {
    const { scriptFile, env, confFile } = dsSandbox({ conf: '[main]\nkeepcache=False\n' });
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.ok(out.includes('keepcache=False'), `the user's value must survive:\n${out}`);
    assert.ok(!out.includes('keepcache=True'), `must not write a competing copy:\n${out}`);
    assert.ok(out.includes('defaultyes=True'), `the other options should still apply:\n${out}`);
  });

  test('dnf-speedups.sh.tmpl: a repo stanza in dnf.conf -> refuses to touch the file', { skip: skipLinux }, () => {
    const conf = '[main]\n\n[myrepo]\nbaseurl=http://example.invalid/\n';
    const { scriptFile, env, logFile, confFile } = dsSandbox({ conf });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), conf, 'a multi-stanza file must be left untouched');
    assert.strictEqual(readLog(logFile), '');
  });

  test('dnf-speedups.sh.tmpl: an unbalanced managed block -> exit 1 without truncating the file', { skip: skipLinux }, () => {
    const conf = `[main]\n${BEGIN}\ndefaultyes=True\ninstall_weak_deps=False\n`;
    const { scriptFile, env, confFile } = dsSandbox({ conf });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1, 'a missing end marker must fail loudly, not silently strip');
    assert.strictEqual(readConf(confFile), conf);
  });

  test('dnf-speedups.sh.tmpl: apt machine -> exits without reading or writing dnf.conf', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, confFile } = dsSandbox({ pm: 'apt' });
    const before = readConf(confFile);
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), before);
    assert.strictEqual(readLog(logFile), '');
  });

  test('dnf-speedups.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipLinux }, () => {
    const { scriptFile, env, confFile } = dsSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const before = readConf(confFile);
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readConf(confFile), before);
  });
}

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// 2g. os-linux/run_onchange_after_setup-btrfs-snapshots.sh.tmpl ------------------------------
{
  const BS_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_setup-btrfs-snapshots.sh.tmpl');

  // This script's effect is spread over four resources (a package, a config file, two snapper
  // configs, three timers), so unlike the sandboxes above its stubs are STATEFUL: the sudo stub
  // records what it was asked to change under $STATE_DIR, and the rpm/systemctl/snapper stubs
  // read that state back. That is what makes the convergence test worth anything -- it proves
  // the script's own writes are what turn the second run into a no-op, rather than asserting
  // against a fixture we hand-converged. The only real exec is the `install` whose destination
  // is $SNAPPER_ACTIONS, which the sandbox points at a temp file; every other sudo shape is
  // enumerated and recorded, and anything unrecognised is refused rather than run.
  const BS_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then exit "${SUDO_PROBE_EXIT:-0}"; fi',
    'case "$1" in',
    '  mkdir) shift; exec mkdir "$@" ;;',
    '  install)',
    '    for dest; do :; done',
    '    if [ "$dest" = "$SNAPPER_ACTIONS" ]; then shift; exec install "$@"; fi',
    '    echo "stub sudo refused: $*" >&2; exit 99 ;;',
    '  dnf)',
    '    [ "$2" = install ] || { echo "stub sudo refused: $*" >&2; exit 99; }',
    '    : > "$STATE_DIR/pkg"; exit 0 ;;',
    '  systemctl)',
    '    [ "$2" = enable ] || { echo "stub sudo refused: $*" >&2; exit 99; }',
    '    : > "$STATE_DIR/timer-$4"; exit 0 ;;',
    '  snapper)',
    // Replays `set-config KEY=VALUE ...` into the CSV the get-config stub will serve back.
    '    cfg=""; prev=""; seen=0',
    '    for a; do',
    '      [ "$prev" = "-c" ] && cfg="$a"',
    '      [ "$seen" = 1 ] && echo "$a" | tr "=" "," >> "$STATE_DIR/cfg-$cfg"',
    '      [ "$a" = set-config ] && seen=1',
    '      prev="$a"',
    '    done',
    '    exit 0 ;;',
    'esac',
    'echo "stub sudo refused: $*" >&2',
    'exit 99',
    '',
  ].join('\n');

  const BS_SNAPPER_STUB = [
    '#!/bin/sh',
    'cfg=""; prev=""',
    'for a; do [ "$prev" = "-c" ] && cfg="$a"; prev="$a"; done',
    'case " $* " in',
    '  *" get-config "*)',
    '    [ -f "$STATE_DIR/cfg-$cfg" ] || exit 1',
    '    cat "$STATE_DIR/cfg-$cfg" ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');

  // `rpm -q <pkg>` answers from state; every other rpm call is PM detection and just succeeds.
  const BS_RPM_STUB = '#!/bin/sh\n[ "$1" = -q ] || exit 0\n[ -f "$STATE_DIR/pkg" ]\n';
  const BS_SYSTEMCTL_STUB =
    '#!/bin/sh\n[ "$1" = is-enabled ] || exit 0\nfor u; do :; done\n[ -f "$STATE_DIR/timer-$u" ]\n';

  const TIMERS = ['snapper-timeline.timer', 'snapper-cleanup.timer', 'snapper-boot.timer'];

  function bsSandbox({ pm = 'dnf', btrfs = true, configs = ['root', 'home'] } = {}) {
    const dir = tmpdir('btrfs-');
    const state = path.join(dir, 'state');
    const cfgDir = path.join(dir, 'snapper-configs');
    fs.mkdirSync(state);
    fs.mkdirSync(cfgDir);
    for (const c of configs) fs.writeFileSync(path.join(cfgDir, c), '');
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), BS_SUDO_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'snapper'), BS_SNAPPER_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'rpm'), BS_RPM_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'systemctl'), BS_SYSTEMCTL_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'findmnt'), `#!/bin/sh\nexit ${btrfs ? 0 : 1}\n`, { mode: 0o755 });
    const TRUE_STUB = '#!/bin/sh\nexit 0\n';
    for (const bin of pm === 'dnf' ? ['dnf'] : ['apt-get', 'dpkg']) {
      fs.writeFileSync(path.join(dir, bin), TRUE_STUB, { mode: 0o755 });
    }
    for (const bin of ['grep', 'awk', 'sed', 'mktemp', 'cmp', 'cp', 'install', 'mkdir', 'uname', 'rm', 'cat', 'dirname', 'tr']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const actionsFile = path.join(dir, 'snapper.actions');
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, renderFile(BS_SRC));
    const env = {
      PATH: dir, HOME: dir, STUB_LOG: logFile, STATE_DIR: state,
      SNAPPER_ACTIONS: actionsFile, SNAPPER_CONFIG_DIR: cfgDir,
    };
    return { scriptFile, env, logFile, actionsFile };
  }

  test('btrfs-snapshots.sh.tmpl: fresh box -> installs the plugin, writes the hook, sets both configs, enables all three timers', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox();
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0, `expected success, log:\n${readLog(logFile)}`);
    const log = readLog(logFile);
    assert.ok(log.includes('sudo dnf install -y libdnf5-plugin-actions'), `plugin not installed:\n${log}`);
    assert.ok(fs.existsSync(actionsFile), 'the actions hook should have been written');
    const actions = fs.readFileSync(actionsFile, 'utf8');
    assert.ok(actions.includes('pre_transaction'), `no pre_transaction hook:\n${actions}`);
    assert.ok(actions.includes('post_transaction'), `no post_transaction hook:\n${actions}`);
    // `-c number` on both creates is what lets NUMBER_CLEANUP reap the pairs; upstream's example
    // omits it, and without it every dnf transaction leaves a pair behind forever.
    assert.strictEqual(actions.split('-c\\ number').length - 1, 2, `both creates need -c number:\n${actions}`);
    assert.ok(log.includes('sudo snapper -c root set-config'), `root retention unset:\n${log}`);
    assert.ok(log.includes('sudo snapper -c home set-config'), `home retention unset:\n${log}`);
    // root carries the dnf pre/post pairs, so it is the only config given the larger budget.
    assert.ok(/sudo snapper -c root set-config[^\n]*NUMBER_LIMIT=20/.test(log), `root NUMBER_LIMIT:\n${log}`);
    assert.ok(!/sudo snapper -c home set-config[^\n]*NUMBER_LIMIT=/.test(log), `home must keep its own:\n${log}`);
    for (const u of TIMERS) {
      assert.ok(log.includes(`sudo systemctl enable --now ${u}`), `${u} not enabled:\n${log}`);
    }
  });

  test('btrfs-snapshots.sh.tmpl: second run over a converged box writes nothing and never probes sudo', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0, `first run failed:\n${readLog(logFile)}`);
    const afterFirst = fs.readFileSync(actionsFile, 'utf8');
    fs.writeFileSync(logFile, '');
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(fs.readFileSync(actionsFile, 'utf8'), afterFirst, 'a converged hook must not be rewritten');
    // `sudo -v` prompts for a password, so a no-op apply that probes it is a regression even
    // though nothing downstream changed.
    assert.strictEqual(readLog(logFile), '', 'converged run must not touch sudo at all');
  });

  test('btrfs-snapshots.sh.tmpl: / is not btrfs -> exits without writing or probing sudo', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox({ btrfs: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(actionsFile), 'nothing should be written on a non-btrfs root');
    assert.strictEqual(readLog(logFile), '');
  });

  test('btrfs-snapshots.sh.tmpl: a missing snapper config -> warns and exits rather than creating one', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox({ configs: ['root'] });
    const { status } = runSh(scriptFile, env);
    // create-config makes a .snapshots subvolume, which an apply must not do unasked.
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(actionsFile), 'must not configure a box whose configs are absent');
    assert.strictEqual(readLog(logFile), '');
  });

  test('btrfs-snapshots.sh.tmpl: apt machine -> exits without touching anything', { skip: skipLinux }, () => {
    const { scriptFile, env, logFile, actionsFile } = bsSandbox({ pm: 'apt' });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(actionsFile));
    assert.strictEqual(readLog(logFile), '');
  });

  test('btrfs-snapshots.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipLinux }, () => {
    const { scriptFile, env, actionsFile } = bsSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.ok(!fs.existsSync(actionsFile), 'nothing should be written without sudo');
  });
}

// 2h. os-linux/run_onchange_after_setup-bt-hid-recovery.sh.tmpl ------------------------------
{
  const BT_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_setup-bt-hid-recovery.sh.tmpl');

  // This script's entire effect is four files written through `sudo tee` plus a systemd and a
  // udev reload, so unlike the sandboxes above its sudo stub execs a REAL tee, redirected under
  // $FAKE_ROOT. Asserting on argv alone would prove almost nothing here: every interesting
  // detail (the --no-block restart, the rate limit, the VID/PID) lives inside a heredoc, so the
  // tests need the bytes that would have landed in /etc. Any sudo verb the stub does not
  // recognise is logged as REFUSED rather than run, so a later `sudo mv` added to the script
  // fails these tests instead of silently escaping the sandbox.
  const BT_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then exit "${SUDO_PROBE_EXIT:-0}"; fi',
    'case "$1" in',
    '  tee)',
    '    out="$FAKE_ROOT$2"',
    '    mkdir -p "$(dirname "$out")"',
    '    exec tee "$out" ;;',
    '  chmod|systemctl|udevadm|restorecon) exit 0 ;;',
    'esac',
    'echo "sudo REFUSED $*" >> "$STUB_LOG"',
    'exit 99',
    '',
  ].join('\n');

  const BT_PATHS = {
    script: 'usr/local/bin/bt-hid-health',
    service: 'etc/systemd/system/bt-hid-health.service',
    forceService: 'etc/systemd/system/bt-hid-health-force.service',
    polkit: 'etc/polkit-1/rules.d/49-bt-hid-health-force.rules',
    timer: 'etc/systemd/system/bt-hid-health.timer',
    udev: 'etc/udev/rules.d/50-bt500-no-autosuspend.rules',
  };

  function btSandbox({ bluetoothctl = true, btUnit = true } = {}) {
    const dir = tmpdir('bt-hid-');
    const fakeRoot = path.join(dir, 'root');
    fs.mkdirSync(fakeRoot);
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), BT_SUDO_STUB, { mode: 0o755 });
    // Only `list-unit-files` decides the gate; every other systemctl call here is unprivileged
    // and irrelevant, so it just succeeds.
    fs.writeFileSync(
      path.join(dir, 'systemctl'),
      `#!/bin/sh\n[ "$1" = list-unit-files ] || exit 0\nexit ${btUnit ? 0 : 1}\n`,
      { mode: 0o755 },
    );
    if (bluetoothctl) fs.writeFileSync(path.join(dir, 'bluetoothctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'restorecon'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // dnf+rpm so linux-install.sh detects a PM and the run matches the Fedora box it targets.
    for (const bin of ['dnf', 'rpm']) {
      fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    for (const bin of ['tee', 'mkdir', 'dirname', 'grep', 'sed', 'awk', 'cat', 'rm', 'uname', 'tr', 'mktemp', 'cp', 'install', 'chmod']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const scriptFile = path.join(dir, 'rendered.sh');
    // Workstation profile: this script is gated behind is-desktop-linux and renders to zero bytes
    // on a server-profile host. See the `profile` note in tests/lib/render.js.
    fs.writeFileSync(scriptFile, renderFile(BT_SRC, { profile: 'workstation' }));
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, FAKE_ROOT: fakeRoot };
    return { scriptFile, env, logFile, fakeRoot };
  }

  const btRead = (fakeRoot, key) => fs.readFileSync(path.join(fakeRoot, BT_PATHS[key]), 'utf8');

  test('bt-hid-recovery.sh.tmpl: fresh box -> writes every artifact, enables the timer, reloads udev', { skip: skipDesktop }, () => {
    const { scriptFile, env, logFile, fakeRoot } = btSandbox();
    const { status } = runSh(scriptFile, env);
    const log = readLog(logFile);
    assert.strictEqual(status, 0, `expected success, log:\n${log}`);
    assert.ok(!log.includes('REFUSED'), `an unrecognised sudo verb escaped the sandbox:\n${log}`);

    for (const key of Object.keys(BT_PATHS)) {
      assert.ok(fs.existsSync(path.join(fakeRoot, BT_PATHS[key])), `${BT_PATHS[key]} was not written`);
    }

    // The watchdog is ordered After=bluetooth.service, so a blocking restart of that unit from
    // inside its own Type=oneshot can deadlock until TimeoutStartSec. --no-block is the fix and
    // dropping it would reintroduce a hang that only shows up during a real recovery.
    const watchdog = btRead(fakeRoot, 'script');
    assert.match(watchdog, /systemctl restart --no-block bluetooth/, 'the restart must not block');
    assert.match(watchdog, /MIN_RESTART_INTERVAL=600/, 'the restart-loop guard must survive');
    assert.match(watchdog, /00001812-0000-1000-8000-00805f9b34fb/, 'the HoG UUID filter must survive');

    const service = btRead(fakeRoot, 'service');
    assert.match(service, /After=bluetooth\.service/);
    assert.match(service, /StateDirectory=bt-hid-health/, 'systemd must own the stamp directory');
    assert.match(service, /TimeoutStartSec=/, 'the unit needs a bound so it can never hang forever');
    assert.match(btRead(fakeRoot, 'timer'), /OnUnitActiveSec=2min/);
    // One VID/PID keeps the rule inert on any machine without this dongle.
    assert.match(btRead(fakeRoot, 'udev'), /idVendor}=="0b05".*idProduct}=="190e"/);

    // The manual path. The plain unit honours MIN_RESTART_INTERVAL, so a key bound to it no-ops
    // for up to ten minutes in exactly the situation it would be pressed -- the forced unit is
    // what makes the Stream Deck key mean anything, and --force is the whole of the difference.
    const forceService = btRead(fakeRoot, 'forceService');
    assert.match(forceService, /ExecStart=\/usr\/local\/bin\/bt-hid-health --force/);
    assert.match(watchdog, /FORCE=1/, 'the watchdog must understand --force');
    assert.match(watchdog, /\[ "\$FORCE" -eq 0 \] && \[ -r "\$STAMP" \]/, '--force must bypass the rate limit');

    // The grant is permanent and authorises restarting a system service, so its scope is the
    // thing to pin: one unit, one verb, one named user. Widening any of those hands out control
    // of every unit on the box.
    const polkit = btRead(fakeRoot, 'polkit');
    assert.match(polkit, /action\.lookup\("unit"\) == "bt-hid-health-force\.service"/);
    assert.match(polkit, /action\.lookup\("verb"\) == "start"/);
    assert.match(polkit, /subject\.user == "[^"{}]+"/, 'the username must be rendered, not left as a template');
    assert.doesNotMatch(polkit, /isInGroup|subject\.user == "root"/, 'the grant must not widen past one user');

    assert.ok(log.includes('sudo chmod 0755 /usr/local/bin/bt-hid-health'), `watchdog left non-executable:\n${log}`);
    assert.ok(log.includes('sudo systemctl daemon-reload'), `units not reloaded:\n${log}`);
    assert.ok(log.includes('sudo systemctl enable --now bt-hid-health.timer'), `timer not enabled:\n${log}`);
    assert.ok(log.includes('sudo udevadm control --reload'), `udev not reloaded:\n${log}`);
  });

  test('bt-hid-recovery.sh.tmpl: no bluetoothctl -> exits without writing or probing sudo', { skip: skipDesktop }, () => {
    const { scriptFile, env, logFile, fakeRoot } = btSandbox({ bluetoothctl: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(path.join(fakeRoot, BT_PATHS.service)), 'nothing should be written without a BT stack');
    assert.strictEqual(readLog(logFile), '', 'the gate must run before sudo is probed');
  });

  test('bt-hid-recovery.sh.tmpl: systemd does not know bluetooth.service -> exits without probing sudo', { skip: skipDesktop }, () => {
    const { scriptFile, env, logFile, fakeRoot } = btSandbox({ btUnit: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.ok(!fs.existsSync(path.join(fakeRoot, BT_PATHS.service)));
    assert.strictEqual(readLog(logFile), '');
  });

  test('bt-hid-recovery.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipDesktop }, () => {
    const { scriptFile, env, fakeRoot } = btSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    // exit 0 here would be worse than a failed apply: run_onchange records success by hash, so
    // the watchdog would stay uninstalled until this script next changes.
    assert.strictEqual(status, 1);
    assert.ok(!fs.existsSync(path.join(fakeRoot, BT_PATHS.service)), 'nothing should be written without sudo');
  });
}

// 2i. os-linux/run_onchange_after_setup-inotify-limits.sh.tmpl -------------------------------
{
  const IN_SRC = path.join(SCRIPTS_DIR, 'os-linux', 'run_onchange_after_setup-inotify-limits.sh.tmpl');

  // Like dnf-speedups, this script's whole job is the resulting file, so its sudo stub DOES exec
  // the write -- asserting on argv alone would prove nothing about the config that comes out.
  // The whitelist is narrow in the same way, with one addition that matters more here than there:
  // `sysctl` is logged and NEVER exec'd. It is the one wrapped command that would change the real
  // machine (it writes /proc/sys), and the temp-dir redirection that makes install safe does not
  // protect it -- `sysctl -p <tempfile>` still applies the setting system-wide. Refusing to exec
  // it is the whole reason this stub is not simply dnf-speedups' one reused.
  const IN_SUDO_STUB = [
    '#!/bin/sh',
    'echo "sudo $*" >> "$STUB_LOG"',
    'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
    '  exit "${SUDO_PROBE_EXIT:-0}"',
    'fi',
    'for dest; do :; done',      // POSIX idiom for the last positional arg
    'if [ "$1" = mkdir ] && [ "$dest" = "$SYSCTL_DIR" ]; then',
    '  exec "$@"',
    'fi',
    'if [ "$1" = install ] && [ "$dest" = "$SYSCTL_CONF" ]; then',
    '  exec "$@"',
    'fi',
    // Logged above, deliberately not exec'd: see the note on this stub.
    'if [ "$1" = sysctl ]; then',
    '  exit "${SYSCTL_APPLY_EXIT:-0}"',
    'fi',
    'echo "stub sudo refused: $*" >&2',
    'exit 99',
    '',
  ].join('\n');

  function inSandbox({ seed = null } = {}) {
    const dir = tmpdir('inotify-');
    const sysctlDir = path.join(dir, 'sysctl.d');
    fs.mkdirSync(sysctlDir);
    const confFile = path.join(sysctlDir, '99-inotify.conf');
    if (seed !== null) fs.writeFileSync(confFile, seed);
    const logFile = path.join(dir, 'log.txt');
    fs.writeFileSync(logFile, '');
    fs.writeFileSync(path.join(dir, 'sudo'), IN_SUDO_STUB, { mode: 0o755 });
    for (const bin of ['cat', 'cmp', 'install', 'mkdir', 'mktemp', 'rm']) {
      fs.symlinkSync(realBin(bin), path.join(dir, bin));
    }
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, renderFile(IN_SRC));
    // SYSCTL_CONF is read by the stub, not by the script -- the script derives its own from
    // SYSCTL_DIR. The two must agree or the stub refuses the write the script actually makes.
    const env = { PATH: dir, HOME: dir, STUB_LOG: logFile, SYSCTL_DIR: sysctlDir, SYSCTL_CONF: confFile };
    return { scriptFile, env, logFile, confFile };
  }

  const readConf = (f) => fs.readFileSync(f, 'utf8');

  test('setup-inotify-limits.sh.tmpl: no drop-in -> writes it through sudo and applies it', { skip: skipWorkstation }, () => {
    const { scriptFile, env, logFile, confFile } = inSandbox();
    const { status, stdout } = runSh(scriptFile, env);
    assert.strictEqual(status, 0, `expected success, log:\n${readLog(logFile)}`);
    assert.ok(fs.existsSync(confFile), 'the drop-in should have been written');
    const log = readLog(logFile);
    assert.ok(log.includes('sudo install -m 0644'), `the write should go through sudo:\n${log}`);
    // Without this the new ceiling waits for a reboot while the starved app keeps failing.
    assert.ok(log.includes(`sudo sysctl -p ${confFile}`), `the value should be applied now:\n${log}`);
    // A process that already failed inotify_init() does not retry, so the restart notice is part
    // of the script's contract rather than decoration.
    assert.ok(/need restarting/.test(stdout), `expected the restart notice:\n${stdout}`);
  });

  test('setup-inotify-limits.sh.tmpl: sets max_user_instances to 1024, and does not set max_user_watches', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.ok(/^fs\.inotify\.max_user_instances\s*=\s*1024$/m.test(out), `expected the instance ceiling:\n${out}`);
    // The entire diagnosis was that instances are exhausted (119/128) while watches sit at 2392 of
    // 272131. Raising max_user_watches is the fix every guide to this symptom suggests and it fixes
    // nothing here, so a future edit that "helpfully" adds it should fail rather than pass quietly.
    // Matched as an assignment, not a substring: the header comment names it on purpose.
    assert.ok(!/^\s*fs\.inotify\.max_user_watches\s*=/m.test(out), `must not set the watch limit:\n${out}`);
  });

  test('setup-inotify-limits.sh.tmpl: second run over a converged file writes nothing and never probes sudo', { skip: skipWorkstation }, () => {
    const { scriptFile, env, logFile, confFile } = inSandbox();
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const afterFirst = readConf(confFile);
    fs.writeFileSync(logFile, '');
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
    assert.strictEqual(readConf(confFile), afterFirst, 'a converged file must not be rewritten');
    // `sudo -v` prompts for a password, so a no-op apply that probes it is a regression even
    // though the file is unchanged.
    assert.strictEqual(readLog(logFile), '', 'converged run must not touch sudo at all');
  });

  test('setup-inotify-limits.sh.tmpl: a stale value is rewritten', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox({ seed: 'fs.inotify.max_user_instances = 256\n' });
    assert.strictEqual(runSh(scriptFile, env).status, 0);
    const out = readConf(confFile);
    assert.ok(out.includes('1024'), `the new ceiling should replace the old:\n${out}`);
    assert.ok(!/=\s*256$/m.test(out), `the stale value should not survive:\n${out}`);
  });

  test('setup-inotify-limits.sh.tmpl: sudo unavailable -> exit 1 so the next apply retries', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    // exit 0 here would be worse than a failed apply: run_onchange records success by hash, so the
    // limit would stay unraised until this script next changes.
    assert.strictEqual(status, 1);
    assert.ok(!fs.existsSync(confFile), 'nothing should be written without sudo');
  });

  test('setup-inotify-limits.sh.tmpl: sysctl -p fails -> the file still lands and the failure is reported', { skip: skipWorkstation }, () => {
    const { scriptFile, env, confFile } = inSandbox();
    env.SYSCTL_APPLY_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    // The drop-in is the durable half and is correct on disk regardless; a failed apply costs a
    // reboot's delay, not the change. Failing the whole script here would strand the write it
    // already made, since run_onchange would retry a file that is already converged.
    assert.strictEqual(status, 0);
    assert.ok(fs.existsSync(confFile), 'the drop-in should survive a failed apply');
  });
}
