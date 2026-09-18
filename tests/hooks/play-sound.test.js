// Guard for the hook that plays Claude Code's event chimes.
//
// play-sound.sh used to fall back to `powershell.exe ... Media.SoundPlayer` when paplay was
// unavailable. This hook fires on every permission and idle prompt, and a Windows binary
// launched from a session whose owning wsl.exe has exited leaks a permanently spinning CPU
// thread per launch (microsoft/WSL#41173, measured here at ~12 leaked cores in 2.5h), which
// made this hook the single largest source of those leaks. The fallback is gone; the order is
// now paplay (WSLg) -> aplay -> terminal bell.
//
// Drives the REAL script against stub paplay/aplay on a stripped PATH. No sound is played.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shConstInt } = require('../lib/sh-const');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_play-sound.sh');
const BASH =['/usr/bin/bash', '/bin/bash'].find((p) => fs.existsSync(p));
const skip = BASH ? false : 'bash unavailable';

// The paplay branch needs the Windows media file the hook hardcodes, so that case only runs
// where /mnt/c is actually mounted.
const WIN_WAV = '/mnt/c/Windows/Media/chimes.wav';
const skipWsl = skip || (fs.existsSync(WIN_WAV) ? false : 'no /mnt/c/Windows/Media (not WSL)');

function sandbox({ paplay = true, aplay = true, pwPlay = false } = {}) {
  const dir = scratch(os.tmpdir(), 'playsound-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stub = (name) => fs.writeFileSync(
    path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n`, { mode: 0o755 },
  );
  if (paplay) stub('paplay');
  if (aplay) stub('aplay');
  if (pwPlay) stub('pw-play');
  // Bare-name powershell.exe would only ever be reachable through PATH; the absolute-path
  // form is caught by the source check below instead.
  stub('powershell.exe');
  return { bin, log };
}

// The desktop-Linux branches (paplay/pw-play against the freedesktop theme file) read a real
// file off the filesystem rather than a stub, so they only run where that theme is installed.
// This names the sample the `input` cue takes, since that is the cue the cases below play.
const THEME_SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga';
const skipTheme = skip || (fs.existsSync(THEME_SOUND) ? false : 'no freedesktop sound theme installed');

// Playback is backgrounded and the hook exits immediately, so the stub may not have written
// yet when the script returns. Poll briefly rather than sleeping a fixed amount.
//
// The ceiling is 10s, not the 0.5s it was: the stub is an orphaned /bin/sh racing ~1600 tests
// across every core, and under the full `node --test` run it lost often enough that this file
// passed on its own and failed in the suite. Only a test that genuinely fails pays the
// ceiling -- the loop returns as soon as the log has content.
function readLogSettled(log) {
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 1000; i++) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim()) break;
    nap(10);
  }
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

function launch(sb, arg = 'done', extraEnv = {}) {
  execFileSync(BASH, [HOOK, arg], {
    encoding: 'utf8',
    // The stub dir is the ENTIRE PATH: the hook resolves its players with `command -v` and
    // otherwise uses only builtins, and leaving /usr/bin on PATH would let a real paplay
    // installed on this box satisfy the branch the "absent" cases mean to disable.
    env: { PATH: sb.bin, STUB_LOG: sb.log, HOME: os.tmpdir(), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function run(sb, arg = 'done', extraEnv = {}) {
  launch(sb, arg, extraEnv);
  return readLogSettled(sb.log);
}

// Asserting that nothing was launched cannot go through readLogSettled. That loop exits
// early only when the log gains content, so a case expecting an empty log never breaks out
// and pays the whole ceiling on every green run -- 10s, which was 6% of the entire suite.
//
// Dropping to a shorter fixed wait would only move the problem: too short stops being a
// slow pass and starts being a silent false one, and the ceiling is 10s precisely because
// a fixed 0.5s proved unreliable under full-suite load.
//
// So wait on evidence instead of on the clock. A control sandbox that DOES launch is run
// immediately after, and its stub is the same thing -- an orphaned /bin/sh appending one
// line. Once the control has written, any spawn from the earlier run has had at least as
// long to show up, so an empty log means absence rather than impatience. On an idle box
// this returns in milliseconds, and it stretches itself under load rather than going red.
function runExpectingSilence(sb, arg = 'done', extraEnv = {}) {
  launch(sb, arg, extraEnv);
  // aplay is the one branch with no filesystem dependency -- it needs the binary on PATH
  // and nothing else -- so the control fires on any box, theme sounds installed or not.
  const control = sandbox({ paplay: false, aplay: true });
  launch(control, arg, extraEnv);
  assert.ok(readLogSettled(control.log).trim(),
    'the control never launched either, so this run proves nothing about silence');
  return fs.existsSync(sb.log) ? fs.readFileSync(sb.log, 'utf8') : '';
}

test('plays the Windows .wav natively through paplay', { skip: skipWsl }, () => {
  const sb = sandbox();
  // The hook only exports PULSE_SERVER when WSLg's socket exists; set it so the branch is
  // reachable on a box where WSLg is not running.
  const log = run(sb, 'done', { PULSE_SERVER: 'unix:/nonexistent/PulseServer' });
  assert.match(log, /^paplay .*Windows\/Media\/chimes\.wav/m, 'paplay gets the Windows media file');
  assert.doesNotMatch(log, /powershell/, 'no interop');
});

// The input cue used to be the bright `Windows Notify System Generic` / `message` blip, and
// this asserted it differed from the turn-complete cue. It deliberately does not any more: a
// bright blip at a low gain goes from loud to inaudible without passing through gentle, which
// is what made a 35% default unusable the first time it was tried. Both cues now play the
// softer sample, so what is worth pinning is that `input` never goes back to the bright one.
test('the input cue plays the softer sample, not the bright attention blip', { skip: skipWsl }, () => {
  const sb = sandbox();
  const log = run(sb, 'input', { PULSE_SERVER: 'unix:/nonexistent/PulseServer' });
  assert.match(log, /Windows\/Media\/chimes\.wav/, 'input gets the softer chime');
  assert.doesNotMatch(log, /Windows Notify System Generic\.wav/, 'not the bright attention blip');
});

test('without paplay it falls to aplay, never to powershell', { skip }, () => {
  const sb = sandbox({ paplay: false });
  const log = run(sb);
  assert.match(log, /^aplay /m, 'aplay is the next fallback');
  assert.doesNotMatch(log, /powershell/, 'the interop branch is gone, not merely deprioritized');
});

test('with no player at all it still exits 0', { skip }, () => {
  const sb = sandbox({ paplay: false, aplay: false });
  const log = runExpectingSilence(sb);
  assert.strictEqual(log.trim(), '', 'nothing was launched');
  // execFileSync would have thrown on a non-zero exit; a hook that fails is noise in the
  // transcript on every prompt.
});

// The volume cases below assert the ENCODED values — 22937 on paplay's 0-65536 linear scale,
// 0.350 as pw-play's float — and those stay written out. Computing them from the percentage
// here would just re-run the hook's own arithmetic, so the expectation would drift along with
// a broken conversion instead of catching it.
//
// What is worth pinning separately is the percentage they encode, and that it has exactly one
// home. It had two — `${CLAUDE_SOUND_VOLUME:-50}` and the validation fallback — where editing
// one would have made invalid input play at a different volume from the default, with nothing
// red. shConst throws on a second assignment, so this catches that shape coming back as well
// as a bare change of value, and it names which end drifted where a failed `--volume=32768`
// match does not.
test('the default volume has one home in the hook, and it is what the cases below encode', { skip }, () => {
  assert.strictEqual(shConstInt(HOOK, 'DEFAULT_VOLUME_PCT'), 35,
    'default volume changed: update the encoded 22937 / 13107 / 0.350 expectations below with it');
});

test('the cue plays at a reduced default volume, not full', { skip: skipTheme }, () => {
  const sb = sandbox({ paplay: true, aplay: false });
  const log = run(sb, 'input');
  // 35% of paplay's 0-65536 linear scale.
  assert.match(log, /^paplay .*--volume=22937\b/m, 'paplay gets a 35% default volume');
});

// The override value is deliberately not 35: it would then equal the default, so a broken override
// would still produce 32768 and the test would pass while asserting nothing.
test('CLAUDE_SOUND_VOLUME overrides the default volume', { skip: skipTheme }, () => {
  const sb = sandbox({ paplay: true, aplay: false });
  const log = run(sb, 'input', { CLAUDE_SOUND_VOLUME: '20' });
  assert.match(log, /^paplay .*--volume=13107\b/m, 'paplay gets the overridden 20% volume');
});

test('an invalid CLAUDE_SOUND_VOLUME falls back to the default', { skip: skipTheme }, () => {
  const sb = sandbox({ paplay: true, aplay: false });
  const bogus = run(sb, 'input', { CLAUDE_SOUND_VOLUME: 'loud' });
  assert.match(bogus, /^paplay .*--volume=22937\b/m, 'non-numeric input falls back to 35%');
  const oor = run(sb, 'input', { CLAUDE_SOUND_VOLUME: '250' });
  assert.match(oor, /^paplay .*--volume=22937\b/m, 'out-of-range input falls back to 35%');
});

test('pw-play gets a 0.0-1.0 float volume when paplay is absent', { skip: skipTheme }, () => {
  const sb = sandbox({ paplay: false, aplay: false, pwPlay: true });
  const log = run(sb, 'input');
  assert.match(log, /^pw-play .*--volume=0\.350\b/m, 'pw-play gets a 35% default volume as a float');
});

test('no executable line launches a Windows binary', { skip }, () => {
  // Comments still name powershell.exe — the leak is why the code looks like this — so only
  // executable lines are checked.
  const offenders = fs.readFileSync(HOOK, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .filter((l) => /\.exe\b/.test(l));
  assert.deepStrictEqual(offenders, [], 'play-sound.sh names no .exe outside comments');
});

// The no-player fallback is the only cue a headless box reached over ssh (daniel-box) can
// give, and it used to write to /dev/tty -- which a hook does not have. Claude Code runs
// hooks with no controlling terminal, so that open raised ENXIO and the bell vanished into
// the redirect. The fallback now resolves the pane from CLAUDE_PID the way
// warp-session-title.sh does, and this asserts the bell reaches that resolved target.
//
// The stub `ps` prints a traversal path rather than a tty name, so the hook's hardcoded
// "/dev/$pane_tty" lands on a writable temp file. A real `ps -o tty=` never prints this --
// it is the only way to observe the write without adding a test-only knob to the hook, and
// /dev/stdout cannot stand in because node's stdout is a socketpair, which reopens ENXIO.
test('with no player the bell goes to the pane resolved from CLAUDE_PID', { skip }, () => {
  const sb = sandbox({ paplay: false, aplay: false });
  const pane = path.join(path.dirname(sb.bin), 'pane');
  fs.writeFileSync(path.join(sb.bin, 'ps'), `#!/bin/sh\necho "../..${pane}"\n`, { mode: 0o755 });
  // Builtins only: the stub dir is the entire PATH, so a stub calling `cat` finds nothing.
  fs.writeFileSync(path.join(sb.bin, 'tr'), '#!/bin/sh\nwhile read -r l; do echo "$l"; done\n', { mode: 0o755 });
  execFileSync(BASH, [HOOK, 'input'], {
    encoding: 'utf8',
    env: { PATH: sb.bin, STUB_LOG: sb.log, HOME: os.tmpdir(), CLAUDE_PID: '4242' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.strictEqual(fs.readFileSync(pane, 'utf8'), '\x07',
    'the bell reached the pane resolved from CLAUDE_PID, not /dev/tty');
});
