// Regression guard for home/dot_local/bin/executable_planka.
// Drives the ACTUAL script. Hermetic: config, state and cache all live in a
// temp dir, and no test reaches the real board. Skips cleanly without python3.
//
// The first test is the load-bearing one. planka sits on the PostToolUse and
// Stop paths of every session on every machine, but its config lives only in
// the private work overlay — so "no config means silence and exit 0" is what
// keeps this tool inert everywhere else.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLANKA = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_planka');

let skip = false;
try {
  execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
} catch {
  skip = true;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planka-test-'));
}

// Run the CLI with a scratch environment. `config` null means "no config file
// at all" — the inert case.
function run(args, { config, env = {} } = {}) {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  if (config) fs.writeFileSync(cfgPath, JSON.stringify(config));
  const res = spawnSync('python3', [PLANKA, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: path.join(dir, 'state'),
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      ...env,
    },
  });
  return { ...res, dir };
}

test('no config file: silent, exit 0', { skip }, () => {
  const r = run(['board', 'show']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

test('enabled:false: silent, exit 0', { skip }, () => {
  const r = run(['board', 'show'], { config: { enabled: false, baseUrl: 'http://127.0.0.1:1' } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('PLANKA_TRACKING=0: silent, exit 0', { skip }, () => {
  const r = run(['board', 'show'], {
    config: { enabled: true, baseUrl: 'http://127.0.0.1:1' },
    env: { PLANKA_TRACKING: '0' },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('--strict turns a missing config into a non-zero exit', { skip }, () => {
  const r = run(['--strict', 'board', 'show']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /config/i);
});

test('unreachable board: exit 0, reason in the log', { skip }, () => {
  const r = run(['board', 'show'], {
    config: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:1',
      boardId: 'b1',
      credential: { username: 'u', keychainService: 'nope' },
    },
    env: { PLANKA_PASSWORD: 'pw', PLANKA_TIMEOUT: '1' },
  });
  assert.strictEqual(r.status, 0);
  const log = fs.readFileSync(path.join(r.dir, 'state', 'log'), 'utf8');
  assert.match(log, /mint|connect|refused|urlopen/i);
});
