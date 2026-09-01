// Shared machinery for the chezmoi-scripts*.test.js suites: the skip gates (with the reasoning
// each one carries), the PATH-shim sandbox helpers, and the sudo stub every behavior test builds
// on. The behavior tests drive RENDERED scripts with PATH fully REPLACED by a temp dir of stub
// executables that log their argv and exit 0/controllable, so no real chsh/sudo/systemctl call
// reaches the system whatever branch a test takes.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ptySkip } = require('./pty');

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

const SUDO_STUB = [
  '#!/bin/sh',
  'echo "sudo $*" >> "$STUB_LOG"',
  'if [ "$1" = "-v" ] || [ "$1" = "-n" ]; then',
  '  exit "${SUDO_PROBE_EXIT:-0}"',
  'fi',
  'exit "${SUDO_EXIT:-0}"',
  '',
].join('\n');

// Every sandbox is a mkdtemp under os.tmpdir(); one exit hook removes them all.
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

module.exports = {
  REPO, SCRIPTS_DIR,
  skip, skipWsl, skipLinux, skipWorkstation, skipDesktop, skipTty,
  tmpdir, realBin, readLog, runSh, SUDO_STUB,
};
