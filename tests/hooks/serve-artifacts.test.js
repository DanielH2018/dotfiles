// serve-artifacts.sh starts the loopback artifact browser once and leaves it running across
// sessions. A server that never restarts keeps the code and settings it started with, so the
// hook stamps both at launch and restarts the server when either changes. These tests run
// the hook against a stub server that records each start, in a scratch HOME.
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { scratch } = require('../lib/tmp');
const { srcPath } = require('../lib/paths');
const { skipUnless } = require('../lib/probe');

const HOOK = srcPath('private_dot_claude', 'hooks', 'executable_serve-artifacts.sh');
const skip = skipUnless('bash', 'python3', 'pgrep', 'pkill');

// Records "<pid> <stars file> <read-only flag>" on each start, then idles like a server.
const STUB = `import os, time
with open(os.environ["STUB_LOG"], "a") as f:
    f.write("%d %s %s\\n" % (os.getpid(), os.environ.get("ARTIFACTS_STARS_FILE", ""),
                             os.environ.get("ARTIFACTS_STARS_READONLY", "")))
time.sleep(60)
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t) {
  const home = scratch(os.tmpdir(), 'sa-', t);
  const server = path.join(home, '.claude', 'hooks', 'artifact-server', 'artifact_server.py');
  fs.mkdirSync(path.dirname(server), { recursive: true });
  fs.writeFileSync(server, STUB);
  t.after(() => spawnSync('pkill', ['-f', server]));
  const log = path.join(home, 'starts.log');
  const env = {
    ...process.env,
    HOME: home,
    STUB_LOG: log,
    // A port nothing real listens on: the hook also stops a legacy http.server on its port.
    CLAUDE_ARTIFACTS_PORT: '18999',
    CLAUDE_ARTIFACTS_HOST: 'testhost',
    CLAUDE_ARTIFACT_STARS_FILE: path.join(home, 'stars.txt'),
  };
  delete env.CLAUDE_ARTIFACTS_BASE_URL;
  delete env.CLAUDE_ARTIFACT_STATE_DIR;

  const run = (extra = {}) => {
    const r = spawnSync('bash', [HOOK], { input: '{}', encoding: 'utf8', env: { ...env, ...extra } });
    assert.strictEqual(r.status, 0, `hook exits 0 (stderr: ${r.stderr})`);
  };
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const waitForStarts = async (n) => {
    for (let i = 0; i < 100 && starts().length < n; i++) await sleep(50);
    return starts();
  };
  const running = () => spawnSync('pgrep', ['-f', server], { encoding: 'utf8' })
    .stdout.trim().split('\n').filter(Boolean);
  return { server, run, starts, waitForStarts, running };
}

test('an unchanged server is left running', { skip }, async (t) => {
  const f = fixture(t);
  f.run();
  assert.strictEqual((await f.waitForStarts(1)).length, 1, 'the first session starts it');
  f.run();
  await sleep(300);
  assert.strictEqual(f.starts().length, 1, 'the second session finds it current');
  assert.strictEqual(f.running().length, 1);
});

test('a code change restarts the server, leaving one running', { skip }, async (t) => {
  const f = fixture(t);
  f.run();
  await f.waitForStarts(1);
  fs.appendFileSync(f.server, '# changed\n');
  f.run();
  assert.strictEqual((await f.waitForStarts(2)).length, 2, 'the new code starts');
  assert.strictEqual(f.running().length, 1, 'the old server was stopped first');
});

test('the star list is writable on a workstation and read-only behind the cluster browser',
  { skip }, async (t) => {
    const f = fixture(t);
    f.run();
    const [first] = await f.waitForStarts(1);
    assert.match(first, /stars\.txt 0$/, 'a workstation owns its own list');

    f.run({ CLAUDE_ARTIFACTS_BASE_URL: 'https://artifacts.example' });
    const lines = await f.waitForStarts(2);
    assert.strictEqual(lines.length, 2, 'a settings change restarts the server too');
    assert.match(lines[1], /stars\.txt 1$/, 'where the cluster owns the list, it is read-only');
  });
