// Remote session titles going missing or stale over ssh -- the counterpart to the local
// merge in agentview-bg-sessions.test.js. refresh_one_remote's REMOTE_FOLD (rows.sh) runs the
// SAME two-registry fold locally does (a hook row's title/state, overridden by Claude's own
// live process registry), but as a heredoc executed on the far end. These tests run that
// heredoc for real: the `ssh` stub does not fake a canned reply, it `exec`s `bash -s` against
// a fixture $HOME standing in for the remote host, so REMOTE_FOLD's actual jq/bash runs
// exactly as it would over a real connection.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { agentviewWinSeams } = require('../lib/agentview-env');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'home', 'dot_local', 'bin', 'executable_agentview');

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A pid that is genuinely alive on THIS machine: REMOTE_FOLD's `kill -0 "$pid"` runs inside
// the ssh stub's `bash -s`, which executes locally (there is no real far end in this suite),
// so the fixture pid has to resolve here, not on some other host.
const ALIVE_PID = process.pid;

function remoteHome() {
  const dir = scratch('av-remote-home-');
  fs.mkdirSync(path.join(dir, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'sessions'), { recursive: true });
  return dir;
}
function hookRow(home, sid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'agent-view', `${sid}.json`), JSON.stringify(obj));
}
function sessFile(home, pid, obj) {
  fs.writeFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), JSON.stringify({ pid, ...obj }));
}

// Builds a local picker HOME plus an `ssh` stub that runs REMOTE_FOLD's heredoc for real,
// against `rhome`, instead of returning a canned line the way agentview-ssh.test.js's stub
// does -- that stub is right for exercising the cache/status round-trip, but it never runs
// the jq/bash inside REMOTE_FOLD, which is exactly what these tests need to cover.
function env(rhome) {
  const home = scratch('av-home-');
  const bin = scratch('av-bin-');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'),
    `#!/bin/bash\nHOME=${JSON.stringify(rhome)} exec bash -s\n`, { mode: 0o755 });
  const seams = agentviewWinSeams({ bin, scratch });
  return {
    home,
    run(args) {
      return execFileSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env, ...seams.env,
          HOME: home, AV_LIB: path.join(ROOT, 'home', 'dot_local', 'share', 'agentview'),
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
    },
    cache(host) {
      return fs.readFileSync(path.join(home, `.agentview-remote-cache.${host}`), 'utf8');
    },
  };
}

test('a live registry name fills an empty remote hook title', () => {
  // Reproduces the exact shape pulled from the live ~/.agentview-remote-cache.daniel-box and
  // the daniel-box ~/.claude/sessions/<pid>.json it was built from: a fresh interactive
  // session whose hook row has no title yet (no ai-title in the transcript so far), while
  // Claude's own registry already carries a derived name ("server-66"/nameSource:"derived").
  const rhome = remoteHome();
  const sid = 'ffff0000-0000-0000-0000-000000000001';
  hookRow(rhome, sid, {
    key: sid, run: '', kind: 'host', cwd: '/home/ubuntu/server', title: '',
    state: 'idle', host: 'daniel-server', ts: 1786071815, backend: 'tmux',
    locator: 'tmux:/tmp/tmux-1000/default:server-938106:%25', pane: '',
    session: sid, pid: String(ALIVE_PID), git: '',
  });
  sessFile(rhome, ALIVE_PID, {
    sessionId: sid, cwd: '/home/ubuntu/server', kind: 'interactive', entrypoint: 'cli',
    name: 'server-66', nameSource: 'derived', status: 'idle',
    updatedAt: Date.now(), statusUpdatedAt: Date.now(),
  });

  const e = env(rhome);
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  const cache = e.cache('daniel-server');

  assert.match(cache, /"session":"ffff0000-0000-0000-0000-000000000001"/, 'the session must reach the cache');
  const row = JSON.parse(cache.trim().split('\n').find((l) => l.includes(sid)));
  assert.strictEqual(row.title, 'server-66',
    'the live registry name must fill the empty hook title, same as the local merge does');
});

test('a title the hook already resolved (rename or ai-title) is never overwritten by the registry name', () => {
  const rhome = remoteHome();
  const sid = 'ffff0000-0000-0000-0000-000000000002';
  hookRow(rhome, sid, {
    key: sid, run: '', kind: 'host', cwd: '/home/ubuntu/server', title: 'my renamed task',
    state: 'idle', host: 'daniel-server', ts: 1786071815, backend: 'tmux',
    locator: 'tmux:/tmp/tmux-1000/default:server-938106:%25', pane: '',
    session: sid, pid: String(ALIVE_PID), git: '',
  });
  sessFile(rhome, ALIVE_PID, {
    sessionId: sid, cwd: '/home/ubuntu/server', kind: 'interactive', entrypoint: 'cli',
    name: 'auto name', nameSource: 'derived', status: 'idle',
    updatedAt: Date.now(), statusUpdatedAt: Date.now(),
  });

  const e = env(rhome);
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  const row = JSON.parse(e.cache('daniel-server').trim().split('\n').find((l) => l.includes(sid)));
  assert.strictEqual(row.title, 'my renamed task', 'hook title wins over the registry name, same as local');
});

module.exports = { env, remoteHome, hookRow, sessFile, ALIVE_PID };
