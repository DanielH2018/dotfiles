// The claim hook fires on every Edit/Write. What matters is that it calls the
// CLI exactly once per session and never lets a failure reach the caller — it
// sits on the edit path, where a slow or broken board must cost nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_planka-claim.sh');

// The board runs on one machine. Elsewhere these suites only ever raced the hook's
// backgrounded CLI call (the no-session-id case failed 3 of 4 pre-push gates on daniel-box
// on 2026-09-17), so they run only where the CLI is configured.
const skip = fs.existsSync(path.join(os.homedir(), '.config', 'planka', 'config.json'))
  ? false
  : 'no ~/.config/planka/config.json: the Planka board is not set up on this machine';

// Every scratch dir this suite makes, removed on the way out — bin/sweep-test-tmp
// only collects leftovers six hours later.

function tmpdir() {
  const dir = scratch(os.tmpdir(), 'planka-claim-');
  return dir;
}

// A stub `planka` on PATH that appends one line per invocation.
function stubBin(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(
    path.join(bin, 'planka'),
    `#!/bin/sh\necho "$@" >> ${calls}\nexit 0\n`,
    { mode: 0o755 },
  );
  return { bin, calls };
}

function fire(dir, { bin, sessionId = 'sess-1', env = {} }) {
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'some-file.txt') },
    }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PLANKA_STATE_DIR: path.join(dir, 'state'),
      ...env,
    },
  });
}

// The hook backgrounds the CLI, so give it a moment to land.
function waitFor(file) {
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(file) && Date.now() < deadline) { /* spin */ }
  return fs.existsSync(file);
}

test('claims once per session, not once per edit', { skip }, () => {
  const dir = tmpdir();
  const { bin, calls } = stubBin(dir);
  for (let i = 0; i < 3; i += 1) {
    const r = fire(dir, { bin });
    assert.strictEqual(r.status, 0);
  }
  waitFor(calls);
  const lines = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  assert.strictEqual(lines.length, 1, `expected one claim, got ${lines.length}`);
  assert.match(lines[0], /card resolve --create/);
});

test('a different session claims again', { skip }, () => {
  const dir = tmpdir();
  const { bin, calls } = stubBin(dir);
  fire(dir, { bin, sessionId: 'sess-1' });
  waitFor(calls);
  fire(dir, { bin, sessionId: 'sess-2' });
  const deadline = Date.now() + 2000;
  let lines = [];
  while (Date.now() < deadline) {
    lines = fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length >= 2) break;
  }
  assert.strictEqual(lines.length, 2);
});

test('PLANKA_TRACKING=0 claims nothing', { skip }, () => {
  const dir = tmpdir();
  const { bin, calls } = stubBin(dir);
  const r = fire(dir, { bin, env: { PLANKA_TRACKING: '0' } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(calls), false);
});

test('a CLI that fails does not fail the hook', { skip }, () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'planka'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const r = fire(dir, { bin });
  assert.strictEqual(r.status, 0);
});

test('no planka on PATH does not fail the hook', { skip }, () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // The empty stub dir holds no planka, but bash and the coreutils the hook
  // calls still have to be findable — PATH=bin alone breaks spawn itself.
  const r = fire(dir, { bin, env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.strictEqual(r.status, 0);
});

test('a payload with no session id claims nothing', { skip }, () => {
  const dir = tmpdir();
  const { bin, calls } = stubBin(dir);
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Edit' }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PLANKA_STATE_DIR: path.join(dir, 'state'),
    },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(calls), false);
});
