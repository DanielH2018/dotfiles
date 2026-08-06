// Regression guard for executable_claude-changelog-watch.
//
// Drives the ACTUAL script with stub claude/gh/notify-send on PATH, so it never spends a model
// session or touches the real state dir.
//
// The live daily run only ever exercises the happy path, and the branches it skips are the ones
// that quietly matter:
//
//   * the fallback state dir must be used INSTEAD of stubbing a vault -- common.sh exports
//     CLAUDE_VAULT_DIR only where the LLM Wiki exists, so a stub vault at ~/Documents/My_Vault
//     would also wake /lint, /healthcheck, /rebuild and /retract on a box with no wiki;
//   * the seeded note must carry the prepend marker and an EMPTY last_processed_version --
//     STEP 5 of the command prepends below that marker, so a seed without it has nowhere to
//     write, and a seed with a version pinned would skip the bootstrap review;
//   * seeding must never reach into a real vault, whose structure is the user's, not ours;
//   * every precondition must skip with status 0 -- state only advances on a completed run, so
//     a missed morning is self-healing, but a failed unit leaves a red timer that gets disabled;
//   * an unauthenticated gh must skip BEFORE claude runs, or the session burns tokens only to
//     fail at STEP 2 against a locked keyring;
//   * a changed note must open the rendered artifact, and an unchanged one must do nothing at
//     all -- the command prepends nothing when there are no new versions, and that byte-identity
//     is the only signal worth interrupting anyone over;
//   * a changed note with no artifact must still notify -- the proposals exist either way, and
//     silence would be the one outcome that loses them.
//
// Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-changelog-watch');
const NOTE_REL = path.join('Meta', 'Claude_Code_Changelog_Watch.md');

let bashOk = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { bashOk = false; }

// The script is Linux-side (see its header) and locks via flock(1), which util-linux ships on
// Linux but macOS does not have out of the box. Without it every run's `flock -n 9` fails for
// "command not found", indistinguishable from real contention, so every test would skip on
// "another run holds" the lock rather than exercising anything.
let flockOk = true;
try { execFileSync('bash', ['-c', 'command -v flock'], { stdio: 'ignore' }); } catch { flockOk = false; }

const skip = !bashOk ? 'bash unavailable' : !flockOk ? 'flock unavailable' : false;

const dirs = [];

function mkdtemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// `claudeWrites` simulates the command having prepended a proposals section: the runner decides
// whether to notify by hashing the note either side of the session, not by reading its output.
// `claudeRenders` simulates STEP 6 writing the HTML to the path the runner exported.
function makeStubs({ ghOk, claudeWrites, claudeRenders }) {
  const bin = mkdtemp('cw-bin-');
  const marks = mkdtemp('cw-marks-');
  const log = path.join(marks, 'calls');

  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
printf 'gh %s\\n' "$*" >> "${log}"
exit ${ghOk ? 0 : 1}
`, { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/bash
printf 'claude %s\\n' "$*" >> "${log}"
if [ -n "\${CW_NOTE:-}" ] && [ "${claudeWrites ? 1 : 0}" = 1 ]; then
  printf '### 2026-08-05 — reviewed 2.1.220..2.1.222\\n' >> "$CW_NOTE"
fi
if [ -n "\${CLAUDE_CHANGELOG_ARTIFACT:-}" ] && [ "${claudeRenders ? 1 : 0}" = 1 ]; then
  printf '<h1>proposals</h1>\\n' > "$CLAUDE_CHANGELOG_ARTIFACT"
fi
exit 0
`, { mode: 0o755 });

  for (const name of ['notify-send', 'xdg-open', 'systemd-run']) {
    // systemd-run is stubbed rather than left to the real one: unstubbed it would try to reach a
    // user manager that a test environment need not have, and on a box that does have one it
    // would genuinely launch a browser.
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash
printf '${name} %s\\n' "$*" >> "${log}"
exit 0
`, { mode: 0o755 });
  }

  return { bin, log };
}

function run({ ghOk = true, claudeWrites = false, claudeRenders = false, vaultDir = null } = {}) {
  const { bin, log } = makeStubs({ ghOk, claudeWrites, claudeRenders });
  const home = mkdtemp('cw-home-');
  const state = mkdtemp('cw-state-');
  const runtime = mkdtemp('cw-run-');
  const stateVault = path.join(state, 'claude-changelog-watch');

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_STATE_HOME: state,
    XDG_RUNTIME_DIR: runtime,
    // The stub claude needs to know which note to mutate; the runner exports the resolved vault
    // itself, but only after the arm that picked it, so pass the expected path in directly.
    CW_NOTE: path.join(vaultDir || stateVault, NOTE_REL),
  };
  if (vaultDir) env.CLAUDE_VAULT_DIR = vaultDir;

  const res = { status: 0, out: '' };
  try {
    res.out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
  } catch (e) {
    res.status = e.status;
    res.out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  res.calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  res.stateVault = stateVault;
  res.home = home;
  return res;
}

function readNote(vault) {
  const p = path.join(vault, NOTE_REL);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

test('no wiki on the box -> seeds a private state dir, not a vault', { skip }, () => {
  const { status, stateVault, home } = run();
  assert.strictEqual(status, 0);
  assert.ok(readNote(stateVault), 'the note must be seeded in the state dir');
  assert.ok(
    !fs.existsSync(path.join(home, 'Documents', 'My_Vault')),
    'a stub vault would wake /lint, /healthcheck, /rebuild and /retract on a wiki-less box',
  );
});

test('the seeded note carries the prepend marker and an empty version', { skip }, () => {
  const { stateVault } = run();
  const note = readNote(stateVault);
  assert.match(note, /<!-- \/changelog-watch prepends/, 'STEP 5 prepends below this marker');
  assert.match(note, /last_processed_version: ""/, 'an empty version is the documented bootstrap');
});

test('CLAUDE_VAULT_DIR pointing at a real vault is never seeded into', { skip }, () => {
  const vault = mkdtemp('cw-vault-');
  const { status, calls } = run({ vaultDir: vault });
  assert.strictEqual(status, 0);
  assert.strictEqual(readNote(vault), null, 'a real vault structure is the user\'s to create');
  assert.doesNotMatch(calls, /^claude /m, 'with no note there is nothing to review');
});

test('a CLAUDE_VAULT_DIR that does not exist skips instead of failing', { skip }, () => {
  const missing = path.join(mkdtemp('cw-gone-'), 'nope');
  const { status, out, calls } = run({ vaultDir: missing });
  assert.strictEqual(status, 0, 'a red timer gets disabled, and then reviews nothing');
  assert.match(out, /skip:/);
  assert.doesNotMatch(calls, /^claude /m);
});

test('unauthenticated gh skips before a session is spent', { skip }, () => {
  const { status, out, calls } = run({ ghOk: false });
  assert.strictEqual(status, 0);
  assert.match(out, /gh not authenticated/);
  assert.doesNotMatch(calls, /^claude /m, 'the probe exists to not burn a session on a locked keyring');
});

test('an unchanged note reports no new entries and stays silent', { skip }, () => {
  const { status, out, calls } = run({ claudeWrites: false });
  assert.strictEqual(status, 0);
  assert.match(calls, /^claude /m, 'the session must actually have run');
  assert.match(out, /no new changelog entries/);
  assert.doesNotMatch(calls, /notify-send/, 'a no-op run is not worth interrupting anyone over');
  assert.doesNotMatch(calls, /xdg-open/, 'nor worth putting a browser window on screen for');
});

test('a changed note opens the rendered artifact', { skip }, () => {
  const { status, out, calls } = run({ claudeWrites: true, claudeRenders: true });
  assert.strictEqual(status, 0);
  assert.match(out, /new proposals in/);
  assert.match(calls, /systemd-run .*xdg-open .*changelog-watch_/, 'a browser launched inside the oneshot cgroup dies when the unit exits');
  assert.doesNotMatch(calls, /notify-send/, 'the artifact is on screen; a notification about it is noise');
});

test('the opened path is the one the runner exported, never a glob of the newest', { skip }, () => {
  // en-CA is YYYY-MM-DD in *local* time, which is what the runner's `date +%F` gives it;
  // toISOString would be UTC and disagree either side of midnight.
  const today = new Date().toLocaleDateString('en-CA');
  const { calls, home } = run({ claudeWrites: true, claudeRenders: true });
  const expected = path.join(home, '.claude', 'artifacts', `changelog-watch_${today}.html`);
  assert.ok(fs.existsSync(expected), 'the session writes to CLAUDE_CHANGELOG_ARTIFACT');
  assert.ok(calls.includes(expected), 'a stale artifact must never be opened as this morning\'s proposals');
});

test('a changed note with no artifact falls back to the notification', { skip }, () => {
  const { status, out, calls } = run({ claudeWrites: true, claudeRenders: false });
  assert.strictEqual(status, 0);
  assert.match(out, /notifying instead/);
  assert.match(calls, /notify-send .*reviewed 2\.1\.220\.\.2\.1\.222/, 'the proposals exist whether or not they were rendered');
  assert.doesNotMatch(calls, /xdg-open/);
});

process.on('exit', () => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
