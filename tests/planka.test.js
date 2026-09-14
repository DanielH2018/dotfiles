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

// Port 1 is closed throughout the sidecar tests below: any network call fails,
// so a passing assertion proves the CLI never made one.
function withSidecar(config, entries) {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  for (const [name, body] of Object.entries(entries)) {
    fs.writeFileSync(path.join(state, 'branch', name), JSON.stringify(body));
  }
  return { dir, cfgPath, state };
}

function runIn({ cfgPath, state, dir }, args, env = {}) {
  return spawnSync('python3', [PLANKA, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: state,
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_TIMEOUT: '1',
      ...env,
    },
  });
}

const OFFLINE_CFG = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:1',
  boardId: 'b1',
  credential: { username: 'u', keychainService: 'nope' },
};

test('card resolve prefers the sidecar and makes no network call', { skip }, () => {
  const ctx = withSidecar(OFFLINE_CFG, {
    'myrepo--feature-x.json': { cardId: 'c42', url: 'http://localhost:3001/cards/c42' },
  });
  const res = runIn(ctx, ['card', 'resolve', '--branch', 'feature-x']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), 'c42');
});

test('card resolve without a sidecar and without --create prints nothing', { skip }, () => {
  const ctx = withSidecar(OFFLINE_CFG, {});
  const res = runIn(ctx, ['card', 'resolve', '--branch', 'unknown-branch']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), '');
});

test('status prints the card and url from the sidecar', { skip }, () => {
  const ctx = withSidecar(OFFLINE_CFG, {
    'myrepo--feature-x.json': { cardId: 'c42', url: 'http://localhost:3001/cards/c42' },
  });
  const res = runIn(ctx, ['status', '--branch', 'feature-x']);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /c42/);
  assert.match(res.stdout, /feature-x/);
});

test('status on an untracked branch says so rather than going silent', { skip }, () => {
  const ctx = withSidecar(OFFLINE_CFG, {});
  const res = runIn(ctx, ['status', '--branch', 'feature-x']);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /not tracked/);
});

test('a branch slug with slashes maps to one flat sidecar filename', { skip }, () => {
  const ctx = withSidecar(OFFLINE_CFG, {
    'myrepo--claude-planka-work.json': { cardId: 'c99', url: 'http://localhost:3001/cards/c99' },
  });
  const res = runIn(ctx, ['card', 'resolve', '--branch', 'claude/planka-work']);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), 'c99');
});
