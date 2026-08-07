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
// noInotify drives the timer fallback. Deleting the stub from `bin` does NOT do that: PATH is
// the fixture dir followed by the real one, so /usr/bin/inotifywait answers instead and the
// watcher takes its normal path. Three tests below did exactly that and passed anyway, because
// `inotifywait -t 1` blocks for the same second the fallback's `sleep 1` would have.
function env({ sshBody = 'exit 0', watchInterval = '1', noInotify = false } = {}) {
  const home = scratch('av-home-');
  const bin = scratch('av-bin-');
  const argvLog = path.join(home, 'ssh-argv.log');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n${sshBody}\n`,
    { mode: 0o755 });
  // post_reload polls the portfile for up to 2s waiting on fzf's start-bind to write the
  // port. No test here runs fzf, so every run used to pay that 2s in full -- 2.18s per
  // invocation against 0.14s with the file already there, and this file makes 16 of them.
  // Three tests below already pre-wrote it to keep the poll from masking an elapsed-time
  // assertion; doing it here extends that to every test instead of the ones that noticed.
  fs.writeFileSync(path.join(home, 'portfile'), '1\n');
  // With a port to read, post_reload goes on to POST. Stub curl so it stays off the loopback
  // interface rather than relying on port 1 refusing the connection.
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  // rows.sh reaches sleep by bare name, so this shadows it the way the stubs above do. It
  // records the argument rather than swallowing it, because that argument IS what the
  // watch-floor tests below are about: the floor exists so a requested interval of 0 cannot
  // become `sleep 0`, and asserting which interval was requested pins that exactly, where
  // timing the process only infers it -- at a real second per test to prove one integer.
  const sleepLog = path.join(home, 'sleep-args.log');
  fs.writeFileSync(path.join(bin, 'sleep'),
    `#!/bin/bash\nprintf '%s\\n' "$1" >> ${JSON.stringify(sleepLog)}\nexit 0\n`,
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
          ...(noInotify ? { AGENT_VIEW_INOTIFYWAIT: 'agentview-absent-inotifywait' } : {}),
        },
      });
    },
    sshCalls() {
      if (!fs.existsSync(argvLog)) return [];
      return fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
    },
    sleeps() {
      if (!fs.existsSync(sleepLog)) return [];
      return fs.readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean);
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
  // the same technique the suite already uses to shadow ssh. The stub only fails the
  // remote-cache mv: av_write_status (rows.sh) does its own tmp+mv for the status file, so a
  // blanket-failing stub would block that write too and the test would pass regardless of
  // whether the `ok` write is actually gated on the cache mv succeeding. Goes red if
  // `av_write_status ok` is called unconditionally again: status would then read
  // `ok\t<fresh epoch>` instead of staying at the seeded `ok\t111`.
  const e = env({ sshBody: `printf '%s\\n' '{"session":"new","state":"working","ts":9,"kind":"host"}'` });
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  const status = path.join(e.home, '.agentview-remote-status.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');
  fs.writeFileSync(status, 'ok\t111\n');
  fs.writeFileSync(path.join(e.bin, 'mv'),
    '#!/bin/bash\ncase "$*" in *remote-cache*) exit 1;; esac\nexec /usr/bin/mv "$@"\n', { mode: 0o755 });

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
  // The whole point of watching: a local state change must not cost an ssh round-trip -- as long
  // as the remote snapshot is still inside its interval. Staleness is the next test's job.
  const e = env();
  const log = writeInotifyStub(e, 0);
  for (const host of ['daniel-server', 'daniel-box']) {
    // Stamped ahead, not at "now": av_watch_once fetches once the snapshot's age reaches
    // AV_WATCH_INTERVAL, which is 1s here, so a stamp of exactly now leaves no headroom --
    // any scheduling delay above a second between this write and the shell reading it makes
    // a deliberately-fresh fixture read as stale and fetch. That is invisible when the file
    // runs alone and reliable under the full suite's load, which is how it reached main
    // green. The staleness test below expresses its intent the same way, with -600.
    fs.writeFileSync(path.join(e.home, `.agentview-remote-status.${host}`),
      `ok\t${Math.floor(Date.now() / 1000) + 600}\n`);   // fetched "just now", with headroom
  }
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.strictEqual(e.sshCalls().length, 0,
    'a local event with a fresh remote snapshot must not trigger an ssh fetch');
  // Proves this is "an event fired on the right watch", not "inotifywait was never invoked" --
  // a stub-not-found path would also produce zero ssh calls (it falls to the sleep fallback)
  // and pass the assertion above for the wrong reason.
  const argv = fs.readFileSync(log, 'utf8');
  assert.match(argv, /-t 1\b/, `expected -t 1 (AGENT_VIEW_WATCH_INTERVAL) in: ${argv}`);
  assert.ok(argv.includes(path.join(e.home, '.claude', 'agent-view')),
    `expected the statedir as the watch target in: ${argv}`);
});

test('a stream of local events cannot starve the remote refresh', () => {
  // refresh_remote used to run only on the inotify TIMEOUT branch, so remotes refreshed after an
  // interval of local QUIET rather than every interval. Watching the session registry adds local
  // events on purpose, which would have made remote rows staler as local ones got fresher.
  const e = env();
  writeInotifyStub(e, 0);   // rc 0 = a local event fired, never a timeout
  for (const host of ['daniel-server', 'daniel-box']) {
    fs.writeFileSync(path.join(e.home, `.agentview-remote-status.${host}`),
      `ok\t${Math.floor(Date.now() / 1000) - 600}\n`);   // fetched 10 minutes ago
  }
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(e.sshCalls().length > 0,
    'a local event must still fetch the remotes once the interval has elapsed since the last fetch');
});

test('a host that has never been fetched counts as infinitely stale', () => {
  // No status sidecar at all is the first-run case. Reading a missing epoch as 0 makes the very
  // first iteration fetch, rather than waiting for a quiet interval to discover the hosts exist.
  const e = env();
  writeInotifyStub(e, 0);
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(e.sshCalls().length > 0,
    'a host with no recorded fetch must be treated as stale, not as fresh');
});

test('the watcher watches the live session registry, not just the hook sidecars', () => {
  // Daemon-hosted bg jobs never fire UserPromptSubmit, so their hook rows go stale or never
  // exist (rows.sh:39-45). They are recovered from ~/.claude/sessions, which nothing watched --
  // so a local bg job finishing took up to a full interval to reach the picker.
  const e = env();
  const log = writeInotifyStub(e, 2);
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  const argv = fs.readFileSync(log, 'utf8');
  assert.ok(argv.includes(path.join(e.home, '.claude', 'sessions')),
    `expected the sessions registry as a watch target in: ${argv}`);
  assert.ok(argv.includes(path.join(e.home, '.claude', 'agent-view')),
    `the statedir must still be watched too, not replaced, in: ${argv}`);
});

test('a missing sessions registry is created before the watch, not watched blindly', () => {
  // inotifywait against a path that does not exist returns rc 1, not rc 2. rc 1 lands in the
  // floor-sleep branch, which silently degrades the whole loop to a plain timer with no error
  // surfaced -- local event-driven updates would just stop on a freshly provisioned box.
  const e = env();
  fs.rmSync(path.join(e.home, '.claude', 'sessions'), { recursive: true, force: true });
  writeInotifyStub(e, 2);
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(fs.existsSync(path.join(e.home, '.claude', 'sessions')),
    'the watcher must mkdir -p the sessions registry the same way it does the statedir');
});

test('the watcher falls back to a timer when inotifywait is absent', () => {
  // chezmoi deploys these dotfiles to WSL and both servers; inotify-tools is not everywhere.
  // Without a fallback the picker would silently stop repainting on those machines.
  const e = env({ noInotify: true });
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(e.sleeps().includes('1'),
    `the fallback must wait a full interval, not spin; slept: ${JSON.stringify(e.sleeps())}`);
  assert.ok(e.sshCalls().length > 0, 'the timer path refreshes the remote hosts');
});

test('an inotifywait error does not busy-spin -- the loop still waits a full interval', () => {
  // rc 1 is inotifywait's own error path (an exhausted watch/instance limit, a target that
  // vanished mid-run, bad args) -- distinct from rc 2 (clean timeout) and rc 0 (event). Without
  // a floor wait on this branch, av_watch_once returns near-instantly and the loop hammers
  // post_reload's curl + refresh_remote's ssh as fast as the CPU allows.
  const e = env();
  const log = writeInotifyStub(e, 1);
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(e.sleeps().includes('1'),
    `an error iteration must still wait a full interval, not spin; slept: ${JSON.stringify(e.sleeps())}`);
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
  const e = env({ watchInterval: '0', noInotify: true });
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  // Asserting the argument, not the elapsed time: `sleep 0` is exactly the failure this floor
  // exists to prevent, and it is invisible to a clock that only asks whether a second passed.
  assert.ok(e.sleeps().includes('1'),
    `a requested interval of 0 must be raised to the 1s floor; slept: ${JSON.stringify(e.sleeps())}`);
  assert.ok(!e.sleeps().includes('0'), 'sleep 0 returns instantly and turns the loop into a spin');
  assert.ok(e.sshCalls().length > 0, 'the timer path refreshes the remote hosts');
});

// ---- orphan collection ----
// Nothing else in the picker ever removes these files, so before this they accumulated for
// the life of the machine. The dev box was carrying a 0-byte ~/.agentview-remote-cache from
// before the snapshot was split per host.
//
// The age gate matters to every test below: gc_orphan_files only condemns a tmp/portfile that
// is BOTH written by a dead pid and older than REAP_GRACE, so fixtures have to be backdated
// or they are correctly left alone.
const GRACE_S = 120;
const backdate = (p) => {
  const t = Math.floor(Date.now() / 1000) - (GRACE_S * 5);
  fs.utimesSync(p, t, t);
};
// A pid that was real a moment ago and is now gone -- `kill -0` on it fails. Picking a large
// constant instead would be a guess about pid_max that could collide with a live process.
const deadPid = () => execFileSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).trim();

test('the retired pre-split cache file is collected', () => {
  const e = env();
  const legacy = path.join(e.home, '.agentview-remote-cache');
  fs.writeFileSync(legacy, '');
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  assert.ok(!fs.existsSync(legacy), 'the suffix-less cache can never be a live per-host file');
});

test('a cache and status for a host no longer configured are collected, live hosts are not', () => {
  const e = env();
  const retiredCache = path.join(e.home, '.agentview-remote-cache.oldbox');
  const retiredStatus = path.join(e.home, '.agentview-remote-status.oldbox');
  fs.writeFileSync(retiredCache, '{"session":"gone"}\n');
  fs.writeFileSync(retiredStatus, `ok\t${Math.floor(Date.now() / 1000)}\n`);
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  assert.ok(!fs.existsSync(retiredCache), 'a retired host keeps no cache');
  assert.ok(!fs.existsSync(retiredStatus), 'a retired host keeps no status');
  // The same sweep must leave the configured hosts alone -- this is the predicate whose
  // false positive blanks the picker's remote rows rather than just leaving litter.
  assert.ok(fs.existsSync(path.join(e.home, '.agentview-remote-status.daniel-server')),
    'a configured host keeps its status file');
});

test('a tmp file whose writer is gone and which has aged out is collected', () => {
  const e = env();
  const orphan = path.join(e.home, `.agentview-remote-cache.daniel-box.tmp.${deadPid()}`);
  fs.writeFileSync(orphan, 'half-written');
  backdate(orphan);
  const port = path.join(e.home, `.agentview-fzfport.${deadPid()}`);
  fs.writeFileSync(port, '1234\n');
  backdate(port);
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  assert.ok(!fs.existsSync(orphan), 'a dead writer\'s aged tmp file is litter');
  assert.ok(!fs.existsSync(port), 'a SIGKILLed picker\'s portfile is litter');
});

test('a tmp file whose writer is still alive is left alone', () => {
  const e = env();
  // process.pid is this test runner -- alive by definition for the duration of the run.
  const live = path.join(e.home, `.agentview-remote-cache.daniel-box.tmp.${process.pid}`);
  fs.writeFileSync(live, 'mid-write');
  backdate(live);   // old enough to pass the age gate, so only liveness can save it
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  assert.ok(fs.existsSync(live), 'a live writer must never have its tmp file deleted mid-mv');
});

test('a freshly written tmp file survives even when its writer is gone', () => {
  const e = env();
  // Not backdated: pids recycle, so liveness alone is not a safe condemnation. A tmp younger
  // than a refresh cycle is spared regardless of what its pid now resolves to.
  const fresh = path.join(e.home, `.agentview-remote-cache.daniel-box.tmp.${deadPid()}`);
  fs.writeFileSync(fresh, 'just written');
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  assert.ok(fs.existsSync(fresh), 'the age gate spares a recent tmp file');
});

test('a watch tick refreshes without sweeping', () => {
  // Placement guard. The watch loop calls refresh_remote on every timer tick, so a GC living
  // inside that function would spawn a find pair per interval for as long as a picker is open
  // -- the cost this was moved off the render path to avoid. It belongs to the
  // --refresh-remote dispatch, which runs at startup and on CTRL+F.
  const e = env({ noInotify: true });   // force the timer path
  const legacy = path.join(e.home, '.agentview-remote-cache');
  fs.writeFileSync(legacy, '');
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(e.sshCalls().length > 0, 'the tick should still refresh the hosts');
  assert.ok(fs.existsSync(legacy), 'a watch tick must not run the sweep');
});

test('an empty host table collects nothing', () => {
  // The load-order guard. If HOST_SSH is somehow unpopulated, every per-host cache looks
  // retired and the sweep would delete the lot -- so the whole pass refuses instead. Driven by
  // sourcing the modules directly, because the script itself always populates HOST_SSH.
  const e = env();
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  const legacy = path.join(e.home, '.agentview-remote-cache');
  fs.writeFileSync(cache, '{"session":"live"}\n');
  fs.writeFileSync(legacy, '');
  execFileSync('bash', ['-c',
    `HOST_SSH=(); . ${JSON.stringify(path.join(LIB, 'common.sh'))}; ` +
    `. ${JSON.stringify(path.join(LIB, 'rows.sh'))}; gc_orphan_files`,
  ], { env: { ...process.env, HOME: e.home }, encoding: 'utf8' });
  assert.ok(fs.existsSync(cache), 'an unloaded host table must not condemn a live cache');
  assert.ok(fs.existsSync(legacy), 'the pass refuses wholesale, not just its per-host branch');
});

module.exports = { env };
