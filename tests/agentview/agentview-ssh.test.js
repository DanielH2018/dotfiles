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
function env({ sshBody = 'exit 0' } = {}) {
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

module.exports = { env };
