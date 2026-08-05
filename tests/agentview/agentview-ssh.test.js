// Multiplexing, per-host caches, and fetch-outcome recording.
//
// ssh is invoked by BARE NAME in refresh_remote and focus.sh, so a PATH stub shadows it and
// no test here touches the network. The stub records its argv, which is what every
// assertion below reads.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { agentviewWinSeams } = require('../lib/agentview-env');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'home', 'dot_local', 'bin', 'executable_agentview');
const LIB = path.join(ROOT, 'home', 'dot_local', 'share', 'agentview');

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Builds a HOME, a PATH dir, and an ssh stub that appends its argv to argvLog, one call per
// line. `body` is the stub's exit behaviour: default succeeds and prints nothing.
function env({ sshBody = 'exit 0', watchInterval = '1' } = {}) {
  const home = scratch('av-home-');
  const bin = scratch('av-bin-');
  const argvLog = path.join(home, 'ssh-argv.log');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n${sshBody}\n`,
    { mode: 0o755 });
  const seams = agentviewWinSeams({ bin, scratch });
  return {
    home, bin, argvLog,
    run(args) {
      return execFileSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env, ...seams.env,
          HOME: home, AV_LIB: LIB,
          PATH: `${bin}:${process.env.PATH}`,
          AGENT_VIEW_WATCH_INTERVAL: watchInterval,
        },
      });
    },
    sshCalls() {
      if (!fs.existsSync(argvLog)) return [];
      return fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
    },
  };
}

test('the refresh passes multiplexing options to ssh', () => {
  const e = env();
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  const calls = e.sshCalls();
  assert.ok(calls.length > 0, 'expected at least one ssh call');
  for (const c of calls) {
    assert.match(c, /ControlMaster=auto/, `no ControlMaster in: ${c}`);
    assert.match(c, /ControlPath=/, `no ControlPath in: ${c}`);
    assert.match(c, /ControlPersist=/, `no ControlPersist in: ${c}`);
  }
});

test('the ConnectTimeout bound survives alongside multiplexing', () => {
  // A warm master must never turn a dead host into a hung picker.
  const e = env();
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  for (const c of e.sshCalls()) assert.match(c, /ConnectTimeout=/, `no ConnectTimeout in: ${c}`);
});

test('the control socket path stays under HOME, not /mnt', () => {
  const e = env();
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  const calls = e.sshCalls();
  assert.ok(calls.length > 0, 'expected at least one ssh call');
  const c = calls[0];
  const m = /ControlPath=(\S+)/.exec(c);
  assert.ok(m, `no ControlPath in: ${c}`);
  assert.ok(!m[1].startsWith('/mnt/'), `control socket must not live on /mnt: ${m[1]}`);
});

test('keepalive options detect dead peers on established connections', () => {
  // ConnectTimeout covers establishing a NEW connection. ServerAliveInterval +
  // ServerAliveCountMax detect a stalled read against an already-established ControlPersist
  // master whose peer has gone away. Both are necessary to fail fast.
  const e = env();
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  const calls = e.sshCalls();
  assert.ok(calls.length > 0, 'expected at least one ssh call');
  for (const c of calls) {
    assert.match(c, /ServerAliveInterval=/, `no ServerAliveInterval in: ${c}`);
    assert.match(c, /ServerAliveCountMax=/, `no ServerAliveCountMax in: ${c}`);
  }
});

test('the interactive attach reuses the same control socket', () => {
  // The jump is the latency the user actually reported. It must share the master the refresh
  // opened, or the first jump after a refresh still pays a handshake.
  const e = env();
  const US = '\x1f';
  const key = ['daniel-server', '/home/daniel/x', 'working', '0', 't', '', 'host', 'tmux:%1'].join(US);
  try {
    e.run(['--jump', key]);
  } catch {
    // Jump may fail with "no pane found", which is expected. We care about ssh being called.
  }
  const calls = e.sshCalls();
  assert.ok(calls.length > 0, 'expected an ssh call for a remote jump');
  assert.match(calls[0], /ControlPath=/, `attach did not multiplex: ${calls[0]}`);
});

test('the attach does not inherit BatchMode', () => {
  // BatchMode on an interactive attach turns "ask for the passphrase" into "fail".
  const e = env();
  const US = '\x1f';
  const key = ['daniel-server', '/home/daniel/x', 'working', '0', 't', '', 'host', 'tmux:%1'].join(US);
  try {
    e.run(['--jump', key]);
  } catch {
    // Jump may fail with "no pane found", which is expected. We care about ssh being called.
  }
  const calls = e.sshCalls();
  assert.ok(calls.length > 0, 'expected an ssh call for a remote jump');
  assert.doesNotMatch(calls[0], /BatchMode/, 'attach must not set BatchMode');
});

test('daniel-box is registered with the display label Box', () => {
  // host_label() falls back to ${1#daniel-}, which would render a lowercase "box" without an
  // explicit entry. The label is the visible half of this task.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /HOST_SSH=\([^)]*\[daniel-box\]/, 'daniel-box missing from HOST_SSH');
  assert.match(src, /HOST_LABEL=\([^)]*\[daniel-box\]="Box"/, 'daniel-box must be labelled Box');
});

test('each host gets its own cache file', () => {
  const e = env({ sshBody: `printf '%s\\n' '{"session":"s1","state":"working","ts":1,"kind":"host"}'` });
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  for (const h of ['daniel-server', 'daniel-box']) {
    assert.ok(fs.existsSync(path.join(e.home, `.agentview-remote-cache.${h}`)), `no cache for ${h}`);
  }
});

test('a host that cannot be reached is recorded unreachable and keeps its rows', () => {
  // rc 255 is ssh's "could not connect". The previous snapshot is the best data we have.
  const e = env();
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');
  const bin = e.bin;
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\nexit 255\n', { mode: 0o755 });

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  const status = fs.readFileSync(path.join(e.home, '.agentview-remote-status.daniel-server'), 'utf8');
  assert.match(status, /^unreachable\t\d+/, `expected unreachable, got: ${status}`);
  assert.match(fs.readFileSync(cache, 'utf8'), /"session":"old"/, 'rows must survive an unreachable host');
});

test('a host that connects but returns nothing is recorded failed, not empty', () => {
  // The silent bug: rc != 255 with empty output used to overwrite the cache with nothing, so
  // the rows vanished and the UI said the same thing it says when there genuinely are none.
  const e = env();
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');
  fs.writeFileSync(path.join(e.bin, 'ssh'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  const status = fs.readFileSync(path.join(e.home, '.agentview-remote-status.daniel-server'), 'utf8');
  assert.match(status, /^failed\t\d+/, `expected failed, got: ${status}`);
  assert.match(fs.readFileSync(cache, 'utf8'), /"session":"old"/, 'rows must survive a failed fetch');
});

test('a successful fetch records ok and replaces the rows', () => {
  const e = env({ sshBody: `printf '%s\\n' '{"session":"new","state":"working","ts":9,"kind":"host"}'` });
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  assert.match(fs.readFileSync(path.join(e.home, '.agentview-remote-status.daniel-server'), 'utf8'), /^ok\t\d+/);
  const body = fs.readFileSync(cache, 'utf8');
  assert.match(body, /"session":"new"/);
  assert.doesNotMatch(body, /"session":"old"/, 'a successful fetch replaces the snapshot');
});

test('a successful fetch with an empty roster replaces the cache, not just a nonempty one', () => {
  // The distinction the outcome split exists for: rc 0 + no output is a genuinely empty
  // roster, not a failure, and must overwrite the old snapshot the same as a nonempty one.
  const e = env({ sshBody: 'exit 0' });
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  assert.match(fs.readFileSync(path.join(e.home, '.agentview-remote-status.daniel-server'), 'utf8'), /^ok\t\d+/);
  assert.doesNotMatch(fs.readFileSync(cache, 'utf8'), /"session":"old"/, 'an empty successful fetch replaces the snapshot');
});

test('one host failing does not blank the other', () => {
  // The reason the cache had to split. A shared file meant the last writer won.
  const e = env({ sshBody: `case "$*" in *daniel-box*) exit 255 ;; esac\nprintf '%s\\n' '{"session":"s","state":"working","ts":1,"kind":"host"}'` });
  fs.writeFileSync(path.join(e.home, '.agentview-remote-cache.daniel-box'),
    '{"session":"boxrow","state":"working","ts":1,"kind":"host"}\n');

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  assert.match(fs.readFileSync(path.join(e.home, '.agentview-remote-cache.daniel-box'), 'utf8'), /boxrow/);
  assert.match(fs.readFileSync(path.join(e.home, '.agentview-remote-cache.daniel-server'), 'utf8'), /"session":"s"/);
});

test('a cache write that fails does not record ok, so a stale cache reads as stale', () => {
  // ssh succeeds and the temp cache write succeeds, but the final `mv` into place fails --
  // the ENOSPC / read-only-$HOME case. A PATH-shadowing `mv` stub forces that deterministically,
  // the same technique the suite already uses to shadow ssh. Without the fix, `ok\t<now>` gets
  // written unconditionally right after this, so the host would read fresh while its cache is
  // still the old snapshot -- the same "failure indistinguishable from emptiness" bug this
  // branch exists to remove, just on the write side instead of the read side.
  const e = env({ sshBody: `printf '%s\\n' '{"session":"new","state":"working","ts":9,"kind":"host"}'` });
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  const status = path.join(e.home, '.agentview-remote-status.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');
  fs.writeFileSync(status, 'ok\t111\n');
  fs.writeFileSync(path.join(e.bin, 'mv'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  assert.strictEqual(fs.readFileSync(status, 'utf8'), 'ok\t111\n',
    'status must be left at its old epoch, not overwritten with a fresh "ok", when the cache mv failed');
  assert.match(fs.readFileSync(cache, 'utf8'), /"session":"old"/,
    'the cache itself is untouched when its own mv failed');
});

// Writes an inotifywait stub that logs its argv (one call per line, like the ssh stub above)
// before exiting with `exitCode`. Lets a test prove inotifywait was actually pointed at the
// right directory with the right timeout, not just that SOME exit code was produced.
function writeInotifyStub(e, exitCode) {
  const log = path.join(e.home, 'inotify-argv.log');
  fs.writeFileSync(path.join(e.bin, 'inotifywait'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${exitCode}\n`,
    { mode: 0o755 });
  return log;
}

test('a watch timeout also refreshes the remote hosts', () => {
  // inotifywait exits 2 on timeout, meaning "no local change happened". That is exactly when
  // the remote hosts are worth re-fetching -- an event means local state moved, and the
  // local read is free.
  const e = env();
  const log = writeInotifyStub(e, 2);
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(e.sshCalls().length > 0, 'a timeout iteration must refresh the remote hosts');
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /-t 1\b/, `expected -t 1 (AGENT_VIEW_WATCH_INTERVAL) in: ${argv}`);
  assert.ok(argv.includes(path.join(e.home, '.claude', 'agent-view')),
    `expected the statedir as the watch target in: ${argv}`);
});

test('a local file event repaints without touching the network', () => {
  // The whole point of watching: a local state change must not cost an ssh round-trip.
  const e = env();
  const log = writeInotifyStub(e, 0);
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.strictEqual(e.sshCalls().length, 0, 'a local event must not trigger an ssh fetch');
  // Proves this is "an event fired on the right watch", not "inotifywait was never invoked" --
  // a stub-not-found path would also produce zero ssh calls (it falls to the sleep fallback)
  // and pass the assertion above for the wrong reason.
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /-t 1\b/, `expected -t 1 (AGENT_VIEW_WATCH_INTERVAL) in: ${argv}`);
  assert.ok(argv.includes(path.join(e.home, '.claude', 'agent-view')),
    `expected the statedir as the watch target in: ${argv}`);
});

test('the watcher falls back to a timer when inotifywait is absent', () => {
  // chezmoi deploys these dotfiles to WSL and both servers; inotify-tools is not everywhere.
  // Without a fallback the picker would silently stop repainting on those machines.
  const e = env();
  // post_reload polls this file for up to 2s waiting for fzf's port; writing it up front lets
  // that poll return on its first check, so the elapsed time below measures only the fallback
  // sleep, not the poll.
  fs.writeFileSync(path.join(e.home, 'portfile'), '1\n');
  fs.rmSync(path.join(e.bin, 'inotifywait'), { force: true });
  const started = Date.now();
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(Date.now() - started >= 900, 'the fallback must actually wait, not spin');
  assert.ok(e.sshCalls().length > 0, 'the timer path refreshes the remote hosts');
});

test('an inotifywait error does not busy-spin -- the loop still waits a full interval', () => {
  // rc 1 is inotifywait's own error path (an exhausted watch/instance limit, a target that
  // vanished mid-run, bad args) -- distinct from rc 2 (clean timeout) and rc 0 (event). Without
  // a floor wait on this branch, av_watch_once returns near-instantly and the loop hammers
  // post_reload's curl + refresh_remote's ssh as fast as the CPU allows.
  const e = env();
  const log = writeInotifyStub(e, 1);
  // Same confound as the fallback test above: post_reload polls this file for up to 2s, which
  // would mask a missing floor-wait behind its own delay. Pre-writing it makes that poll return
  // immediately, so the elapsed time below measures only the floor sleep (or its absence).
  fs.writeFileSync(path.join(e.home, 'portfile'), '1\n');
  const started = Date.now();
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(Date.now() - started >= 900,
    'an inotifywait error must still wait a full interval before returning, not spin');
  assert.ok(e.sshCalls().length > 0, 'an error iteration is treated as a timeout and refreshes');
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /-t 1\b/, `expected -t 1 (AGENT_VIEW_WATCH_INTERVAL) in: ${argv}`);
});

test('AGENT_VIEW_WATCH_INTERVAL=0 does not defeat the floor sleep', () => {
  // "0" is all-digits, so the interval validation lets it through as a normal value -- and
  // `sleep 0` returns in about 1ms. Without a floor of 1, that breaks two things at once: the
  // fallback's own `sleep "$AV_WATCH_INTERVAL"` timeout returns instantly (busy-spin), and the
  // floor-sleep backstop for a bad inotifywait exit is `sleep "$AV_WATCH_INTERVAL"` too, so the
  // same value that broke the first path also disarms the thing meant to catch it.
  const e = env({ watchInterval: '0' });
  fs.rmSync(path.join(e.bin, 'inotifywait'), { force: true });
  fs.writeFileSync(path.join(e.home, 'portfile'), '1\n');
  const started = Date.now();
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(Date.now() - started >= 900,
    'a requested interval of 0 must still be raised to the 1s floor, not spin');
  assert.ok(e.sshCalls().length > 0, 'the timer path refreshes the remote hosts');
});

module.exports = { env };
