# PR Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, read-only web dashboard listing my open GitHub PRs, grouped and filtered by repository, CI status, review state, staleness, or draft state, with stacked PRs nested.

**Architecture:** One Node process on `127.0.0.1` serves a static page plus `/api/prs`. The server fetches all open PRs I authored in a single GraphQL query, normalizes them to flat records, and reconstructs stacks by chaining `baseRefName` to `headRefName`. The browser does all grouping, filtering, and sorting client-side against one payload.

**Tech Stack:** Node 24 (native TypeScript type stripping, `node:http`, `node --test`), TypeScript for the server, JSDoc-annotated JavaScript for the browser, 1Password CLI (`op`) for the token. No bundler, no build step.

**Spec:** [`docs/specs/2026-09-14-pr-dashboard-design.md`](../specs/2026-09-14-pr-dashboard-design.md)

## Global Constraints

- **Node 24+ required.** Verified `v24.15.0`. Type stripping runs `.ts` directly; no transpile step exists for server code.
- **Server is `.ts`; browser code is `.js` with `// @ts-check` and JSDoc.** Browsers cannot execute `.ts`. Dropping the bundler is the reason there is no build step — do not add esbuild.
- **Shared types live in `src/types.ts`** and are consumed from `.js` via `/** @type {import("./types.ts").PrRecord} */`. Verified: `tsc --checkJs` resolves these and reports real errors.
- **ESM everywhere in this tool.** The repo root has no `package.json`, so it is CommonJS by default. `home/dot_local/share/pr-dash/package.json` with `{"type": "module"}` scopes ESM to this tree only. Verified: ESM `.ts` tests and the repo's CommonJS tests pass in one `node --test` run.
- **Read-only.** No endpoint mutates GitHub state. Every mutating affordance is an `<a href>` to github.com.
- **Token from 1Password only.** `op read "op://Private/GitHub PR Dashboard/token"`, overridable by `PR_DASH_OP_ITEM` (item path) and `GH_TOKEN` (raw token). No `gh auth token` fallback — it returns write scopes.
- **No test performs network I/O.** Every GitHub interaction is behind an injected `fetch`.
- **`tsc --noEmit` is the type gate.** No runtime dependencies. devDependencies are
  `typescript` and `@types/node` only — both types-only, neither deployed. Without
  `@types/node` the gate cannot resolve `node:http` or `node:fs`.
- **`moduleResolution` is `nodenext`.** With no bundler, `tsc` is the only check on import
  specifiers, and `bundler` resolution accepts extensionless imports Node rejects at runtime.

---

## File Structure

Everything lives under `home/dot_local/share/pr-dash/` so the tool is one self-contained tree with one `package.json`, one `tsconfig.json`, and one `node_modules`.

| Path | Responsibility | Deployed? |
|---|---|---|
| `home/dot_local/bin/executable_pr-dash` | Launcher: port, secret, spawn, open browser | yes → `~/.local/bin/pr-dash` |
| `home/dot_local/share/pr-dash/src/types.ts` | `PrRecord`, `Ci`, `Review`, `StackNode` | yes |
| `home/dot_local/share/pr-dash/src/token.ts` | Token resolution: `GH_TOKEN` → `op read` | yes |
| `home/dot_local/share/pr-dash/src/github.ts` | GraphQL transport: `query()`, pagination | yes |
| `home/dot_local/share/pr-dash/src/queries.ts` | PR fragment; fetch-many and fetch-one | yes |
| `home/dot_local/share/pr-dash/src/normalize.ts` | Raw nodes → `PrRecord[]` (pure) | yes |
| `home/dot_local/share/pr-dash/src/stacks.ts` | `PrRecord[]` → stack forest (pure) | yes |
| `home/dot_local/share/pr-dash/src/guard.ts` | Host/Origin/secret request guard (pure) | yes |
| `home/dot_local/share/pr-dash/src/cache.ts` | `get()` / `set()` / `invalidate()` | yes |
| `home/dot_local/share/pr-dash/src/server.ts` | Routing, static files, `/api/prs` | yes |
| `home/dot_local/share/pr-dash/public/index.html` | Page shell and controls | yes |
| `home/dot_local/share/pr-dash/public/app.js` | Fetch, render, wire controls | yes |
| `home/dot_local/share/pr-dash/public/group.js` | Grouping, filtering, sorting (pure) | yes |
| `home/dot_local/share/pr-dash/public/style.css` | Styles | yes |
| `home/dot_local/share/pr-dash/tests/*.test.ts` | Unit tests | **no** |
| `home/dot_local/share/pr-dash/tests/fixtures/*.json` | Recorded GraphQL responses | **no** |
| `home/dot_local/share/pr-dash/package.json` | `type: module`, `typescript` devDep | **no** |
| `home/dot_local/share/pr-dash/tsconfig.json` | `checkJs`, `strict` | **no** |

`public/group.js` is separate from `public/app.js` because grouping is pure and testable while `app.js` touches the DOM. Splitting them is what lets Slice 5 be tested at all.

---

## Slice 1 — A server that runs, guards, and serves fixture data

At the end of this slice: `pr-dash` starts, refuses hostile requests, and `curl` returns fixture PRs. Nothing talks to GitHub yet.

### Task 1: Project scaffolding and the type gate

**Files:**
- Create: `home/dot_local/share/pr-dash/package.json`
- Create: `home/dot_local/share/pr-dash/tsconfig.json`
- Create: `home/dot_local/share/pr-dash/src/types.ts`
- Modify: `.gitignore`
- Modify: `.chezmoiignore`
- Modify: `.githooks/pre-push:235`

**Interfaces:**
- Consumes: nothing.
- Produces: `PrRecord`, `Ci`, `Review` from `src/types.ts`; every later task imports these.

- [ ] **Step 1: Create the package manifest**

`home/dot_local/share/pr-dash/package.json`:

```json
{
  "name": "pr-dash",
  "private": true,
  "type": "module",
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^24.0.0"
  },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Create the tsconfig**

`home/dot_local/share/pr-dash/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2022", "dom"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true
  },
  "include": ["src/**/*.ts", "public/**/*.js", "tests/**/*.ts"]
}
```

`erasableSyntaxOnly` is load-bearing: it makes `tsc` reject enums, namespaces, and parameter properties — the TypeScript features Node's type stripping cannot run. Without it the type check passes and the server crashes at startup.

`nodenext` resolution is equally load-bearing. With no bundler, `tsc` is the only check on import specifiers, and `bundler` resolution accepts extensionless imports that Node's ESM loader rejects at runtime.

**Import specifiers always carry the `.ts` extension.** `nodenext` also accepts `./foo.js` pointing at a real `foo.ts`, and Node does not — it throws `ERR_MODULE_NOT_FOUND`. Worse, `TS2835` (the error for an extensionless import) suggests `./foo.js` by name, so the compiler's own advice leads into the trap. `tests/import-convention.test.ts` guards against it.

- [ ] **Step 3: Define the shared types**

`home/dot_local/share/pr-dash/src/types.ts`:

```ts
export type Ci = 'success' | 'failure' | 'pending' | 'none';
export type Review = 'approved' | 'changes_requested' | 'review_required' | 'none';

export type PrRecord = {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
  ci: Ci;
  review: Review;
  openedAt: string;
  updatedAt: string;
  ageDays: number;
  staleDays: number;
  additions: number;
  deletions: number;
};

export type StackNode = {
  pr: PrRecord;
  children: StackNode[];
  depth: number;
  position: number;
  stackSize: number;
  danglingBase: boolean;
};
```

- [ ] **Step 4: Exclude build and test files from git and from deployment**

Append to `.gitignore`:

```
node_modules/
```

Append to `.chezmoiignore`:

```
dot_local/share/pr-dash/node_modules
dot_local/share/pr-dash/tests
dot_local/share/pr-dash/package.json
dot_local/share/pr-dash/package-lock.json
dot_local/share/pr-dash/tsconfig.json
```

Neither file currently mentions `node_modules`. Without the `.gitignore` entry the dependency tree gets committed; without the `.chezmoiignore` entries it gets deployed to `~/.local/share/`.

- [ ] **Step 5: Teach the pre-push gate about `.test.ts`**

`.githooks/pre-push:235` currently reads:

```sh
  TEST_FILES=$(git ls-files '*.test.js' '*.test.mjs')
```

Change it to:

```sh
  TEST_FILES=$(git ls-files '*.test.js' '*.test.mjs' '*.test.ts')
```

Without this the new tests never run in the gate, and a push reports green having executed none of them.

- [ ] **Step 6: Install and verify the type gate runs**

```bash
cd home/dot_local/share/pr-dash && npm install
```

Run: `cd home/dot_local/share/pr-dash && npm run check`
Expected: exits 0, no output.

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/share/pr-dash/package.json \
        home/dot_local/share/pr-dash/package-lock.json \
        home/dot_local/share/pr-dash/tsconfig.json \
        home/dot_local/share/pr-dash/src/types.ts \
        .gitignore .chezmoiignore .githooks/pre-push
git commit -m "Scaffold pr-dash with its type gate and test discovery

The pre-push suite globs only *.test.js and *.test.mjs, so a .test.ts
file would never run and the push would still report green. Added the
glob alongside the scaffolding that needs it."
```

### Task 2: The request guard

**Files:**
- Create: `home/dot_local/share/pr-dash/src/guard.ts`
- Create: `home/dot_local/share/pr-dash/tests/guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `checkRequest(headers, expected) => { ok: true } | { ok: false, reason: string }` where `headers` is `Record<string, string | string[] | undefined>` and `expected` is `{ host: string; secret: string }`.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/pr-dash/tests/guard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { checkRequest } from '../src/guard.ts';

const expected = { host: '127.0.0.1:8770', secret: 'sekrit' };
const good = {
  host: '127.0.0.1:8770',
  origin: 'http://127.0.0.1:8770',
  'x-pr-dash-secret': 'sekrit',
};

test('accepts a well-formed same-origin request', () => {
  assert.deepStrictEqual(checkRequest(good, expected), { ok: true });
});

test('accepts localhost as an alias for 127.0.0.1', () => {
  const r = checkRequest({ ...good, host: 'localhost:8770' }, { ...expected, host: 'localhost:8770' });
  assert.strictEqual(r.ok, true);
});

test('rejects an attacker hostname resolved to loopback', () => {
  const r = checkRequest({ ...good, host: 'evil.example.com:8770' }, expected);
  assert.strictEqual(r.ok, false);
});

test('rejects a cross-origin request', () => {
  const r = checkRequest({ ...good, origin: 'https://evil.example.com' }, expected);
  assert.strictEqual(r.ok, false);
});

test('rejects a missing secret', () => {
  const { 'x-pr-dash-secret': _omit, ...noSecret } = good;
  const r = checkRequest(noSecret, expected);
  assert.strictEqual(r.ok, false);
});

test('rejects a wrong secret', () => {
  const r = checkRequest({ ...good, 'x-pr-dash-secret': 'nope' }, expected);
  assert.strictEqual(r.ok, false);
});

test('allows an absent Origin, which same-origin GETs omit', () => {
  const { origin: _omit, ...noOrigin } = good;
  assert.deepStrictEqual(checkRequest(noOrigin, expected), { ok: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/guard.test.ts`
Expected: FAIL — cannot find module `../src/guard.ts`.

- [ ] **Step 3: Implement the guard**

`home/dot_local/share/pr-dash/src/guard.ts`:

```ts
export type GuardResult = { ok: true } | { ok: false; reason: string };

export type Expected = { host: string; secret: string };

type Headers = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function checkRequest(headers: Headers, expected: Expected): GuardResult {
  const host = one(headers['host']);
  if (host !== expected.host) {
    return { ok: false, reason: `unexpected Host: ${String(host)}` };
  }

  const origin = one(headers['origin']);
  if (origin !== undefined && origin !== `http://${expected.host}`) {
    return { ok: false, reason: `cross-origin request from ${origin}` };
  }

  const secret = one(headers['x-pr-dash-secret']);
  if (secret !== expected.secret) {
    return { ok: false, reason: 'missing or incorrect secret' };
  }

  return { ok: true };
}
```

An absent `Origin` is allowed because same-origin navigations and GETs omit it; the secret is what actually authenticates those.

- [ ] **Step 4: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/guard.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/share/pr-dash/src/guard.ts home/dot_local/share/pr-dash/tests/guard.test.ts
git commit -m "Add the pr-dash request guard

127.0.0.1 is not a security boundary: any page in the browser can
reach a loopback server, and DNS rebinding defeats a naive check. The
guard ships now, against a read-only surface, rather than being
retrofitted alongside the first mutating route."
```

### Task 3: Server serving fixture data

**Files:**
- Create: `home/dot_local/share/pr-dash/src/cache.ts`
- Create: `home/dot_local/share/pr-dash/src/server.ts`
- Create: `home/dot_local/share/pr-dash/tests/fixtures/records.json`
- Create: `home/dot_local/share/pr-dash/tests/server.test.ts`
- Create: `home/dot_local/bin/executable_pr-dash`

**Interfaces:**
- Consumes: `checkRequest` (Task 2), `PrRecord` (Task 1).
- Produces: `createCache<T>(ttlMs) => { get(): T | undefined; set(v: T): void; invalidate(): void }`; `createServer(opts) => http.Server` where `opts` is `{ secret: string; port: number; loadPrs: () => Promise<PrRecord[]> }`.

- [ ] **Step 1: Write the fixture**

`home/dot_local/share/pr-dash/tests/fixtures/records.json` — two records, enough to prove routing:

```json
[
  {
    "id": "acme/api#12", "repo": "acme/api", "number": 12,
    "title": "Add retry budget", "url": "https://github.com/acme/api/pull/12",
    "headRef": "retry-budget", "baseRef": "main", "isDraft": false,
    "ci": "success", "review": "approved",
    "openedAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
    "ageDays": 13, "staleDays": 4, "additions": 120, "deletions": 8
  },
  {
    "id": "acme/web#7", "repo": "acme/web", "number": 7,
    "title": "Fix nav overflow", "url": "https://github.com/acme/web/pull/7",
    "headRef": "nav-overflow", "baseRef": "main", "isDraft": true,
    "ci": "failure", "review": "none",
    "openedAt": "2026-09-12T00:00:00Z", "updatedAt": "2026-09-13T00:00:00Z",
    "ageDays": 2, "staleDays": 1, "additions": 9, "deletions": 3
  }
]
```

- [ ] **Step 2: Write the failing tests**

`home/dot_local/share/pr-dash/tests/server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createServer } from '../src/server.ts';
import { createCache } from '../src/cache.ts';
import type { PrRecord } from '../src/types.ts';

const records: PrRecord[] = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
);

async function withServer(fn: (base: string, secret: string) => Promise<void>) {
  const secret = 'test-secret';
  const server = createServer({ secret, loadPrs: async () => records });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  try {
    await fn(`http://127.0.0.1:${addr.port}`, secret);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('serves records on /api/prs with the secret', async () => {
  await withServer(async (base, secret) => {
    const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.prs.length, 2);
    assert.strictEqual(body.prs[0].id, 'acme/api#12');
  });
});

test('rejects /api/prs without the secret', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/prs`);
    assert.strictEqual(res.status, 403);
  });
});

test('cache returns a value until invalidated', () => {
  const c = createCache<number>(60_000);
  assert.strictEqual(c.get(), undefined);
  c.set(41);
  assert.strictEqual(c.get(), 41);
  c.invalidate();
  assert.strictEqual(c.get(), undefined);
});

test('cache expires after its ttl', () => {
  const c = createCache<number>(-1);
  c.set(1);
  assert.strictEqual(c.get(), undefined);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/server.test.ts`
Expected: FAIL — cannot find module `../src/server.ts`.

- [ ] **Step 4: Implement the cache**

`home/dot_local/share/pr-dash/src/cache.ts`:

```ts
export type Cache<T> = {
  get(): T | undefined;
  set(value: T): void;
  invalidate(): void;
};

export function createCache<T>(ttlMs: number): Cache<T> {
  let value: T | undefined;
  let storedAt = 0;

  return {
    get() {
      if (value === undefined) return undefined;
      if (Date.now() - storedAt > ttlMs) return undefined;
      return value;
    },
    set(v: T) {
      value = v;
      storedAt = Date.now();
    },
    invalidate() {
      value = undefined;
    },
  };
}
```

- [ ] **Step 5: Implement the server**

`home/dot_local/share/pr-dash/src/server.ts`:

```ts
import { createServer as createHttpServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRequest } from './guard.ts';
import type { PrRecord } from './types.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export type ServerOpts = {
  secret: string;
  loadPrs: () => Promise<PrRecord[]>;
};

export function createServer(opts: ServerOpts): Server {
  return createHttpServer((req, res) => {
    void handle(req, res, opts).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
}

async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  opts: ServerOpts,
): Promise<void> {
  const hostHeader = req.headers.host ?? '';
  const guard = checkRequest(req.headers, { host: hostHeader, secret: opts.secret });

  const url = new URL(req.url ?? '/', `http://${hostHeader}`);

  // The shell is fetched by the browser's address bar, which cannot send a
  // header, so it is served before the secret check. It contains no PR data.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic('index.html', res);
  }

  if (url.pathname === '/api/prs') {
    if (!guard.ok) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: guard.reason }));
      return;
    }
    const prs = await opts.loadPrs();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ prs, fetchedAt: new Date().toISOString() }));
    return;
  }

  return serveStatic(url.pathname.replace(/^\//, ''), res);
}

async function serveStatic(name: string, res: import('node:http').ServerResponse): Promise<void> {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, '');
  const path = join(PUBLIC_DIR, safe);
  if (!path.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}
```

Note the `host` passed to the guard is the request's own `Host` header, so the guard's host check is a tautology here. Task 12 replaces it with the launcher's expected host; until then the `Origin` and secret checks carry the guard, which is what the tests exercise.

- [ ] **Step 6: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/server.test.ts`
Expected: 4 pass, 0 fail.

- [ ] **Step 7: Write the launcher**

`home/dot_local/bin/executable_pr-dash`:

```bash
#!/usr/bin/env bash
# Launch the PR dashboard on a loopback port and open it.
set -euo pipefail

SHARE_DIR="${HOME}/.local/share/pr-dash"
PORT="${PR_DASH_PORT:-8770}"
PR_DASH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export PR_DASH_SECRET PR_DASH_PORT="$PORT"

node "${SHARE_DIR}/src/main.ts" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

sleep 0.4
open "http://127.0.0.1:${PORT}/#${PR_DASH_SECRET}"
wait "$SERVER_PID"
```

- [ ] **Step 8: Create the entry point**

`home/dot_local/share/pr-dash/src/main.ts`:

```ts
import { readFileSync } from 'node:fs';
import { createServer } from './server.ts';
import type { PrRecord } from './types.ts';

const secret = process.env['PR_DASH_SECRET'];
if (secret === undefined || secret === '') {
  console.error('PR_DASH_SECRET is not set. Start the dashboard with `pr-dash`.');
  process.exit(1);
}
const port = Number(process.env['PR_DASH_PORT'] ?? 8770);

// Slice 1 serves the fixture. Task 8 replaces this with the GitHub fetch.
const fixture: PrRecord[] = JSON.parse(
  readFileSync(new URL('../tests/fixtures/records.json', import.meta.url), 'utf8'),
);

const server = createServer({ secret, loadPrs: async () => fixture });
server.listen(port, '127.0.0.1', () => {
  console.log(`pr-dash listening on http://127.0.0.1:${port}`);
});
```

- [ ] **Step 9: Verify end to end by hand**

```bash
cd home/dot_local/share/pr-dash && PR_DASH_SECRET=abc PR_DASH_PORT=8770 node src/main.ts
```

In another shell:

```bash
curl -s -H 'x-pr-dash-secret: abc' http://127.0.0.1:8770/api/prs | head -c 200
```

Expected: JSON with two PRs. Then confirm `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8770/api/prs` prints `403`.

- [ ] **Step 10: Commit**

```bash
git add home/dot_local/share/pr-dash/src home/dot_local/share/pr-dash/tests home/dot_local/bin/executable_pr-dash
git commit -m "Serve fixture PRs from the pr-dash server

Slice 1: the process starts, the guard rejects unauthenticated calls,
and /api/prs returns records. Nothing reaches GitHub yet, so the whole
slice is exercisable offline."
```

---

## Slice 2 — The page renders, grouped by repository

At the end of this slice: opening `pr-dash` shows the fixture PRs grouped under repository headings. Still no GitHub.

### Task 4: Grouping logic

**Files:**
- Create: `home/dot_local/share/pr-dash/public/group.js`
- Create: `home/dot_local/share/pr-dash/tests/group.test.ts`

**Interfaces:**
- Consumes: `PrRecord` (Task 1).
- Produces: `groupBy(records, axis) => { key: string, records: PrRecord[] }[]` with `axis` one of `'repo' | 'ci' | 'review' | 'staleness' | 'draft'`; `sortWithin(records, sort)` with `sort` one of `'stale' | 'age' | 'title' | 'size'`.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/pr-dash/tests/group.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { groupBy, sortWithin, stalenessBucket } from '../public/group.js';
import type { PrRecord } from '../src/types.ts';

const records: PrRecord[] = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
);

test('groups by repository, alphabetically', () => {
  const groups = groupBy(records, 'repo');
  assert.deepStrictEqual(groups.map((g) => g.key), ['acme/api', 'acme/web']);
  assert.strictEqual(groups[0].records.length, 1);
});

test('groups by ci status', () => {
  const groups = groupBy(records, 'ci');
  const keys = groups.map((g) => g.key).sort();
  assert.deepStrictEqual(keys, ['failure', 'success']);
});

test('groups by draft state', () => {
  const groups = groupBy(records, 'draft');
  assert.deepStrictEqual(groups.map((g) => g.key).sort(), ['draft', 'ready']);
});

test('staleness buckets partition by days since update', () => {
  assert.strictEqual(stalenessBucket(0), '<1d');
  assert.strictEqual(stalenessBucket(2), '1-3d');
  assert.strictEqual(stalenessBucket(5), '3-7d');
  assert.strictEqual(stalenessBucket(30), '>7d');
});

test('sorts by staleness, most stale first', () => {
  const sorted = sortWithin(records, 'stale');
  assert.strictEqual(sorted[0].id, 'acme/api#12');
});

test('sorts by size, largest diff first', () => {
  const sorted = sortWithin(records, 'size');
  assert.strictEqual(sorted[0].id, 'acme/api#12');
});

test('does not mutate its input', () => {
  const before = records.map((r) => r.id);
  sortWithin(records, 'title');
  assert.deepStrictEqual(records.map((r) => r.id), before);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/group.test.ts`
Expected: FAIL — cannot find module `../public/group.js`.

- [ ] **Step 3: Implement grouping**

`home/dot_local/share/pr-dash/public/group.js`:

```js
// @ts-check
/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {'repo' | 'ci' | 'review' | 'staleness' | 'draft'} Axis */
/** @typedef {'stale' | 'age' | 'title' | 'size'} Sort */

/**
 * @param {number} staleDays
 * @returns {string}
 */
export function stalenessBucket(staleDays) {
  if (staleDays < 1) return '<1d';
  if (staleDays <= 3) return '1-3d';
  if (staleDays <= 7) return '3-7d';
  return '>7d';
}

/**
 * @param {PrRecord} pr
 * @param {Axis} axis
 * @returns {string}
 */
function keyFor(pr, axis) {
  switch (axis) {
    case 'repo': return pr.repo;
    case 'ci': return pr.ci;
    case 'review': return pr.review;
    case 'staleness': return stalenessBucket(pr.staleDays);
    case 'draft': return pr.isDraft ? 'draft' : 'ready';
  }
}

/**
 * @param {readonly PrRecord[]} records
 * @param {Axis} axis
 * @returns {{ key: string, records: PrRecord[] }[]}
 */
export function groupBy(records, axis) {
  /** @type {Map<string, PrRecord[]>} */
  const buckets = new Map();
  for (const pr of records) {
    const key = keyFor(pr, axis);
    const existing = buckets.get(key);
    if (existing === undefined) buckets.set(key, [pr]);
    else existing.push(pr);
  }
  return [...buckets.entries()]
    .map(([key, rs]) => ({ key, records: rs }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * @param {readonly PrRecord[]} records
 * @param {Sort} sort
 * @returns {PrRecord[]}
 */
export function sortWithin(records, sort) {
  const copy = [...records];
  switch (sort) {
    case 'stale': return copy.sort((a, b) => b.staleDays - a.staleDays);
    case 'age': return copy.sort((a, b) => b.ageDays - a.ageDays);
    case 'title': return copy.sort((a, b) => a.title.localeCompare(b.title));
    case 'size':
      return copy.sort(
        (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions),
      );
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/group.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Verify the type gate still passes**

Run: `cd home/dot_local/share/pr-dash && npm run check`
Expected: exits 0. This is the first file proving a `.js` module type-checks against a `.ts` type.

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/share/pr-dash/public/group.js home/dot_local/share/pr-dash/tests/group.test.ts
git commit -m "Add pr-dash grouping and sorting

Pure functions in their own module so they are testable without a DOM;
app.js keeps the rendering. This is also the first browser module to
type-check against the server's PrRecord via JSDoc."
```

### Task 5: The page

**Files:**
- Create: `home/dot_local/share/pr-dash/public/index.html`
- Create: `home/dot_local/share/pr-dash/public/app.js`
- Create: `home/dot_local/share/pr-dash/public/style.css`

**Interfaces:**
- Consumes: `groupBy`, `sortWithin` (Task 4); `/api/prs` (Task 3).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the page shell**

`home/dot_local/share/pr-dash/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PR Dashboard</title>
<link rel="stylesheet" href="./style.css">
</head>
<body>
<header>
  <h1>Open PRs</h1>
  <label>Group by
    <select id="group-by">
      <option value="repo">Repository</option>
      <option value="ci">CI status</option>
      <option value="review">Review state</option>
      <option value="staleness">Staleness</option>
      <option value="draft">Draft</option>
    </select>
  </label>
  <label>Sort
    <select id="sort-by">
      <option value="stale">Staleness</option>
      <option value="age">Age</option>
      <option value="title">Title</option>
      <option value="size">Size</option>
    </select>
  </label>
  <button id="refresh" type="button">Refresh</button>
</header>
<div id="banner" hidden></div>
<main id="groups"></main>
<script type="module" src="./app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write the client**

`home/dot_local/share/pr-dash/public/app.js`:

```js
// @ts-check
import { groupBy, sortWithin } from './group.js';

/** @typedef {import('../src/types.ts').PrRecord} PrRecord */

const secret = location.hash.replace(/^#/, '');

/** @returns {Promise<PrRecord[]>} */
async function loadPrs() {
  const res = await fetch('/api/prs', { headers: { 'x-pr-dash-secret': secret } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.prs;
}

/** @param {string} message */
function showBanner(message) {
  const el = document.getElementById('banner');
  if (el === null) return;
  el.textContent = message;
  el.hidden = false;
}

/** @param {PrRecord} pr */
function renderRow(pr) {
  const row = document.createElement('a');
  row.className = `row ci-${pr.ci} review-${pr.review}`;
  row.href = pr.url;
  row.target = '_blank';
  row.rel = 'noreferrer';
  row.textContent = `#${pr.number} ${pr.title}`;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${pr.ci} · ${pr.review} · ${pr.staleDays}d`;
  row.append(meta);
  return row;
}

/** @param {PrRecord[]} records */
function render(records) {
  const host = document.getElementById('groups');
  const groupSel = document.getElementById('group-by');
  const sortSel = document.getElementById('sort-by');
  if (host === null || !(groupSel instanceof HTMLSelectElement) || !(sortSel instanceof HTMLSelectElement)) return;

  const axis = /** @type {import('./group.js').Axis} */ (groupSel.value);
  const sort = /** @type {import('./group.js').Sort} */ (sortSel.value);

  host.replaceChildren();
  for (const group of groupBy(records, axis)) {
    const section = document.createElement('section');
    const h2 = document.createElement('h2');
    h2.textContent = `${group.key} (${group.records.length})`;
    section.append(h2, ...sortWithin(group.records, sort).map(renderRow));
    host.append(section);
  }
}

/** @type {PrRecord[]} */
let current = [];

async function refresh() {
  try {
    current = await loadPrs();
    const banner = document.getElementById('banner');
    if (banner !== null) banner.hidden = true;
    render(current);
  } catch (err) {
    showBanner(`Could not refresh: ${String(err)}`);
    if (current.length > 0) render(current);
  }
}

for (const id of ['group-by', 'sort-by']) {
  document.getElementById(id)?.addEventListener('change', () => render(current));
}
document.getElementById('refresh')?.addEventListener('click', () => void refresh());

void refresh();
```

- [ ] **Step 3: Write minimal styles**

`home/dot_local/share/pr-dash/public/style.css`:

```css
:root { color-scheme: dark; --bg:#1e1e2e; --fg:#cdd6f4; --dim:#a6adc8; --line:#45475a;
        --green:#a6e3a1; --red:#f38ba8; --yellow:#f9e2af; }
body { margin:0; background:var(--bg); color:var(--fg);
       font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { display:flex; gap:16px; align-items:center; flex-wrap:wrap;
         padding:16px 24px; border-bottom:1px solid var(--line); }
h1 { font-size:18px; margin:0 auto 0 0; }
main { padding:8px 24px 48px; }
h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em;
     color:var(--dim); margin:28px 0 8px; }
.row { display:flex; justify-content:space-between; gap:16px; padding:8px 12px;
       border-bottom:1px solid var(--line); color:var(--fg); text-decoration:none; }
.row:hover { background:#313244; }
.meta { color:var(--dim); font-size:13px; white-space:nowrap; }
.ci-success .meta { color:var(--green); }
.ci-failure .meta { color:var(--red); }
.ci-pending .meta { color:var(--yellow); }
#banner { margin:0; padding:10px 24px; background:#45293a; color:var(--red); }
```

- [ ] **Step 4: Verify the type gate**

Run: `cd home/dot_local/share/pr-dash && npm run check`
Expected: exits 0.

- [ ] **Step 5: Verify in the browser**

```bash
cd home/dot_local/share/pr-dash && PR_DASH_SECRET=abc PR_DASH_PORT=8770 node src/main.ts
```

Open `http://127.0.0.1:8770/#abc`. Expected: two rows under `acme/api` and `acme/web`. Change "Group by" to CI status and confirm the headings become `failure` and `success`.

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/share/pr-dash/public
git commit -m "Render the pr-dash page against fixture data

Slice 2: the dashboard is usable end to end offline. Group-by and sort
work; only the data source is still a fixture."
```

---

## Slice 3 — Real data from GitHub

At the end of this slice: the dashboard shows my actual open PRs.

### Task 6: Token resolution

**Files:**
- Create: `home/dot_local/share/pr-dash/src/token.ts`
- Create: `home/dot_local/share/pr-dash/tests/token.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveToken(env, runOp) => Promise<string>`, where `runOp: (itemRef: string) => Promise<string>` is injected so tests never shell out.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/pr-dash/tests/token.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveToken, DEFAULT_ITEM } from '../src/token.ts';

test('GH_TOKEN wins over op', async () => {
  const token = await resolveToken({ GH_TOKEN: 'from-env' }, async () => 'from-op');
  assert.strictEqual(token, 'from-env');
});

test('falls through to op when GH_TOKEN is absent', async () => {
  const token = await resolveToken({}, async () => 'from-op');
  assert.strictEqual(token, 'from-op');
});

test('reads the default item reference', async () => {
  let seen = '';
  await resolveToken({}, async (ref) => { seen = ref; return 't'; });
  assert.strictEqual(seen, DEFAULT_ITEM);
});

test('PR_DASH_OP_ITEM overrides the item reference', async () => {
  let seen = '';
  await resolveToken({ PR_DASH_OP_ITEM: 'op://Work/Other/token' }, async (ref) => { seen = ref; return 't'; });
  assert.strictEqual(seen, 'op://Work/Other/token');
});

test('a failing op read raises an error naming the command', async () => {
  await assert.rejects(
    () => resolveToken({}, async () => { throw new Error('not signed in'); }),
    (err: Error) => err.message.includes('op read') && err.message.includes(DEFAULT_ITEM),
  );
});

test('an empty op result is treated as failure, not as an empty token', async () => {
  await assert.rejects(() => resolveToken({}, async () => '  '));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/token.test.ts`
Expected: FAIL — cannot find module `../src/token.ts`.

- [ ] **Step 3: Implement token resolution**

`home/dot_local/share/pr-dash/src/token.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_ITEM = 'op://Private/GitHub PR Dashboard/token';

export type Env = Record<string, string | undefined>;
export type RunOp = (itemRef: string) => Promise<string>;

export async function runOpRead(itemRef: string): Promise<string> {
  const { stdout } = await execFileAsync('op', ['read', itemRef]);
  return stdout;
}

export async function resolveToken(env: Env, runOp: RunOp = runOpRead): Promise<string> {
  const fromEnv = env['GH_TOKEN']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const itemRef = env['PR_DASH_OP_ITEM']?.trim() || DEFAULT_ITEM;

  let raw: string;
  try {
    raw = await runOp(itemRef);
  } catch (cause) {
    throw new Error(
      `Could not read the GitHub token from 1Password. Run:\n\n  op read "${itemRef}"\n\n` +
        `to see why. Set GH_TOKEN to bypass 1Password.`,
      { cause },
    );
  }

  const token = raw.trim();
  if (token === '') {
    throw new Error(`1Password returned an empty token for "${itemRef}".`);
  }
  return token;
}
```

There is deliberately no `gh auth token` fallback: it returns write scopes, and falling back would silently re-broaden them.

- [ ] **Step 4: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/token.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/share/pr-dash/src/token.ts home/dot_local/share/pr-dash/tests/token.test.ts
git commit -m "Resolve the pr-dash token from 1Password

gh auth token returns whatever scopes gh negotiated -- in practice repo
write. A dedicated item makes the read-only claim true, and there is no
fallback because falling back would re-broaden the scope precisely when
1Password is unavailable."
```

### Task 7: Normalization

**Files:**
- Create: `home/dot_local/share/pr-dash/src/normalize.ts`
- Create: `home/dot_local/share/pr-dash/tests/fixtures/graphql-page.json`
- Create: `home/dot_local/share/pr-dash/tests/normalize.test.ts`

**Interfaces:**
- Consumes: `PrRecord`, `Ci`, `Review` (Task 1).
- Produces: `normalize(nodes, now) => PrRecord[]`, where `now` is a `Date` injected so age arithmetic is deterministic.

- [ ] **Step 1: Write the fixture**

`home/dot_local/share/pr-dash/tests/fixtures/graphql-page.json` — four nodes covering the null cases:

```json
[
  {
    "number": 12, "title": "Add retry budget", "url": "https://github.com/acme/api/pull/12",
    "isDraft": false, "baseRefName": "main", "headRefName": "retry-budget",
    "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z",
    "additions": 120, "deletions": 8, "reviewDecision": "APPROVED",
    "repository": { "nameWithOwner": "acme/api" },
    "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] }
  },
  {
    "number": 7, "title": "No checks configured", "url": "https://github.com/acme/web/pull/7",
    "isDraft": true, "baseRefName": "main", "headRefName": "nav-overflow",
    "createdAt": "2026-09-12T00:00:00Z", "updatedAt": "2026-09-13T00:00:00Z",
    "additions": 9, "deletions": 3, "reviewDecision": null,
    "repository": { "nameWithOwner": "acme/web" },
    "commits": { "nodes": [{ "commit": { "statusCheckRollup": null } }] }
  },
  {
    "number": 8, "title": "Changes requested", "url": "https://github.com/acme/web/pull/8",
    "isDraft": false, "baseRefName": "main", "headRefName": "fix-auth",
    "createdAt": "2026-09-05T00:00:00Z", "updatedAt": "2026-09-06T00:00:00Z",
    "additions": 40, "deletions": 40, "reviewDecision": "CHANGES_REQUESTED",
    "repository": { "nameWithOwner": "acme/web" },
    "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] }
  },
  {
    "number": 9, "title": "No commits edge case", "url": "https://github.com/acme/web/pull/9",
    "isDraft": false, "baseRefName": "main", "headRefName": "empty",
    "createdAt": "2026-09-05T00:00:00Z", "updatedAt": "2026-09-05T00:00:00Z",
    "additions": 0, "deletions": 0, "reviewDecision": "REVIEW_REQUIRED",
    "repository": { "nameWithOwner": "acme/web" },
    "commits": { "nodes": [] }
  }
]
```

- [ ] **Step 2: Write the failing tests**

`home/dot_local/share/pr-dash/tests/normalize.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/normalize.ts';

const nodes = JSON.parse(
  readFileSync(new URL('./fixtures/graphql-page.json', import.meta.url), 'utf8'),
);
const NOW = new Date('2026-09-14T00:00:00Z');

test('builds a stable id from repo and number', () => {
  const [first] = normalize(nodes, NOW);
  assert.strictEqual(first.id, 'acme/api#12');
});

test('maps a SUCCESS rollup to success', () => {
  assert.strictEqual(normalize(nodes, NOW)[0].ci, 'success');
});

test('a null statusCheckRollup is none, not pending', () => {
  assert.strictEqual(normalize(nodes, NOW)[1].ci, 'none');
});

test('a null reviewDecision is none, not review_required', () => {
  assert.strictEqual(normalize(nodes, NOW)[1].review, 'none');
});

test('maps CHANGES_REQUESTED', () => {
  assert.strictEqual(normalize(nodes, NOW)[2].review, 'changes_requested');
});

test('a PR with no commits is none rather than a crash', () => {
  assert.strictEqual(normalize(nodes, NOW)[3].ci, 'none');
});

test('computes age and staleness in whole days from now', () => {
  const [first] = normalize(nodes, NOW);
  assert.strictEqual(first.ageDays, 13);
  assert.strictEqual(first.staleDays, 4);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/normalize.test.ts`
Expected: FAIL — cannot find module `../src/normalize.ts`.

- [ ] **Step 4: Implement normalization**

`home/dot_local/share/pr-dash/src/normalize.ts`:

```ts
import type { Ci, PrRecord, Review } from './types.ts';

export type RawPr = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  repository: { nameWithOwner: string };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};

const CI_BY_STATE: Record<string, Ci> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

const REVIEW_BY_DECISION: Record<string, Review> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

function days(from: string, to: Date): number {
  const ms = to.getTime() - new Date(from).getTime();
  return Math.floor(ms / 86_400_000);
}

export function normalize(nodes: readonly RawPr[], now: Date = new Date()): PrRecord[] {
  return nodes.map((n) => {
    const state = n.commits.nodes[0]?.commit.statusCheckRollup?.state;
    return {
      id: `${n.repository.nameWithOwner}#${n.number}`,
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      url: n.url,
      headRef: n.headRefName,
      baseRef: n.baseRefName,
      isDraft: n.isDraft,
      ci: state === undefined ? 'none' : (CI_BY_STATE[state] ?? 'pending'),
      review: n.reviewDecision === null ? 'none' : (REVIEW_BY_DECISION[n.reviewDecision] ?? 'none'),
      openedAt: n.createdAt,
      updatedAt: n.updatedAt,
      ageDays: days(n.createdAt, now),
      staleDays: days(n.updatedAt, now),
      additions: n.additions,
      deletions: n.deletions,
    };
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/normalize.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/share/pr-dash/src/normalize.ts home/dot_local/share/pr-dash/tests/normalize.test.ts home/dot_local/share/pr-dash/tests/fixtures/graphql-page.json
git commit -m "Normalize GitHub PR nodes to flat records

A null statusCheckRollup means no checks ran and a null reviewDecision
means none is required; both map to 'none'. Folding them into 'pending'
would paint every PR in a repo without CI permanently yellow."
```

### Task 8: Fetch from GitHub and wire it in

**Files:**
- Create: `home/dot_local/share/pr-dash/src/github.ts`
- Create: `home/dot_local/share/pr-dash/src/queries.ts`
- Create: `home/dot_local/share/pr-dash/tests/github.test.ts`
- Modify: `home/dot_local/share/pr-dash/src/main.ts`

**Interfaces:**
- Consumes: `resolveToken` (Task 6), `normalize` / `RawPr` (Task 7), `createCache` (Task 3).
- Produces: `createClient({ token, fetchImpl }) => { query<T>(q, vars) => Promise<T> }`; `fetchAllPrs(client) => Promise<RawPr[]>`.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/pr-dash/tests/github.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { createClient } from '../src/github.ts';
import { fetchAllPrs } from '../src/queries.ts';

function pageResponse(nodes: unknown[], hasNextPage: boolean, endCursor: string | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { search: { pageInfo: { hasNextPage, endCursor }, nodes } } }),
    text: async () => '',
  } as Response;
}

test('sends the token as a bearer header', async () => {
  let seenAuth = '';
  const client = createClient({
    token: 'tok',
    fetchImpl: async (_url, init) => {
      seenAuth = String(new Headers(init?.headers).get('authorization'));
      return pageResponse([], false, null);
    },
  });
  await fetchAllPrs(client);
  assert.strictEqual(seenAuth, 'Bearer tok');
});

test('follows pagination until hasNextPage is false', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? pageResponse([{ number: 1 }], true, 'cur')
        : pageResponse([{ number: 2 }], false, null);
    },
  });
  const nodes = await fetchAllPrs(client);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(nodes.map((n: { number: number }) => n.number), [1, 2]);
});

test('a 401 raises an error naming the 1Password item', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Bad credentials' } as Response),
  });
  await assert.rejects(() => fetchAllPrs(client), (e: Error) => /expired or revoked/.test(e.message));
});

test('GraphQL errors surface rather than yielding an empty list', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: 'rate limited' }] }),
        text: async () => '',
      } as Response),
  });
  await assert.rejects(() => fetchAllPrs(client), (e: Error) => /rate limited/.test(e.message));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/github.test.ts`
Expected: FAIL — cannot find module `../src/github.ts`.

- [ ] **Step 3: Implement the transport**

`home/dot_local/share/pr-dash/src/github.ts`:

```ts
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type ClientOpts = { token: string; fetchImpl?: FetchImpl };

export type Client = {
  query<T>(query: string, variables: Record<string, unknown>): Promise<T>;
};

const ENDPOINT = 'https://api.github.com/graphql';

export function createClient(opts: ClientOpts): Client {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      const res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 401) {
        throw new Error(
          'GitHub rejected the token (401): it is expired or revoked. ' +
            'Renew it in 1Password, then restart pr-dash.',
        );
      }
      if (!res.ok) {
        throw new Error(`GitHub returned ${res.status}: ${await res.text()}`);
      }

      const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (body.errors !== undefined && body.errors.length > 0) {
        throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
      }
      if (body.data === undefined) {
        throw new Error('GraphQL response contained no data');
      }
      return body.data;
    },
  };
}
```

- [ ] **Step 4: Implement the queries**

`home/dot_local/share/pr-dash/src/queries.ts`:

```ts
import type { Client } from './github.ts';
import type { RawPr } from './normalize.ts';

export const PR_FIELDS = `
  number title url isDraft baseRefName headRefName
  createdAt updatedAt additions deletions reviewDecision
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const SEARCH = `
query($cursor: String) {
  search(query: "is:open is:pr author:@me", type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

type SearchData = {
  search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawPr[] };
};

export async function fetchAllPrs(client: Client): Promise<RawPr[]> {
  /** @see PR_FIELDS — fetch-one reuses the same field list. */
  const all: RawPr[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: SearchData = await client.query<SearchData>(SEARCH, { cursor });
    all.push(...data.search.nodes);
    if (!data.search.pageInfo.hasNextPage) break;
    cursor = data.search.pageInfo.endCursor;
  }

  return all;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/github.test.ts`
Expected: 4 pass, 0 fail.

- [ ] **Step 6: Replace the fixture in the entry point**

Rewrite `home/dot_local/share/pr-dash/src/main.ts`:

```ts
import { createServer } from './server.ts';
import { createClient } from './github.ts';
import { fetchAllPrs } from './queries.ts';
import { normalize } from './normalize.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';
import type { PrRecord } from './types.ts';

const secret = process.env['PR_DASH_SECRET'];
if (secret === undefined || secret === '') {
  console.error('PR_DASH_SECRET is not set. Start the dashboard with `pr-dash`.');
  process.exit(1);
}
const port = Number(process.env['PR_DASH_PORT'] ?? 8770);

let token: string;
try {
  token = await resolveToken(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const client = createClient({ token });
const cache = createCache<PrRecord[]>(60_000);

async function loadPrs(): Promise<PrRecord[]> {
  const hit = cache.get();
  if (hit !== undefined) return hit;
  const records = normalize(await fetchAllPrs(client));
  cache.set(records);
  return records;
}

const server = createServer({ secret, loadPrs });
server.listen(port, '127.0.0.1', () => {
  console.log(`pr-dash listening on http://127.0.0.1:${port}`);
});
```

- [ ] **Step 7: Verify against real GitHub**

This step cannot run inside the Claude sandbox — `~/.config/gh` is read-denied, `github.com` is network-denied, and `op` cannot reach its socket. Run it in an ordinary terminal:

```bash
pr-dash
```

Expected: the browser opens and shows real PRs grouped by repository. If the token is missing, the error names the `op read` command.

- [ ] **Step 8: Commit**

```bash
git add home/dot_local/share/pr-dash/src home/dot_local/share/pr-dash/tests/github.test.ts
git commit -m "Fetch real PRs from the GitHub GraphQL API

One paginated search query supplies every field the dashboard needs, so
there is no per-PR follow-up call. A 401 is distinguished from other
failures because it means the token expired, not that the network did."
```

---

## Slice 4 — Stacks

### Task 9: Reconstruct stacks from branch refs

**Files:**
- Create: `home/dot_local/share/pr-dash/src/stacks.ts`
- Create: `home/dot_local/share/pr-dash/tests/stacks.test.ts`
- Modify: `home/dot_local/share/pr-dash/public/app.js`

**Interfaces:**
- Consumes: `PrRecord`, `StackNode` (Task 1).
- Produces: `buildStacks(records) => StackNode[]` returning roots in repository-then-number order.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/pr-dash/tests/stacks.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { buildStacks } from '../src/stacks.ts';
import type { PrRecord } from '../src/types.ts';

function pr(repo: string, number: number, headRef: string, baseRef: string): PrRecord {
  return {
    id: `${repo}#${number}`, repo, number, title: `pr ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    headRef, baseRef, isDraft: false, ci: 'none', review: 'none',
    openedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    ageDays: 0, staleDays: 0, additions: 0, deletions: 0,
  };
}

test('a linear chain of four nests with positions', () => {
  const roots = buildStacks([
    pr('a/b', 1, 'f1', 'main'),
    pr('a/b', 2, 'f2', 'f1'),
    pr('a/b', 3, 'f3', 'f2'),
    pr('a/b', 4, 'f4', 'f3'),
  ]);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].position, 1);
  assert.strictEqual(roots[0].stackSize, 4);
  assert.strictEqual(roots[0].children[0].children[0].children[0].pr.number, 4);
  assert.strictEqual(roots[0].children[0].children[0].children[0].position, 4);
});

test('two PRs sharing one base fork the tree', () => {
  const roots = buildStacks([
    pr('a/b', 1, 'f1', 'main'),
    pr('a/b', 2, 'f2', 'f1'),
    pr('a/b', 3, 'f3', 'f1'),
  ]);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].children.length, 2);
});

test('a dangling base becomes a flagged root', () => {
  const roots = buildStacks([pr('a/b', 2, 'f2', 'f1-merged-away')]);
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0].danglingBase, true);
});

test('a PR based on trunk is not flagged', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main')]);
  assert.strictEqual(roots[0].danglingBase, false);
});

test('identical branch names in different repos do not link', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'main'), pr('c/d', 2, 'f2', 'f1')]);
  assert.strictEqual(roots.length, 2);
});

test('a cycle terminates and renders flat rather than hanging', () => {
  const roots = buildStacks([pr('a/b', 1, 'f1', 'f2'), pr('a/b', 2, 'f2', 'f1')]);
  assert.strictEqual(roots.length, 2);
  assert.ok(roots.every((r) => r.children.length === 0));
});
```

The cycle test is the one that matters most: without visited-tracking it does not fail, it hangs, and `node --test` reports a timeout rather than an assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/stacks.test.ts`
Expected: FAIL — cannot find module `../src/stacks.ts`.

- [ ] **Step 3: Implement stack reconstruction**

`home/dot_local/share/pr-dash/src/stacks.ts`:

```ts
import type { PrRecord, StackNode } from './types.ts';

function inCycle(pr: PrRecord, byHead: Map<string, PrRecord>): boolean {
  const seen = new Set<string>([pr.id]);
  let cursor = byHead.get(`${pr.repo} ${pr.baseRef}`);
  while (cursor !== undefined) {
    if (seen.has(cursor.id)) return true;
    seen.add(cursor.id);
    cursor = byHead.get(`${cursor.repo} ${cursor.baseRef}`);
  }
  return false;
}

export function buildStacks(records: readonly PrRecord[]): StackNode[] {
  const byHead = new Map<string, PrRecord>();
  for (const pr of records) byHead.set(`${pr.repo} ${pr.headRef}`, pr);

  const childrenOf = new Map<string, PrRecord[]>();
  const roots: PrRecord[] = [];
  const dangling = new Set<string>();

  for (const pr of records) {
    const parent = inCycle(pr, byHead)
      ? undefined
      : byHead.get(`${pr.repo} ${pr.baseRef}`);

    if (parent === undefined) {
      roots.push(pr);
      // A base that is neither an open PR's head nor a plausible trunk name
      // means the parent merged while this PR stayed open.
      if (!['main', 'master', 'develop', 'trunk'].includes(pr.baseRef) && !inCycle(pr, byHead)) {
        dangling.add(pr.id);
      }
    } else {
      const list = childrenOf.get(parent.id);
      if (list === undefined) childrenOf.set(parent.id, [pr]);
      else list.push(pr);
    }
  }

  const bySort = (a: PrRecord, b: PrRecord) =>
    a.repo.localeCompare(b.repo) || a.number - b.number;

  function size(pr: PrRecord): number {
    return 1 + (childrenOf.get(pr.id) ?? []).reduce((n, c) => n + size(c), 0);
  }

  function build(pr: PrRecord, depth: number, position: number, stackSize: number): StackNode {
    const kids = [...(childrenOf.get(pr.id) ?? [])].sort(bySort);
    let next = position;
    const children = kids.map((k) => {
      next += 1;
      const node = build(k, depth + 1, next, stackSize);
      next += size(k) - 1;
      return node;
    });
    return {
      pr,
      children,
      depth,
      position,
      stackSize,
      danglingBase: dangling.has(pr.id),
    };
  }

  return roots.sort(bySort).map((r) => build(r, 0, 1, size(r)));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/stacks.test.ts`
Expected: 6 pass, 0 fail.

- [ ] **Step 5: Render stacks nested when grouping by repository**

In `public/app.js`, replace the body of `render` so that the `repo` axis renders a tree and every other axis renders flat rows with a stack badge. Add to the imports:

```js
import { buildStacks } from '../src/stacks.ts';
```

That import will not work in a browser — `src/stacks.ts` is TypeScript. Instead, the server exposes the built stacks alongside the records. Modify `src/server.ts`'s `/api/prs` branch to send both:

```ts
    const prs = await opts.loadPrs();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ prs, stacks: buildStacks(prs), fetchedAt: new Date().toISOString() }));
```

with `import { buildStacks } from './stacks.ts';` at the top of `server.ts`.

Then in `public/app.js`, add a tree renderer and use it for the `repo` axis:

```js
/**
 * @param {import('../src/types.ts').StackNode} node
 * @param {DocumentFragment | HTMLElement} into
 */
function renderStack(node, into) {
  const row = renderRow(node.pr);
  row.style.marginLeft = `${node.depth * 20}px`;
  if (node.stackSize > 1) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${node.position}/${node.stackSize}`;
    row.prepend(badge);
  }
  if (node.danglingBase) {
    const flag = document.createElement('span');
    flag.className = 'badge flag';
    flag.textContent = 'base merged';
    row.prepend(flag);
  }
  into.append(row);
  for (const child of node.children) renderStack(child, into);
}
```

- [ ] **Step 6: Verify the type gate and full suite**

Run: `cd home/dot_local/share/pr-dash && npm run check && node --test tests/`
Expected: type check exits 0; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/share/pr-dash/src home/dot_local/share/pr-dash/public home/dot_local/share/pr-dash/tests/stacks.test.ts
git commit -m "Reconstruct stacked PRs from base/head chaining

gh stack view needs a local checkout and a cross-repo dashboard has
none, so stacks come from the data already in the search response. A
dangling base is flagged rather than hidden: that is exactly the state
where a stack needs a rebase."
```

---

## Slice 5 — Filters and persistence

### Task 10: Filters and saved view state

**Files:**
- Modify: `home/dot_local/share/pr-dash/public/group.js`
- Modify: `home/dot_local/share/pr-dash/public/index.html`
- Modify: `home/dot_local/share/pr-dash/public/app.js`
- Modify: `home/dot_local/share/pr-dash/tests/group.test.ts`

**Interfaces:**
- Consumes: `groupBy`, `sortWithin` (Task 4).
- Produces: `applyFilters(records, filters) => PrRecord[]` where `filters` is `{ ci: Ci[]; review: Review[]; draft: ('draft'|'ready')[] }`; empty arrays mean "no constraint".

- [ ] **Step 1: Add the failing tests**

Append to `home/dot_local/share/pr-dash/tests/group.test.ts`:

```ts
import { applyFilters } from '../public/group.js';

test('an empty filter set matches everything', () => {
  const out = applyFilters(records, { ci: [], review: [], draft: [] });
  assert.strictEqual(out.length, records.length);
});

test('filters by ci status', () => {
  const out = applyFilters(records, { ci: ['failure'], review: [], draft: [] });
  assert.deepStrictEqual(out.map((r) => r.id), ['acme/web#7']);
});

test('filters combine as AND across axes', () => {
  const out = applyFilters(records, { ci: ['failure'], review: ['approved'], draft: [] });
  assert.strictEqual(out.length, 0);
});

test('filters combine as OR within one axis', () => {
  const out = applyFilters(records, { ci: ['failure', 'success'], review: [], draft: [] });
  assert.strictEqual(out.length, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/group.test.ts`
Expected: FAIL — `applyFilters` is not exported.

- [ ] **Step 3: Implement filtering**

Append to `home/dot_local/share/pr-dash/public/group.js`:

```js
/**
 * @typedef {object} Filters
 * @property {import('../src/types.ts').Ci[]} ci
 * @property {import('../src/types.ts').Review[]} review
 * @property {('draft'|'ready')[]} draft
 */

/**
 * @param {readonly PrRecord[]} records
 * @param {Filters} filters
 * @returns {PrRecord[]}
 */
export function applyFilters(records, filters) {
  return records.filter((pr) => {
    if (filters.ci.length > 0 && !filters.ci.includes(pr.ci)) return false;
    if (filters.review.length > 0 && !filters.review.includes(pr.review)) return false;
    if (filters.draft.length > 0 && !filters.draft.includes(pr.isDraft ? 'draft' : 'ready')) return false;
    return true;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/group.test.ts`
Expected: 11 pass, 0 fail.

- [ ] **Step 5: Add filter controls and persistence to the page**

Add to `index.html` inside `<header>`, before the refresh button:

```html
  <fieldset id="filter-ci"><legend>CI</legend>
    <label><input type="checkbox" value="success"> ok</label>
    <label><input type="checkbox" value="failure"> red</label>
    <label><input type="checkbox" value="pending"> running</label>
    <label><input type="checkbox" value="none"> none</label>
  </fieldset>
  <fieldset id="filter-review"><legend>Review</legend>
    <label><input type="checkbox" value="approved"> approved</label>
    <label><input type="checkbox" value="changes_requested"> changes</label>
    <label><input type="checkbox" value="review_required"> waiting</label>
    <label><input type="checkbox" value="none"> none</label>
  </fieldset>
  <button id="reset" type="button">Reset view</button>
```

Add to `app.js`:

```js
const VIEW_KEY = 'pr-dash:view';

/** @returns {{ axis: string, sort: string, ci: string[], review: string[] }} */
function loadView() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw !== null) return JSON.parse(raw);
  } catch {
    // A corrupt or unavailable store must not stop the page rendering.
  }
  return { axis: 'repo', sort: 'stale', ci: [], review: [] };
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(readControls()));
  } catch {
    // Private windows and blocked site data throw here; the view just
    // will not persist, which is not worth interrupting the user for.
  }
}

function resetView() {
  try {
    localStorage.removeItem(VIEW_KEY);
  } catch { /* nothing to clear */ }
  location.reload();
}

document.getElementById('reset')?.addEventListener('click', resetView);
```

Wire `loadView()` into control initialization and call `saveView()` from every `change` handler. The reset control is required: a saved filter that cannot be cleared makes the dashboard look empty with no visible cause.

- [ ] **Step 6: Verify by hand**

Start the server, tick "red" under CI, reload the page, and confirm the filter survived. Click "Reset view" and confirm all rows return.

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/share/pr-dash/public home/dot_local/share/pr-dash/tests/group.test.ts
git commit -m "Add pr-dash filters with persisted view state

Filters are AND across axes and OR within one. The reset control is
not optional: a saved filter that cannot be cleared makes the dashboard
look empty with no visible cause."
```

---

## Slice 6 — Refresh, staleness, and honest failures

### Task 11: Retain the last good payload and surface failures

**Files:**
- Modify: `home/dot_local/share/pr-dash/src/main.ts`
- Modify: `home/dot_local/share/pr-dash/public/app.js`
- Create: `home/dot_local/share/pr-dash/tests/refresh.test.ts`

**Interfaces:**
- Consumes: `createCache` (Task 3), `loadPrs` (Task 8).
- Produces: `loadPrsWithFallback()` returning `{ prs, fetchedAt, stale: boolean, error?: string }`.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/pr-dash/tests/refresh.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { withFallback } from '../src/main-lib.ts';
import type { PrRecord } from '../src/types.ts';

const one: PrRecord[] = [];

test('a successful load is not stale', async () => {
  const load = withFallback(async () => one);
  const r = await load();
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.error, undefined);
});

test('a failure after a success returns the last good payload, marked stale', async () => {
  let fail = false;
  const load = withFallback(async () => {
    if (fail) throw new Error('network down');
    return one;
  });
  await load();
  fail = true;
  const r = await load();
  assert.strictEqual(r.stale, true);
  assert.match(String(r.error), /network down/);
  assert.deepStrictEqual(r.prs, one);
});

test('a failure with no previous success rejects', async () => {
  const load = withFallback(async () => { throw new Error('cold failure'); });
  await assert.rejects(load, /cold failure/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/refresh.test.ts`
Expected: FAIL — cannot find module `../src/main-lib.ts`.

- [ ] **Step 3: Implement the fallback**

`home/dot_local/share/pr-dash/src/main-lib.ts`:

```ts
import type { PrRecord } from './types.ts';

export type LoadResult = {
  prs: PrRecord[];
  fetchedAt: string;
  stale: boolean;
  error?: string;
};

export function withFallback(load: () => Promise<PrRecord[]>): () => Promise<LoadResult> {
  let lastGood: PrRecord[] | undefined;
  let lastGoodAt = '';

  return async () => {
    try {
      const prs = await load();
      lastGood = prs;
      lastGoodAt = new Date().toISOString();
      return { prs, fetchedAt: lastGoodAt, stale: false };
    } catch (err) {
      if (lastGood === undefined) throw err;
      return {
        prs: lastGood,
        fetchedAt: lastGoodAt,
        stale: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/refresh.test.ts`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Wire it into the server and the banner**

In `main.ts`, wrap `loadPrs` with `withFallback` and pass the result through. In `server.ts`, forward `stale`, `error`, and `fetchedAt` in the JSON. In `app.js`, show the banner when `stale` is true, naming the error and the time of the last success, and keep rendering the rows.

- [ ] **Step 6: Verify by hand**

Start the server, load the page, then disconnect the network and click Refresh. Expected: rows stay on screen and a banner names the failure and the last-success time. Reconnect, refresh, and the banner clears.

- [ ] **Step 7: Run the whole suite and the type gate**

Run: `cd home/dot_local/share/pr-dash && npm run check && node --test tests/`
Expected: type check exits 0; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add home/dot_local/share/pr-dash
git commit -m "Keep the last good payload when a pr-dash refresh fails

Going blank on a transient network error is a worse failure than
showing data a few minutes old, so the page keeps its rows behind a
banner naming the failure and the last success."
```

### Task 12: Pin the guard's expected host to the launcher

**Files:**
- Modify: `home/dot_local/share/pr-dash/src/server.ts`
- Modify: `home/dot_local/share/pr-dash/src/main.ts`
- Modify: `home/dot_local/share/pr-dash/tests/server.test.ts`

**Interfaces:**
- Consumes: `checkRequest` (Task 2).
- Produces: `createServer` gains a required `host: string` option.

- [ ] **Step 1: Add the failing test**

Append to `tests/server.test.ts`:

```ts
test('rejects a Host header that is not the configured one', async () => {
  const server = createServer({
    secret: 'test-secret',
    host: '127.0.0.1:9999',
    loadPrs: async () => records,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/prs`, {
      headers: { 'x-pr-dash-secret': 'test-secret' },
    });
    assert.strictEqual(res.status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd home/dot_local/share/pr-dash && node --test tests/server.test.ts`
Expected: FAIL — the request returns 200 because the guard compares the Host header to itself.

- [ ] **Step 3: Take the expected host from configuration**

In `server.ts`, add `host: string` to `ServerOpts` and change the guard call:

```ts
  const guard = checkRequest(req.headers, { host: opts.host, secret: opts.secret });
```

Update the existing tests in `tests/server.test.ts` to pass `host: \`127.0.0.1:${addr.port}\`` — which means constructing the server after the port is known, or listening first and then reading the port. Simplest: bind an explicit port via `PR_DASH_PORT` in the test helper.

In `main.ts`, pass `host: \`127.0.0.1:${port}\``.

- [ ] **Step 4: Run to verify it passes**

Run: `cd home/dot_local/share/pr-dash && node --test tests/server.test.ts`
Expected: all pass, including the new rejection test.

- [ ] **Step 5: Verify the rebinding defense by hand**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example.com:8770' \
  -H 'x-pr-dash-secret: abc' http://127.0.0.1:8770/api/prs
```

Expected: `403`.

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/share/pr-dash
git commit -m "Pin the pr-dash guard to the launcher's host

Comparing the Host header to itself made the rebinding check a
tautology. The expected host now comes from configuration, so a request
arriving with an attacker's hostname is rejected."
```

---

## Deployment check

- [ ] **Confirm chezmoi deploys the right files and excludes the rest**

```bash
chezmoi diff ~/.local/bin/pr-dash ~/.local/share/pr-dash
```

Expected: `src/`, `public/`, and the launcher appear. `node_modules/`, `tests/`, `package.json`, `package-lock.json`, and `tsconfig.json` must **not** appear. If they do, the `.chezmoiignore` entries from Task 1 Step 4 are wrong — fix them before applying.

- [ ] **Apply and run from a clean shell**

```bash
chezmoi apply ~/.local/bin/pr-dash ~/.local/share/pr-dash
pr-dash
```

---

## Self-review notes

Checked against the spec:

- Scope, grouping axes, stack reconstruction, the PR record, refresh and error handling, authentication, testing, and deployment all have tasks.
- The spec's *Designing for actions later* section is satisfied structurally rather than by a task: `PrRecord.id` (Task 1), `github.ts` as a transport with `query()` (Task 8), the shared `PR_FIELDS` fragment (Task 8), `cache.invalidate()` (Task 3), and the guard (Task 2). No task builds an action.
- Two facts the spec did not know, discovered while planning and reflected above: the pre-push suite globs only `*.test.js`/`*.test.mjs`, and neither `.gitignore` nor `.chezmoiignore` mentions `node_modules`. Both are fixed in Task 1.
- The spec said esbuild would bundle the client. This plan drops the bundler: the client is JSDoc-annotated `.js` served directly as ES modules, type-checked against the server's `.ts` types. Verified that `tsc --checkJs` catches real errors across that boundary. **Update the spec's "Language and tooling" section to match before executing.**
