// Drives the real set-clipboard behaviour in dot_tmux.conf: a real tmux server on a private
// socket, a real shell in the pane emitting a real OSC 52 escape.
//
// The bug this pins: tmux defaults set-clipboard to `external`, which sets the outer
// terminal's clipboard when TMUX copies but silently discards the escape when an APPLICATION
// emits it. Every TUI copy over ssh goes the application route, so with the default nothing
// ever reached Ghostty and the failure was invisible -- no error, no buffer, no clipboard.
//
// No pty here: `show-buffer` observes whether tmux accepted the sequence, which is the half
// of the behaviour that differs between the two settings. Whether the outer terminal then
// honours it is Ghostty's `clipboard-write`, not tmux's business.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const CONF = path.join(__dirname, '..', '..', 'home', 'dot_tmux.conf');
const have = (t) => { try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !have('tmux') ? 'tmux unavailable' : false;

const socks = [];
process.on('exit', () => {
  for (const s of socks) {
    try { execFileSync('tmux', ['-S', s, 'kill-server'], { stdio: 'ignore' }); } catch { /* already down */ }
    // The socket lives one level down in its own mkdtemp dir; killing the server unlinks
    // the socket but leaves that dir, so a clean run still leaked one per test -- 340 of
    // them had built up before anyone looked.
    fs.rmSync(path.dirname(s), { recursive: true, force: true });
  }
});

const tmux = (sock, ...args) => execFileSync('tmux', ['-S', sock, ...args], { encoding: 'utf8' });

// stderr silenced: the empty case writes `no buffers` before exiting non-zero.
const showBuffer = (sock) => {
  try {
    return execFileSync('tmux', ['-S', sock, 'show-buffer'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return ''; // `no buffers` exits non-zero
  }
};

// Starts a session, emits the escape, and returns its socket without waiting. `override`
// forces set-clipboard after the conf loads, which is how the mutation guard reproduces the
// old default without editing the file under test.
function emitOsc52(payload, override) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-clip-')), 's');
  socks.push(sock);
  tmux(sock, '-f', CONF, 'new-session', '-d', '-x', '80', '-y', '24');
  if (override) tmux(sock, 'set', '-g', 'set-clipboard', override);
  const b64 = Buffer.from(payload).toString('base64');
  tmux(sock, 'send-keys', `printf '\\033]52;c;${b64}\\007'`, 'Enter');
  return sock;
}

// Polls rather than sleeping a flat 2s, which is what both tests used to pay whether tmux
// had finished in 50ms or not. The ceiling only bounds a genuine failure.
async function waitForBuffer(sock) {
  for (let i = 0; i < 200; i += 1) {
    const buf = showBuffer(sock);
    if (buf) return buf;
    await sleep(10);
  }
  return showBuffer(sock);
}

test('the config sets set-clipboard on', { skip }, () => {
  assert.match(fs.readFileSync(CONF, 'utf8'), /^set -g set-clipboard on$/m);
});

test('an application OSC 52 write reaches the clipboard', { skip }, async () => {
  const sock = emitOsc52('copied-by-the-app');
  assert.strictEqual(await waitForBuffer(sock), 'copied-by-the-app');
  try { tmux(sock, 'kill-server'); } catch { /* already down */ }
});

test('and would not under the tmux default', { skip }, async () => {
  // The mutation guard. Without this, the test above would still pass if the config line were
  // deleted and some other default happened to accept the escape -- this proves the assertion
  // is actually sensitive to the setting, and documents the behaviour being worked around.
  //
  // Asserting an empty buffer cannot poll itself out early, so it would sit on the ceiling on
  // every green run. A control session started immediately AFTER this one, with the setting
  // on, gives it something to wait for instead: once the control has copied, this session has
  // had at least as long to, and an empty buffer means refusal rather than impatience.
  const subject = emitOsc52('copied-by-the-app', 'external');
  const control = emitOsc52('copied-by-the-control');
  assert.strictEqual(await waitForBuffer(control), 'copied-by-the-control',
    'the control never copied either, so this run proves nothing about the default');
  assert.strictEqual(showBuffer(subject), '');
  for (const s of [subject, control]) {
    try { tmux(s, 'kill-server'); } catch { /* already down */ }
  }
});
