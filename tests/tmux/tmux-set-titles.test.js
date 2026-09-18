// Drives the real title-forwarding behaviour in dot_tmux.conf: a real tmux server on a
// private socket, a real shell in the pane emitting a real OSC 0 escape.
//
// The chain this pins: warp-session-title.sh writes OSC 0 so Warp labels the session's
// sidebar row. Inside tmux that escape sets tmux's own pane_title and stops there, so a
// Claude session on daniel-box would leave its row showing the bare ssh command. `set-titles
// on` plus `set-titles-string '#{pane_title}'` forwards it back out to Warp.
//
// The failure this guards is silent in both directions -- nothing errors, the row just keeps
// the wrong label -- so the assertions are on tmux's own state rather than on anything
// rendered. Whether Warp then paints the row is Warp's business, not tmux's.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { have } = require('../lib/probe');

const CONF = path.join(__dirname, '..', '..', 'home', 'dot_tmux.conf');
const skip = !have('tmux') ? 'tmux unavailable' : false;

const socks = [];
process.on('exit', () => {
  for (const s of socks) {
    try { execFileSync('tmux', ['-S', s, 'kill-server'], { stdio: 'ignore' }); } catch { /* already down */ }
    fs.rmSync(path.dirname(s), { recursive: true, force: true });
  }
});

// The pane title below carries U+00B7, and tmux decides whether to render a non-ASCII
// character or substitute `_` from whether LC_ALL/LC_CTYPE/LANG name a UTF-8 locale. That is
// the *reading* client's decision, not the server's: pane_title holds the right bytes either
// way, and only `display-message -p` mangles them. So a runner whose environment has no
// locale set — a launchd job, a CI container, or a tool-driven shell, all of which this suite
// has hit — failed these tests over its own environment rather than over tmux's behaviour.
//
// LC_ALL is pinned here rather than left to the ambient environment for that reason. The
// value need not be a locale the host has generated: tmux substring-matches these variables
// for "UTF-8"/"UTF8" instead of calling setlocale, so C.UTF-8 works on a host that lists it
// and on one that does not.
const tmux = (sock, ...args) =>
  execFileSync('tmux', ['-S', sock, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  });

function newSession() {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-titles-')), 's');
  socks.push(sock);
  tmux(sock, '-f', CONF, 'new-session', '-d', '-x', '80', '-y', '24');
  return sock;
}

// Polls rather than sleeping flat: tmux usually applies the escape within a few ms, and the
// ceiling only bounds a genuine failure.
async function waitForPaneTitle(sock, want) {
  for (let i = 0; i < 200; i += 1) {
    const got = tmux(sock, 'display-message', '-p', '#{pane_title}').trim();
    if (got === want) return got;
    await sleep(10);
  }
  return tmux(sock, 'display-message', '-p', '#{pane_title}').trim();
}

test('the config turns set-titles on', { skip }, () => {
  // Default is off, which is the whole bug: the escape lands in pane_title and never leaves.
  const sock = newSession();
  assert.strictEqual(tmux(sock, 'show-options', '-gv', 'set-titles').trim(), 'on');
});

test('the config forwards the pane title, not a decorated string', { skip }, () => {
  // tmux's default set-titles-string is '#S:#I:#W - "#T" #{session_alerts}'. Warp renders the
  // row label verbatim, so anything but a bare #{pane_title} puts session/window bookkeeping
  // in front of the state word the label exists to show.
  const sock = newSession();
  assert.strictEqual(tmux(sock, 'show-options', '-gv', 'set-titles-string').trim(), '#{pane_title}');
});

test('an OSC 0 escape from inside a pane reaches pane_title', { skip }, async () => {
  // The half of the chain tmux owns. warp-session-title.sh emits exactly this shape.
  const sock = newSession();
  tmux(sock, 'send-keys', "printf '\\033]0;working \\302\\267 chezmoi\\007'", 'Enter');
  assert.strictEqual(await waitForPaneTitle(sock, 'working · chezmoi'), 'working · chezmoi');
});

test('a later escape replaces the label rather than appending', { skip }, async () => {
  // Every state transition rewrites the same row, so a pane that accumulated titles would
  // read "working · x" long after the turn finished.
  const sock = newSession();
  tmux(sock, 'send-keys', "printf '\\033]0;working \\302\\267 chezmoi\\007'", 'Enter');
  await waitForPaneTitle(sock, 'working · chezmoi');
  tmux(sock, 'send-keys', "printf '\\033]0;done \\302\\267 chezmoi\\007'", 'Enter');
  assert.strictEqual(await waitForPaneTitle(sock, 'done · chezmoi'), 'done · chezmoi');
});
