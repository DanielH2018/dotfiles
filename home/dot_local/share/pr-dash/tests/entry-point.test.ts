// src/main.ts is the one module no other suite imports, because importing it starts the
// server. Node links an ES module's whole static import graph before running any of it, so a
// specifier that cannot resolve fails here with ERR_MODULE_NOT_FOUND before main.ts's first
// statement. The trap this guards: under "moduleResolution": "nodenext", tsc accepts
// `import './foo.js'` when the real file is foo.ts, and Node's loader does not rewrite the
// extension. A bogus PR_DASH_PORT makes main.ts exit at its first statement, so the spawn
// proves the graph linked without binding a port or touching the network.
//
// This replaced a 278-line regex scan of every import specifier (#694): the spawn answers
// the same question by asking Node itself.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('src/main.ts links its whole import graph under Node', () => {
  const res = spawnSync(process.execPath, ['src/main.ts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PR_DASH_PORT: 'not-a-port' },
    timeout: 20_000,
  });
  assert.doesNotMatch(res.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, res.stderr);
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stderr, /PR_DASH_PORT must be a port number/);
});

test('src/main.ts refuses to start on a malformed PR_DASH_EXTENSION_ORIGINS', async () => {
  // A free ephemeral port, never 8770, which the launchd agent may hold. PR_DASH_PRELOAD is
  // removed so that, if a regression let the server start anyway, it would not resolve a
  // token and raise a Touch ID prompt during a test run.
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  await new Promise<void>((r) => probe.close(() => r()));

  const { PR_DASH_PRELOAD: _omit, ...env } = process.env;
  const res = spawnSync(process.execPath, ['src/main.ts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: {
      ...env,
      PR_DASH_PORT: String(addr.port),
      PR_DASH_EXTENSION_ORIGINS: 'chrome-extension://not-an-extension-id',
    },
    timeout: 20_000,
  });
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stderr, /PR_DASH_EXTENSION_ORIGINS entries must each be/);
  assert.doesNotMatch(res.stdout, /listening/);
});

test('src/main.ts refuses to start on a malformed PR_DASH_VULN_REPOS', () => {
  // PR_DASH_PORT is valid and PR_DASH_VULN_REPOS is not, so the exit can only come from the
  // repository check. It runs before listen(), so no port needs reserving.
  const { PR_DASH_PRELOAD: _omit, ...env } = process.env;
  const res = spawnSync(process.execPath, ['src/main.ts'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    env: { ...env, PR_DASH_PORT: '1', PR_DASH_VULN_REPOS: 'acme/api,not-a-repo' },
    timeout: 20_000,
  });
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stderr, /PR_DASH_VULN_REPOS entries must each be owner\/name, but one is "not-a-repo"/);
  assert.doesNotMatch(res.stdout, /listening/);
});
