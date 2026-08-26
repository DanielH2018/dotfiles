// Regression guard for executable_notify.sh, specifically the idle_prompt gate.
//
// Drives the ACTUAL hook against a fake $HOME whose play-sound.sh is a stub, so the assertion
// is "did the cue fire", not "did a sound come out". Offline and deterministic.
//
// The property under test is not a case list. idle_prompt means opposite things depending on
// who raised it: a background job saying "waiting for your input" is asking you a question and
// owns no pane to show it in, while a foreground session raises the same type 60s after every
// finished turn. Chiming on both is the noise that got idle_prompt excluded outright; chiming
// on neither is what left background jobs silent. The gate is the jobs directory.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const HOOK = path.join(HOOKS, 'executable_notify.sh');
const LIB = path.join(HOOKS, 'hook-input.sh');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/jq unavailable';

// The hook has three branches and the banner is absent from one of them on purpose: under WSL it
// plays the Windows cue and draws no banner at all, because notify-send has no daemon there. So
// there is no banner tool to stub and nothing to assert -- only the banner test skips, and every
// sound assertion still runs, which is the half of the cue WSL does have.
//
// Reads the same file the hook branches on rather than os.release(), so a host the hook treats as
// WSL is one this suite treats as WSL too. Getting that split wrong is what made the banner test
// fail on every WSL box while asserting nothing about a real regression.
const onWsl = (() => {
  try { return /microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')); } catch { return false; }
})();
const skipBanner = skip || (onWsl ? 'WSL draws no banner by design (notify-send has no daemon there)' : false);

const dirs = [];

// A fake $HOME with a stubbed play-sound.sh. `job` creates the jobs directory that marks the
// notifying session as a background job, which is exactly what the gate looks for.
//
// The banner tools are stubbed too, on PATH. play-sound.sh resolves through $HOME, so the fake
// home alone accounts for it, but notify-send and osascript resolve through PATH: unstubbed,
// every run of this suite drew a real desktop notification titled "t" at whoever ran the tests.
// Which tools get stubbed is per-platform on purpose. The hook picks its branch with
// `command -v osascript`, so an osascript stub on Linux would send it down the macOS path and
// this suite would stop exercising the branch that actually runs here.
//
// Each stub writes to the log for the half of the cue it IS, which is not the same split as
// sound-vs-banner-tool. On macOS the hook never calls play-sound.sh: `afplay` is the sound,
// called directly so the audible cue does not depend on Notification Center delivery. Sending
// it to the banner log would leave the played log empty on a Mac, and every sound assertion
// below would fail there for a reason that is not a regression.
const STUBS = process.platform === 'darwin'
  ? { osascript: 'banners', afplay: 'played' }
  : { 'notify-send': 'banners' };

// Sleep without a timer, so `run` stays synchronous like the tests that call it.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run({ type, sid, job }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  dirs.push(home);
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const played = path.join(home, 'played.log');
  fs.writeFileSync(path.join(hooks, 'play-sound.sh'),
    `#!/bin/sh\necho "play $*" >> "${played}"\n`, { mode: 0o755 });
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const banners = path.join(home, 'banners.log');
  const logs = { played, banners };
  for (const [tool, log] of Object.entries(STUBS)) {
    // A stub on the played log has to match what the sound assertions look for, which is the
    // `play ` prefix play-sound.sh itself writes -- not the tool's own name.
    const line = log === 'played' ? `play ${tool} $*` : `${tool} $*`;
    fs.writeFileSync(path.join(bin, tool),
      `#!/bin/sh\necho "${line}" >> "${logs[log]}"\n`, { mode: 0o755 });
  }
  if (job) fs.mkdirSync(path.join(home, '.claude', 'jobs', sid.split('-')[0]), { recursive: true });
  try {
    execFileSync('bash', [HOOK], {
      input: JSON.stringify({ notification_type: type, session_id: sid, message: 'm', title: 't' }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // The stub bin is PREPENDED, never substituted: the hook reads its input through jq from
      // the real PATH, and the skip guard above is what decides what a missing jq means.
      env: {
        ...process.env,
        HOME: home,
        HOOK_INPUT_LIB: LIB,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
  } catch { /* a non-zero exit is itself a failure the assertions below will show */ }
  // macOS backgrounds the sound (`afplay ... &`), so its write can land after bash returns.
  // Only an absent log needs waiting on; one that already exists is the answer.
  if (process.platform === 'darwin') {
    for (let i = 0; i < 50 && !fs.existsSync(played); i += 1) sleep(20);
  }
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { played: read(played), banners: read(banners) };
}

test('a background job going idle makes a sound', { skip }, () => {
  const { played } = run({ type: 'idle_prompt', sid: '664f7ae8-1fde-4339-b7d3-4441f18687a1', job: true });
  assert.match(played, /^play /m, 'the job asking for input is the case the cue exists for');
});

// The banner is the other half of the cue. Asserting on it is also what keeps the stubs above
// load-bearing: a stub nothing reads gets deleted as scaffolding a release later, and the
// suite goes back to notifying the desktop.
test('the banner carries the title and message the hook was given', { skip: skipBanner }, () => {
  const { banners } = run({ type: 'permission_prompt', sid: '7e1ec437-5939-48b5-9dcd-e97c32f9242b', job: false });
  assert.match(banners, /\bt m\b/, 'the notification tool is called with the payload title and message');
});

test('a foreground session going idle stays silent', { skip }, () => {
  const { played, banners } = run({ type: 'idle_prompt', sid: '7e1ec437-5939-48b5-9dcd-e97c32f9242b', job: false });
  assert.strictEqual(played, '', 'a cue 60s after every finished turn is the noise, not the signal');
  assert.strictEqual(banners, '', 'the gate exits before the banner too, not just before the sound');
});

// The gate is scoped to idle_prompt alone: the other two types mean "blocked on you" whoever
// raised them, so a missing jobs directory must not silence them.
test('permission_prompt and agent_needs_input are not gated on the jobs directory', { skip }, () => {
  for (const type of ['permission_prompt', 'agent_needs_input']) {
    const { played } = run({ type, sid: '7e1ec437-5939-48b5-9dcd-e97c32f9242b', job: false });
    assert.match(played, /^play /m, `${type} must sound from a session that is not a job`);
  }
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
