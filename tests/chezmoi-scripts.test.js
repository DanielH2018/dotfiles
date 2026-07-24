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

  test('configure-wsl.sh.tmpl: sudo unavailable -> defers with exit 1, nothing else attempted', { skip }, () => {
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
  test('debloat-wsl.sh.tmpl: sudo unavailable -> defers with exit 1 before masking anything', { skip }, () => {
    const { scriptFile, env, logFile } = dwSandbox();
    env.SUDO_PROBE_EXIT = '1';
    const { status } = runSh(scriptFile, env);
    assert.strictEqual(status, 1);
    assert.strictEqual(readLog(logFile).trim(), 'sudo -v');
  });

  test('debloat-wsl.sh.tmpl: masks an existing unmasked unit, skips missing/already-masked units', { skip }, () => {
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
