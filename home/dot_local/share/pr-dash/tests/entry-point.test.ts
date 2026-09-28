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
