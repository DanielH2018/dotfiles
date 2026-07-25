// Render + behavior coverage for the ~20 bootstrap scripts under home/.chezmoiscripts/.
//
// Part 1 (render sweep): every *.sh.tmpl is discovered dynamically (so a newly added script
// is covered automatically), rendered via `chezmoi execute-template --source <repo>` (the
// --source flag makes `include` directives resolve against this worktree), and the output is
// checked with `bash -n`. Every *.ps1.tmpl is rendered only (no pwsh on this machine).
//
// Part 2 (behavior): the three riskiest scripts (chsh, sudo+/etc edits, sudo+systemctl) are
// driven as RENDERED scripts under a PATH-shim sandbox. PATH is fully REPLACED (not merely
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

const REPO = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO, 'home', '.chezmoiscripts');

let toolsOk = true;
try { execFileSync('chezmoi', ['--version'], { stdio: 'ignore' }); } catch { toolsOk = false; }
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'chezmoi/bash unavailable';

// The two scripts under os-linux/wsl/ open with `{{ if contains "microsoft" (lower
// .chezmoi.kernel.osrelease) }}`, so off WSL they render to an EMPTY string. The Part 2
// behavior tests would then run an empty script and read exit 0 / an empty stub log --
// failing on assertions about a script body that does not exist there, which is what the
// homelab (plain Ubuntu, same suite) hits. Gate them on the same fact the template keys off:
// os.release() is the same uname release chezmoi reads into .chezmoi.kernel.osrelease.
// Deliberately NOT gated on "did it render empty?" -- that would also silently skip on WSL if
// the guard itself broke, turning a real regression into a green run.
const skipWsl = skip || (/microsoft/i.test(os.release()) ? false : 'WSL-only script (renders empty off WSL)');

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

function renderTemplate(file) {
  return execFileSync('chezmoi', ['execute-template', '--source', REPO], {
    input: fs.readFileSync(file, 'utf8'), encoding: 'utf8',
  });
}

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

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
    const rendered = renderTemplate(file);
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
    renderTemplate(file);
  });
}

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
    const rendered = renderTemplate(SDS_SRC);
    const scriptFile = path.join(dir, 'rendered.sh');
    fs.writeFileSync(scriptFile, rendered);
    const env = {
      PATH: dir, HOME: dir, STUB_LOG: logFile,
      TEST_CURRENT_SHELL: currentShell === 'zsh' ? zshPath : currentShell,
    };
    return { scriptFile, env, logFile, zshPath };
  }

  test('set-default-shell.sh.tmpl: zsh not installed -> exits 0, skips, no chsh/sudo calls', { skip }, () => {
    const { scriptFile, env, logFile } = sdsSandbox({ zshInstalled: false });
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 0);
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

  test('set-default-shell.sh.tmpl: interactive + sudo available -> sudo chsh invoked with the zsh path', { skip }, () => {
    const { scriptFile, env, logFile, zshPath } = sdsSandbox();
    const { status } = runSh(scriptFile, env, { tty: true });
    assert.strictEqual(status, 0);
    const log = readLog(logFile);
    assert.ok(log.includes(`sudo chsh -s ${zshPath} testuser`), `expected sudo chsh call in log:\n${log}`);
  });

  test('set-default-shell.sh.tmpl: interactive + sudo unavailable -> falls back to plain chsh', { skip }, () => {
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
    const rendered = renderTemplate(CW_SRC);
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
    const rendered = renderTemplate(DW_SRC);
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
    const rendered = renderTemplate(PT_SRC);
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
