// Covers home/.chezmoiscripts/os-linux/run_onchange_after_setup-sudo-timestamp.sh.tmpl.
//
// The thing worth testing here is not "does it write two lines" — it is the staging dance.
// A malformed file in /etc/sudoers.d locks out every subsequent sudo, including the one that
// would repair it, so the script must never leave a bad file live and must roll back a good
// one that turns out to conflict. Those are the three failure paths below.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderTemplate, chezmoiAvailable } = require('../lib/render');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const SRC = srcPath('.chezmoiscripts', 'os-linux', 'run_onchange_after_setup-sudo-timestamp.sh.tmpl');
const body = fs.readFileSync(SRC, 'utf8');

// Renders a chezmoi template; skip cleanly where the binary isn't installed (minimal CI /
// sandbox) rather than failing with a spurious spawn ENOENT.
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

const DESIRED = 'Defaults timestamp_type=global\nDefaults timestamp_timeout=5\n';

// Real binaries the script needs; PATH is replaced wholesale by the stub dir, so anything
// not listed here and not stubbed simply won't exist.
const PASSTHROUGH = ['sh', 'cat', 'tee', 'mv', 'rm', 'chmod', 'mkdir'];

// sudo that authenticates and otherwise execs through, so `sudo tee` really writes.
const SUDO_OK = '[ "$1" = "-v" ] && exit 0; exec "$@"';
// sudo whose credential probe fails — the sudo-less defer path.
const SUDO_NONE = '[ "$1" = "-v" ] && exit 1; exec "$@"';

function runWithStubs(stubs) {
  const home = scratch(os.tmpdir(), 'sudo-ts-');
  const binDir = path.join(home, 'stubs');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of PASSTHROUGH) {
    let real;
    try { real = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(); } catch { continue; }
    if (real) fs.symlinkSync(real, path.join(binDir, name));
  }
  for (const [name, script] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  const sudoersD = path.join(home, 'sudoers.d');
  fs.mkdirSync(sudoersD, { recursive: true });
  const scriptFile = path.join(home, 'render.sh');
  fs.writeFileSync(scriptFile, renderTemplate(body));
  const out = execFileSync(path.join(binDir, 'sh'), ['-c', `sh ${JSON.stringify(scriptFile)} 2>&1; echo "EXIT:$?"`], {
    encoding: 'utf8',
    env: { HOME: home, PATH: binDir, SUDOERS_D: sudoersD },
  });
  const exitCode = Number((out.match(/EXIT:(\d+)\s*$/) || [])[1]);
  const final = path.join(sudoersD, '10-timestamp-global');
  const stage = path.join(sudoersD, '.10-timestamp-global.new');
  return {
    out,
    exitCode,
    finalExists: fs.existsSync(final),
    stageExists: fs.existsSync(stage),
    finalBody: fs.existsSync(final) ? fs.readFileSync(final, 'utf8') : null,
  };
}

// 1. Gating. The script must render to nothing anywhere it shouldn't run, so `chezmoi apply`
//    never executes it there. Asserted on the source rather than by re-rendering under a fake
//    profile, because .profile comes from chezmoi's config file and isn't env-overridable.
test('gated to Linux and the workstation profile', { skip }, () => {
  assert.match(body, /\{\{ if and \(eq \.chezmoi\.os "linux"\) \(eq \.profile "workstation"\) -\}\}/);
  const rendered = renderTemplate(body);
  if (process.platform !== 'linux') {
    assert.strictEqual(rendered.trim(), '', 'must render empty off Linux');
  }
});

// 2. The policy itself. `global` is the whole point — tty and ppid both fail under Claude's
//    shells — and the timeout must stay at sudo's default rather than being widened.
test('installs timestamp_type=global with an unwidened timeout', { skip }, () => {
  const rendered = renderTemplate(body);
  if (process.platform !== 'linux' || rendered.trim() === '') return;
  assert.match(rendered, /Defaults timestamp_type=global/);
  assert.match(rendered, /Defaults timestamp_timeout=5/);
  assert.doesNotMatch(rendered, /timestamp_timeout=(?!5\b)\d+/, 'timeout must not be widened past the default');
});

// 3. Happy path: the drop-in lands with exactly the desired content and the staged file is
//    cleaned up behind it.
test('writes the drop-in and leaves no staged file', { skip }, () => {
  if (process.platform !== 'linux' || renderTemplate(body).trim() === '') return;
  const r = runWithStubs({ sudo: SUDO_OK, visudo: 'exit 0', chown: 'exit 0' });
  assert.strictEqual(r.exitCode, 0, r.out);
  assert.ok(r.finalExists, 'drop-in must be installed');
  assert.strictEqual(r.finalBody, DESIRED);
  assert.ok(!r.stageExists, 'staged file must not survive a successful install');
});

// 4. A staged file that fails validation must never be renamed into place. This is the case
//    the dotted staging name exists for: sudo ignores names containing '.', so even the
//    pre-validation window is inert.
test('a staged file failing visudo -cf is discarded, not installed', { skip }, () => {
  if (process.platform !== 'linux' || renderTemplate(body).trim() === '') return;
  // Fails the staged file only, never `-cf -`: that spelling is the support probe, and a stub
  // that failed both would exercise the skip path below instead of the one this test is for.
  const r = runWithStubs({ sudo: SUDO_OK, visudo: '[ "$1" = "-cf" ] && [ "$2" != "-" ] && exit 1; exit 0', chown: 'exit 0' });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(!r.finalExists, 'must not install a file that failed validation');
  assert.ok(!r.stageExists, 'must clean up the staged file');
  assert.match(r.out, /failed validation; nothing changed/);
});

// 5. A drop-in that parses alone but breaks the full config must be rolled back — otherwise
//    sudo is unusable and the next apply cannot repair it.
test('a full-config failure after install rolls the drop-in back', { skip }, () => {
  if (process.platform !== 'linux' || renderTemplate(body).trim() === '') return;
  const r = runWithStubs({ sudo: SUDO_OK, visudo: '[ "$1" = "-c" ] && exit 1; exit 0', chown: 'exit 0' });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(!r.finalExists, 'must roll back a drop-in that breaks the full config');
  assert.match(r.out, /rolled back/);
});

// 6. No sudo: defer loudly and change nothing, so the next apply retries rather than the box
//    silently never getting the policy.
test('without sudo it defers and writes nothing', { skip }, () => {
  if (process.platform !== 'linux' || renderTemplate(body).trim() === '') return;
  const r = runWithStubs({ sudo: SUDO_NONE, visudo: 'exit 0', chown: 'exit 0' });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(!r.finalExists, 'must not install anything without sudo');
  assert.match(r.out, /sudo unavailable; deferring the sudo credential-timestamp policy/);
});

// 7. A sudo without timestamp_type — sudo-rs, which Ubuntu 26.04 selects through alternatives —
//    must skip rather than fail. The distinction that matters is the exit code: this script is a
//    run_onchange under `chezmoi apply`, so exiting non-zero here strands every later script,
//    which is exactly what happened on the 26.04 box before the probe existed.
test('a sudo that rejects timestamp_type is skipped, not failed', { skip }, () => {
  if (process.platform !== 'linux' || renderTemplate(body).trim() === '') return;
  // Mirrors sudo-rs: the probe on stdin is refused, everything else would have succeeded.
  const r = runWithStubs({ sudo: SUDO_OK, visudo: '[ "$2" = "-" ] && exit 1; exit 0', chown: 'exit 0' });
  assert.strictEqual(r.exitCode, 0, `must not abort the rest of chezmoi apply:\n${r.out}`);
  assert.ok(!r.finalExists, 'must not install a policy this sudo cannot parse');
  assert.ok(!r.stageExists, 'must not stage anything either — the probe runs before any write');
  assert.match(r.out, /skipping/);
});

// 8. The probe must cost no password prompt: it runs before require_sudo, so a box with no sudo
//    at all still reaches it. Without that ordering, a sudo-rs box would prompt for a password
//    and only then discover it had nothing to install.
test('the support probe runs before sudo is ever needed', { skip }, () => {
  if (process.platform !== 'linux' || renderTemplate(body).trim() === '') return;
  const r = runWithStubs({ sudo: SUDO_NONE, visudo: '[ "$2" = "-" ] && exit 1; exit 0', chown: 'exit 0' });
  assert.strictEqual(r.exitCode, 0, `an unsupported policy is a skip, with or without sudo:\n${r.out}`);
  assert.match(r.out, /skipping/);
  assert.doesNotMatch(r.out, /deferring/, 'must report the real reason, not a sudo deferral');
});

