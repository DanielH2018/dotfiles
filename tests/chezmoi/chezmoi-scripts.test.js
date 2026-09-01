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
//
// This file holds Part 1 and the os-unix half of Part 2. The other behavior tests are split by
// the guard their scripts render behind: chezmoi-scripts-wsl.test.js (os-linux/wsl),
// chezmoi-scripts-linux.test.js (os-linux, any profile) and chezmoi-scripts-workstation.test.js
// (os-linux, workstation and desktop only). The sandbox helpers, the skip gates and the shared
// sudo stub are tests/lib/chezmoi-scripts.js.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { renderFile } = require('../lib/render');
const {
  REPO, SCRIPTS_DIR, skip, skipTty, tmpdir, realBin, readLog, runSh, SUDO_STUB,
} = require('../lib/chezmoi-scripts');

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

// --- Part 2: behavior tests, os-unix scripts -------------------------------------------------

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
