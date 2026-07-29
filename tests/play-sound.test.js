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

const HOOK = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks', 'executable_play-sound.sh');
const BASH = ['/usr/bin/bash', '/bin/bash'].find((p) => fs.existsSync(p));
const skip = BASH ? false : 'bash unavailable';

// The paplay branch needs the Windows media file the hook hardcodes, so that case only runs
// where /mnt/c is actually mounted.
const WIN_WAV = '/mnt/c/Windows/Media/chimes.wav';
const skipWsl = skip || (fs.existsSync(WIN_WAV) ? false : 'no /mnt/c/Windows/Media (not WSL)');

const dirs = [];

function sandbox({ paplay = true, aplay = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playsound-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stub = (name) => fs.writeFileSync(
    path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n`, { mode: 0o755 },
  );
  if (paplay) stub('paplay');
  if (aplay) stub('aplay');
  // Bare-name powershell.exe would only ever be reachable through PATH; the absolute-path
  // form is caught by the source check below instead.
  stub('powershell.exe');
  return { bin, log };
}

// Playback is backgrounded and the hook exits immediately, so the stub may not have written
// yet when the script returns. Poll briefly rather than sleeping a fixed amount.
function readLogSettled(log) {
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim()) break;
    nap(10);
  }
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

function run(sb, arg = 'done', extraEnv = {}) {
  execFileSync(BASH, [HOOK, arg], {
    encoding: 'utf8',
    // The stub dir is the ENTIRE PATH: the hook resolves its players with `command -v` and
    // otherwise uses only builtins, and leaving /usr/bin on PATH would let a real paplay
    // installed on this box satisfy the branch the "absent" cases mean to disable.
    env: { PATH: sb.bin, STUB_LOG: sb.log, HOME: os.tmpdir(), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return readLogSettled(sb.log);
}

test('plays the Windows .wav natively through paplay', { skip: skipWsl }, () => {
  const sb = sandbox();
  // The hook only exports PULSE_SERVER when WSLg's socket exists; set it so the branch is
  // reachable on a box where WSLg is not running.
  const log = run(sb, 'done', { PULSE_SERVER: 'unix:/nonexistent/PulseServer' });
  assert.match(log, /^paplay .*Windows\/Media\/chimes\.wav/m, 'paplay gets the Windows media file');
  assert.doesNotMatch(log, /powershell/, 'no interop');
});

test('the input cue is a different sound from the turn-complete cue', { skip: skipWsl }, () => {
  const sb = sandbox();
  const log = run(sb, 'input', { PULSE_SERVER: 'unix:/nonexistent/PulseServer' });
  assert.match(log, /Windows Notify System Generic\.wav/, 'input gets the attention chime');
});

test('without paplay it falls to aplay, never to powershell', { skip }, () => {
  const sb = sandbox({ paplay: false });
  const log = run(sb);
  assert.match(log, /^aplay /m, 'aplay is the next fallback');
  assert.doesNotMatch(log, /powershell/, 'the interop branch is gone, not merely deprioritized');
});

test('with no player at all it still exits 0', { skip }, () => {
  const sb = sandbox({ paplay: false, aplay: false });
  const log = run(sb);
  assert.strictEqual(log.trim(), '', 'nothing was launched');
  // execFileSync would have thrown on a non-zero exit; a hook that fails is noise in the
  // transcript on every prompt.
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

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
