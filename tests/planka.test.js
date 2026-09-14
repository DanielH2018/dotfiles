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

// A fake Planka on a loopback port: records every request and answers the
// handful of routes the CLI uses. Keeps the write tests hermetic and off the
// real board.
function fakePlanka(handlers = {}) {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const handler = handlers[`${req.method} ${req.url}`];
      const payload = handler ? handler(body) : { item: {} };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  return { server, seen, port: () => server.address().port };
}

// The fake server lives in this process, so the CLI must NOT be run with
// spawnSync: it blocks the event loop, the server never gets to answer, and
// every request dies on the client timeout instead.
function runAsync({ cfgPath, state, dir }, args, env = {}) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('python3', [PLANKA, ...args], {
      env: {
        ...process.env,
        PLANKA_CONFIG: cfgPath,
        PLANKA_STATE_DIR: state,
        PLANKA_CACHE_DIR: path.join(dir, 'cache'),
        PLANKA_REPO: 'myrepo',
        PLANKA_TIMEOUT: '5',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function onlineCtx(port, extra = {}) {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}`,
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
    ...extra,
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  return { dir, cfgPath, state };
}

test('card resolve --create creates in the active list and stamps the branch',
  { skip }, async () => {
    const fake = fakePlanka({
      'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
      'GET /api/boards/b1': () => ({ item: { id: 'b1' }, included: { customFieldValues: [] } }),
      'POST /api/lists/list-active/cards': () => ({ item: { id: 'new-card' } }),
    });
    await new Promise((r) => fake.server.once('listening', r));
    const ctx = onlineCtx(fake.port(), {
      lists: { active: 'list-active', done: 'list-done' },
      customFields: { groupId: 'g1', branch: 'f-branch', repo: 'f-repo' },
    });
    const res = await runAsync(ctx, ['card', 'resolve', '--create', '--branch', 'feature-y'],
      { PLANKA_PASSWORD: 'pw' });
    fake.server.close();
    assert.strictEqual(res.status, 0);
    assert.strictEqual(res.stdout.trim(), 'new-card');

    assert.ok(fake.seen.find((r) => r.url === '/api/lists/list-active/cards'),
      'the card was created in the active list, not the backlog');

    const stamped = fake.seen.filter(
      (r) => r.url.startsWith('/api/cards/new-card/custom-field-values/'));
    assert.ok(stamped.some((r) => r.body && r.body.content === 'feature-y'),
      'the branch is stamped on the card');

    const sidecar = JSON.parse(fs.readFileSync(
      path.join(ctx.state, 'branch', 'myrepo--feature-y.json'), 'utf8'));
    assert.strictEqual(sidecar.cardId, 'new-card');
  });

test('card move sends the configured list id, not its name', { skip }, async () => {
  const fake = fakePlanka({
    'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
    'PATCH /api/cards/c42': () => ({ item: { id: 'c42' } }),
  });
  await new Promise((r) => fake.server.once('listening', r));
  const ctx = onlineCtx(fake.port(), { lists: { active: 'list-active', done: 'list-done' } });
  fs.writeFileSync(path.join(ctx.state, 'branch', 'myrepo--feature-y.json'),
    JSON.stringify({ cardId: 'c42' }));
  const res = await runAsync(ctx, ['card', 'move', '--list', 'done', '--branch', 'feature-y'],
    { PLANKA_PASSWORD: 'pw' });
  fake.server.close();
  assert.strictEqual(res.status, 0);
  const patch = fake.seen.find((r) => r.method === 'PATCH' && r.url === '/api/cards/c42');
  assert.strictEqual(patch.body.listId, 'list-done');
});

test('card move with an unknown list key is silent and exits 0', { skip }, () => {
  const ctx = withSidecar({ ...OFFLINE_CFG, lists: { active: 'list-active' } },
    { 'myrepo--feature-y.json': { cardId: 'c42' } });
  const res = runIn(ctx, ['card', 'move', '--list', 'nonesuch', '--branch', 'feature-y'],
    { PLANKA_PASSWORD: 'pw' });
  assert.strictEqual(res.status, 0);
});

test('card move on an untracked branch touches nothing', { skip }, () => {
  const ctx = withSidecar({ ...OFFLINE_CFG, lists: { done: 'list-done' } }, {});
  const res = runIn(ctx, ['card', 'move', '--list', 'done', '--branch', 'untracked'],
    { PLANKA_PASSWORD: 'pw' });
  assert.strictEqual(res.status, 0);
});
