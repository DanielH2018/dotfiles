# pr-dash startup time and collapsible sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard's rows appear with the first paint instead of after it, and let repository groups and stacks be folded away without hiding what is wrong inside them.

**Architecture:** Three independent slices. The server pre-loads its first GitHub fetch so the round trip overlaps browser startup, which requires in-flight deduplication in the loader. The last good payload is persisted to disk and restored at startup by seeding `withFallback`'s retained payload, so a relaunch paints immediately and honestly marks the rows stale. The browser gains collapsible group and stack headers whose collapsed state carries a count and a state summary, persisted beside the existing view state and cleared by Reset.

**Tech Stack:** Node 24 native TypeScript type stripping (no build step, no bundler), `node:test`, `tsc --noEmit` as the only type gate, plain ES modules with JSDoc-annotated JavaScript in the browser.

**Spec:** `docs/specs/2026-09-15-pr-dash-startup-and-collapse-design.md`, which extends `docs/specs/2026-09-14-pr-dashboard-design.md`. Read both; the parent spec defines the guard, the token source, the staleness model and the grouping axes, none of which change here.

## Global Constraints

- **`tsc --noEmit` is the type gate.** Run `npm run check` from `home/dot_local/share/pr-dash/`. No runtime dependencies. devDependencies stay `typescript` and `@types/node` only — both types-only, neither deployed.
- **`moduleResolution` is `nodenext`.** With no bundler, `tsc` is the only check on import specifiers, and relative imports carry the real file's extension: `./loader.ts`, `./group.js`.
- **`erasableSyntaxOnly` is on.** No enums, no namespaces, no parameter properties — Node strips types rather than compiling them, so anything that needs emit fails at runtime. Discriminated unions and `type`/`interface` are fine.
- **`noUncheckedIndexedAccess` is on.** An indexed read is `T | undefined`; narrow it.
- **Read-only.** No endpoint mutates GitHub state, and no mutating GraphQL operation exists anywhere. Nothing from the parent spec's *Designing for actions later* gets built.
- **No test may touch the network or run `op`.** `github.com` is network-denied in this sandbox and 1Password's socket is unreachable. Every GitHub interaction goes through the injected `fetchImpl`; the new disk layer takes an injected filesystem seam for the same reason.
- **The token never reaches disk, a log, a process argument, or an error message.** `runOpRead` and `runOpItemGet` in `src/token.ts` stay un-exported because `execFile`'s rejection carries the token in `.stdout`. Never attach `{ cause }` to an op failure. No `gh auth token` fallback: `gh` returns whatever scopes `gh auth login` negotiated, in practice write access.
- **The per-launch secret stays out of `localStorage`** and out of the persisted payload.
- **`public/app.js` cannot be imported under `node --test`** — `location.hash` throws at module scope and there is no jsdom. Anything that needs a test goes in `public/group.js` or `public/render-guards.js`, both DOM-free.
- **Test file naming:** the repo's pre-push gate collects tests with `git ls-files '*.test.js' '*.test.mjs' '*.test.ts'`. A new suite must match one of those globs or nothing runs it.
- Run the suite with `npm test` from `home/dot_local/share/pr-dash/`. Baseline before Task 1 is **302 passing, 0 failing**.

---

## File Structure

**Slice 1 — pre-load**

- Modify `home/dot_local/share/pr-dash/src/loader.ts` — add in-flight tracking to `createPrLoader`. Owns cache-hit/miss and now also "a fetch is already running".
- Modify `home/dot_local/share/pr-dash/src/main-lib.ts` — add `startPreload`, a testable fire-and-forget wrapper. `main.ts` stays a process shell with no logic worth testing.
- Modify `home/dot_local/share/pr-dash/src/main.ts` — call `startPreload` before `listen`.
- Test `home/dot_local/share/pr-dash/tests/loader.test.ts` and `tests/refresh.test.ts`.

**Slice 2 — disk persistence**

- Create `home/dot_local/share/pr-dash/src/payload-store.ts` — the only file that touches the filesystem. Owns the path, the modes, the atomic write, and the validation of whatever comes back.
- Modify `home/dot_local/share/pr-dash/src/main-lib.ts` — `withFallback` takes an optional seed and a success hook.
- Modify `home/dot_local/share/pr-dash/src/main.ts` — build the store, read it, pass the seed.
- Test `home/dot_local/share/pr-dash/tests/payload-store.test.ts` (new) and `tests/refresh.test.ts`.

**Slice 3 — collapsible sections**

- Modify `home/dot_local/share/pr-dash/public/group.js` — add `groupSummary` and `summaryChips`, both pure.
- Modify `home/dot_local/share/pr-dash/public/render-guards.js` — `StoredView` gains `collapsed`, with a validator.
- Modify `home/dot_local/share/pr-dash/public/app.js` — collapsible headers and the collapse-all controls.
- Modify `home/dot_local/share/pr-dash/public/index.html` — the two new buttons.
- Modify `home/dot_local/share/pr-dash/public/style.css` — header button, chevron, chips.
- Test `home/dot_local/share/pr-dash/tests/group.test.ts` and `tests/render-guards.test.ts`.

---

## Task 1: In-flight deduplication in the loader

**Files:**
- Modify: `home/dot_local/share/pr-dash/src/loader.ts:26-49` (the body of `createPrLoader`)
- Test: `home/dot_local/share/pr-dash/tests/loader.test.ts`

**Interfaces:**
- Consumes: `createClient({token, fetchImpl})` from `./github.ts`, `createCache<T>(ttlMs)` from `./cache.ts`, both unchanged.
- Produces: `createPrLoader(client, cache)` keeps its exact signature — `(opts?: LoadOpts) => Promise<LoadResult>`. Task 2 relies on that being unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/loader.test.ts`:

```ts
test('two concurrent cache misses produce exactly one fetch', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const loadPrs = createPrLoader(client, createCache<LoadResult>(60_000));

  const [a, b] = await Promise.all([loadPrs(), loadPrs()]);

  assert.strictEqual(calls, 1, 'the second caller must join the in-flight fetch');
  assert.deepStrictEqual(a, b, 'both callers see the same payload');
});

test('a rejected in-flight fetch is not retained, so the next call fetches again', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return pageResponse([RAW_NODE]);
    },
  });
  const loadPrs = createPrLoader(client, createCache<LoadResult>(60_000));

  await assert.rejects(() => loadPrs());
  // A retained rejected promise would replay 'network down' here forever, turning one
  // transient failure into a permanently broken dashboard.
  const result = await loadPrs();

  assert.strictEqual(calls, 2);
  assert.strictEqual(result.prs.length, 1);
});

test('a force arriving mid-fetch joins it rather than starting a second', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const loadPrs = createPrLoader(client, createCache<LoadResult>(60_000));

  await Promise.all([loadPrs(), loadPrs({ force: true })]);

  assert.strictEqual(calls, 1, 'an in-flight fetch is already as fresh as a forced one');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`

Expected: FAIL. The first test reports `calls` as 2, not 1. The third reports 2, not 1. The second passes already — it is a regression guard for the mistake the implementation below could introduce, so it must stay.

- [ ] **Step 3: Add the in-flight tracking**

Replace the body of `createPrLoader` in `src/loader.ts` with:

```ts
export function createPrLoader(client: Client, cache: Cache<LoadResult>): LoadPrs {
  // The fetch currently running, if any. Without this, the startup pre-load and the
  // browser's first /api/prs both miss the cache and both run a full paginated query
  // against the rate limit, racing to cache.set.
  let inFlight: Promise<LoadResult> | undefined;

  return async function loadPrs(opts: LoadOpts = {}): Promise<LoadResult> {
    // Invalidating before the read, rather than skipping the read, is what makes the
    // TTL's own clock restart from this fetch: the fetch below repopulates the cache, so
    // polls resume hitting it instead of every later request re-fetching.
    if (opts.force === true) cache.invalidate();

    const hit = cache.get();
    if (hit !== undefined) return hit;

    // A force that arrives while a fetch is already running joins it. That fetch is
    // already as fresh as a new one would be, and starting a second doubles the API
    // calls to produce the same answer.
    if (inFlight !== undefined) return inFlight;

    // normalize() and cache.set() run only after fetchAllPrs resolves. A rejected fetch
    // propagates before either runs, so a failed refresh leaves whatever was previously
    // cached (or nothing, on a cold cache) untouched instead of being overwritten with
    // an empty or partial result.
    const pending = (async (): Promise<LoadResult> => {
      const fetched = await fetchAllPrs(client);
      const result: LoadResult = {
        prs: normalize(fetched.prs),
        fetchedAt: new Date().toISOString(),
        partialErrors: fetched.errors,
      };
      cache.set(result);
      return result;
    })();

    inFlight = pending;
    try {
      return await pending;
    } finally {
      // Cleared on rejection as well as on success. A retained rejected promise would be
      // handed to every later caller, so one transient failure would never heal.
      inFlight = undefined;
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` then `npm run check`

Expected: 305 passing, 0 failing; `tsc` exits 0.

- [ ] **Step 5: Verify the tests can actually fail**

Run each mutation, confirm the suite reddens, then revert it:

1. Delete the `if (inFlight !== undefined) return inFlight;` line → the concurrency tests fail.
2. Replace the `finally` block with nothing (leave `inFlight` set) → the rejection test fails.
3. Move `inFlight = pending;` to after `await pending` → the concurrency tests fail.

A mutation that leaves the suite green means the test is not pinning what it claims. Restore the file and confirm `git status --short` is empty before committing.

- [ ] **Step 6: Commit**

```bash
git add src/loader.ts tests/loader.test.ts
git commit -m "Share one in-flight fetch between concurrent pr-dash cache misses"
```

---

## Task 2: Pre-load the first fetch at startup

**Files:**
- Modify: `home/dot_local/share/pr-dash/src/main-lib.ts` (add `startPreload` at the end)
- Modify: `home/dot_local/share/pr-dash/src/main.ts:28-30`
- Test: `home/dot_local/share/pr-dash/tests/refresh.test.ts`

**Interfaces:**
- Consumes: `createLoadPrs(client, cache)` from `./main-lib.ts`, returning `(opts?: LoadOpts) => Promise<FallbackResult>`.
- Produces: `startPreload(loadPrs, onError?)` returning `void`. Nothing else consumes it; `main.ts` is the only caller.

- [ ] **Step 1: Write the failing tests**

Append to `tests/refresh.test.ts`:

```ts
test('startPreload calls the loader without being awaited', async () => {
  let calls = 0;
  const loadPrs = async () => {
    calls += 1;
    return { prs: one, fetchedAt: 'T1', partialErrors: [], stale: false };
  };

  startPreload(loadPrs);
  // startPreload returns void, so the fetch it started is still settling here. Yielding
  // once is enough to let the microtask run.
  await Promise.resolve();

  assert.strictEqual(calls, 1);
});

test('a rejected preload neither throws nor leaves an unhandled rejection', async () => {
  const seen: string[] = [];
  const loadPrs = async () => {
    throw new Error('network down');
  };

  // Throwing synchronously, or returning a promise nobody catches, would take the process
  // down at startup over a fetch the page would have retried on its own.
  assert.doesNotThrow(() => startPreload(loadPrs, (m) => seen.push(m)));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepStrictEqual(seen, ['network down']);
});

test('a rejected preload leaves the loader usable', async () => {
  let calls = 0;
  const loadPrs = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return { prs: one, fetchedAt: 'T1', partialErrors: [], stale: false };
  };

  startPreload(loadPrs);
  await new Promise((r) => setTimeout(r, 0));
  const result = await loadPrs();

  assert.strictEqual(result.stale, false);
  assert.deepStrictEqual(result.prs, one);
});
```

Add `startPreload` to the existing `main-lib.ts` import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`

Expected: FAIL with `startPreload is not exported from '../src/main-lib.ts'`, which under `tsc` also surfaces as TS2305.

- [ ] **Step 3: Add `startPreload`**

Append to `src/main-lib.ts`:

```ts
/**
 * Starts the first fetch without waiting for it, so the GitHub round trip overlaps the
 * launcher's readiness poll and the browser's cold start. By the time `app.js` requests
 * `/api/prs` the payload is already cached.
 *
 * Deliberately not awaited by the caller: awaiting before `listen()` delays the port past
 * the launcher's `curl` probe, which reintroduces the serial wait this exists to remove
 * and can push startup past the launcher's 60-second deadline.
 *
 * A failure here is not fatal and is not the page's problem. The loader caches only on
 * success, so the browser's own request retries against GitHub and renders the normal
 * error banner if that fails too. `onError` exists so the server can say so on stderr
 * rather than failing silently.
 */
export function startPreload(
  loadPrs: (opts?: LoadOpts) => Promise<FallbackResult>,
  onError: (message: string) => void = () => {},
): void {
  void loadPrs().catch((err: unknown) => {
    onError(err instanceof Error ? err.message : String(err));
  });
}
```

- [ ] **Step 4: Wire it into `main.ts`**

In `src/main.ts`, replace:

```ts
const loadPrs = createLoadPrs(client, cache);
```

with:

```ts
const loadPrs = createLoadPrs(client, cache);

// Before listen(), and not awaited: the fetch runs while the launcher polls for the port
// and the browser starts, so the first /api/prs is served from a warm cache.
startPreload(loadPrs, (message) => {
  console.error(`pr-dash could not pre-load PRs (the page will retry): ${message}`);
});
```

Add `startPreload` to the existing `./main-lib.ts` import in `main.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` then `npm run check`

Expected: 308 passing, 0 failing; `tsc` exits 0.

- [ ] **Step 6: Verify the tests can actually fail**

1. Change `startPreload`'s body to `void loadPrs();` (no `.catch`) → the rejection test fails, and Node reports an unhandled rejection.
2. Change the body to `await loadPrs()` with `async` added → `tsc` fails, because the declared return type is `void`.
3. Change the body to an empty statement → the first test fails.

Revert each and confirm `git status --short` is empty.

- [ ] **Step 7: Confirm the ordering by hand**

`main.ts` carries no test by design, so check the ordering by reading it: `startPreload` must appear **above** `server.listen(...)`. A pre-load below `listen` still works but stops overlapping the browser's startup, which is the entire point.

- [ ] **Step 8: Commit**

```bash
git add src/main-lib.ts src/main.ts tests/refresh.test.ts
git commit -m "Start pr-dash's first GitHub fetch before the browser asks for it"
```

---

## Task 3: The payload store

**Files:**
- Create: `home/dot_local/share/pr-dash/src/payload-store.ts`
- Test: `home/dot_local/share/pr-dash/tests/payload-store.test.ts`

**Interfaces:**
- Consumes: `LoadResult` from `./loader.ts` — `{ prs: PrRecord[]; fetchedAt: string; partialErrors: string[] }`.
- Produces:
  - `type FsSeam` — `{ mkdir, writeFile, rename, readFile }`, the four calls this module makes.
  - `type PayloadStore` — `{ read(): Promise<LoadResult | undefined>; write(result: LoadResult): Promise<void> }`.
  - `createPayloadStore(dir: string, fs?: FsSeam): PayloadStore`.
  - `DEFAULT_STATE_DIR: string` — the real directory, used by `main.ts` in Task 4.
  - `FILE_MODE = 0o600` and `DIR_MODE = 0o700`.

- [ ] **Step 1: Write the failing tests**

Create `tests/payload-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import { createPayloadStore, DIR_MODE, FILE_MODE, type FsSeam } from '../src/payload-store.ts';
import type { LoadResult } from '../src/loader.ts';
import type { PrRecord } from '../src/types.ts';

const RECORD: PrRecord = {
  id: 'acme/api#12',
  repo: 'acme/api',
  number: 12,
  title: 'Add retry budget',
  url: 'https://github.com/acme/api/pull/12',
  headRef: 'retry-budget',
  baseRef: 'main',
  isDraft: false,
  ci: 'success',
  review: 'approved',
  openedAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-10T00:00:00Z',
  ageDays: 13,
  staleDays: 4,
  additions: 120,
  deletions: 8,
  defaultBranch: 'main',
};

const PAYLOAD: LoadResult = {
  prs: [RECORD],
  fetchedAt: '2026-09-15T09:00:00.000Z',
  partialErrors: [],
};

/** An in-memory FsSeam that records what it was asked to do. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const calls: string[] = [];
  const modes = new Map<string, number>();
  const seam: FsSeam = {
    async mkdir(path, opts) {
      calls.push(`mkdir ${path}`);
      modes.set(path, opts.mode);
    },
    async writeFile(path, data, opts) {
      calls.push(`writeFile ${path}`);
      files.set(path, data);
      modes.set(path, opts.mode);
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      const data = files.get(from);
      if (data === undefined) throw new Error(`no such file: ${from}`);
      files.set(to, data);
      files.delete(from);
      modes.set(to, modes.get(from) ?? 0);
    },
    async readFile(path) {
      calls.push(`readFile ${path}`);
      const data = files.get(path);
      if (data === undefined) {
        const err: NodeJS.ErrnoException = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return data;
    },
  };
  return { seam, files, calls, modes };
}

test('a written payload reads back unchanged', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  assert.deepStrictEqual(await store.read(), PAYLOAD);
});

test('the write is atomic: a temp file is renamed over the target', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  const renamed = fs.calls.find((c) => c.startsWith('rename '));
  assert.ok(renamed !== undefined, 'the payload must be renamed into place, not written in place');
  assert.ok(
    renamed.endsWith('-> /state/last-payload.json'),
    `expected a rename onto the target, saw: ${renamed}`,
  );
  // A kill between writeFile and rename must not leave a half-written target.
  assert.ok(!fs.calls.includes('writeFile /state/last-payload.json'));
});

test('the directory and the file are created with owner-only modes', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);

  assert.strictEqual(fs.modes.get('/state'), DIR_MODE);
  assert.strictEqual(fs.modes.get('/state/last-payload.json'), FILE_MODE);
  // This machine's login shell runs `umask 0007`, so leaving the mode to the umask would
  // produce a group-readable 0640 file holding private PR titles.
  assert.strictEqual(FILE_MODE, 0o600);
  assert.strictEqual(DIR_MODE, 0o700);
});

test('each temp file has a unique name', async () => {
  const fs = fakeFs();
  const store = createPayloadStore('/state', fs.seam);

  await store.write(PAYLOAD);
  await store.write(PAYLOAD);

  const temps = fs.calls.filter((c) => c.startsWith('writeFile ')).map((c) => c.slice(10));
  assert.strictEqual(new Set(temps).size, 2, 'a fixed temp name would keep a crashed run\'s mode');
});

test('an absent file is a cold start, not an error', async () => {
  const store = createPayloadStore('/state', fakeFs().seam);
  assert.strictEqual(await store.read(), undefined);
});

test('a read error other than ENOENT is also a cold start', async () => {
  const fs = fakeFs();
  const seam: FsSeam = {
    ...fs.seam,
    async readFile() {
      throw new Error('EACCES');
    },
  };
  const store = createPayloadStore('/state', seam);
  assert.strictEqual(await store.read(), undefined);
});

for (const [label, contents] of [
  ['not JSON at all', 'this is not json'],
  ['truncated JSON', '{"prs":[{"id":"acme/api#1"'],
  ['JSON null', 'null'],
  ['a JSON array', '[1,2,3]'],
  ['a JSON string', '"a token, somehow"'],
  ['prs missing', '{"fetchedAt":"T","partialErrors":[]}'],
  ['prs not an array', '{"prs":{},"fetchedAt":"T","partialErrors":[]}'],
  ['a null record', '{"prs":[null],"fetchedAt":"T","partialErrors":[]}'],
  ['fetchedAt missing', '{"prs":[],"partialErrors":[]}'],
  ['fetchedAt empty', '{"prs":[],"fetchedAt":"","partialErrors":[]}'],
  ['partialErrors not an array', '{"prs":[],"fetchedAt":"T","partialErrors":"x"}'],
  ['partialErrors holding a non-string', '{"prs":[],"fetchedAt":"T","partialErrors":[1]}'],
] as const) {
  test(`a stored file that is ${label} yields a cold start`, async () => {
    const fs = fakeFs({ '/state/last-payload.json': contents });
    const store = createPayloadStore('/state', fs.seam);
    assert.strictEqual(await store.read(), undefined, 'must discard rather than throw');
  });
}

test('an empty payload is valid, not a cold start', async () => {
  // Zero open PRs is a real answer. Treating it as corrupt would refuse to restore the
  // one state the user most wants to see instantly.
  const empty: LoadResult = { prs: [], fetchedAt: 'T', partialErrors: [] };
  const fs = fakeFs({ '/state/last-payload.json': JSON.stringify(empty) });
  const store = createPayloadStore('/state', fs.seam);
  assert.deepStrictEqual(await store.read(), empty);
});

test('a write failure does not propagate', async () => {
  const fs = fakeFs();
  const seam: FsSeam = {
    ...fs.seam,
    async writeFile() {
      throw new Error('ENOSPC');
    },
  };
  const store = createPayloadStore('/state', seam);
  // A full disk must not turn a successful fetch into a failed request.
  await store.write(PAYLOAD);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`

Expected: FAIL — `Cannot find module '../src/payload-store.ts'`.

- [ ] **Step 3: Write the payload store**

Create `src/payload-store.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LoadResult } from './loader.ts';
import type { PrRecord } from './types.ts';

/** Owner-only. Set explicitly: this machine's login shell umask would give 0640. */
export const FILE_MODE = 0o600;
/** Owner-only. Same reason as {@link FILE_MODE}. */
export const DIR_MODE = 0o700;

const FILE_NAME = 'last-payload.json';

/**
 * Where the payload lives. Outside chezmoi's managed tree, so it can never reach the
 * source repository, and outside the deployed `pr-dash` directory so `chezmoi apply`
 * never removes it.
 */
export const DEFAULT_STATE_DIR = join(homedir(), '.local', 'state', 'pr-dash');

/**
 * The four filesystem calls this module makes. Injected so a test asserts the atomic
 * write and the modes without writing to the operator's real state directory.
 */
export type FsSeam = {
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<unknown>;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string>;
};

export type PayloadStore = {
  /** The stored payload, or `undefined` for anything that is missing or unusable. */
  read(): Promise<LoadResult | undefined>;
  /** Persists `result`. Never rejects: a failure here must not fail the request. */
  write(result: LoadResult): Promise<void>;
};

const realFs: FsSeam = {
  mkdir: (path, opts) => mkdir(path, opts),
  writeFile: (path, data, opts) => writeFile(path, data, opts),
  rename: (from, to) => rename(from, to),
  readFile: (path) => readFile(path, 'utf8'),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deliberately shallower than the browser's validateRecord, and deliberately not shared
// with it: that validator lives in public/render-guards.js, which src/ must not import —
// the import-convention guard bans relative .js imports outside public/, and the browser
// and the server are separate module graphs on purpose.
//
// This check only has to be good enough not to hand something structurally broken
// downstream. A restored payload travels the same /api/prs response path as a fetched
// one, so a record with a subtly wrong field still meets validateRecord in the browser
// and produces its existing, diagnosable error banner rather than a crash.
function looksLikePayload(value: unknown): value is LoadResult {
  if (!isRecord(value)) return false;
  const prs = value['prs'];
  const fetchedAt = value['fetchedAt'];
  const partialErrors = value['partialErrors'];
  if (!Array.isArray(prs) || !prs.every(isRecord)) return false;
  if (typeof fetchedAt !== 'string' || fetchedAt === '') return false;
  if (!Array.isArray(partialErrors)) return false;
  if (!partialErrors.every((e) => typeof e === 'string')) return false;
  return true;
}

/**
 * Persists the last good payload so the next launch can paint before GitHub answers.
 *
 * Reads tolerate every way the file can be wrong — absent, truncated, valid JSON of the
 * wrong shape, or written by an older version with a different schema — because the
 * stored value is whatever was there last and a successful parse does not make it the
 * right shape. Each of those cases starts cold instead of throwing, which is the same
 * discipline `parseStoredView` applies to `localStorage`.
 */
export function createPayloadStore(dir: string, fs: FsSeam = realFs): PayloadStore {
  const target = join(dir, FILE_NAME);

  return {
    async read(): Promise<LoadResult | undefined> {
      let raw: string;
      try {
        raw = await fs.readFile(target);
      } catch {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }
      if (!looksLikePayload(parsed)) return undefined;
      return { prs: parsed.prs as PrRecord[], fetchedAt: parsed.fetchedAt, partialErrors: parsed.partialErrors };
    },

    async write(result: LoadResult): Promise<void> {
      // A unique temp name per write: writeFile's mode applies only when it creates the
      // file, so reusing one name would silently keep a crashed run's mode.
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
        await fs.writeFile(temp, JSON.stringify(result), { mode: FILE_MODE });
        // Rename rather than writing the target in place, so a kill mid-write cannot
        // leave truncated JSON for the next launch to reject.
        await fs.rename(temp, target);
      } catch {
        // A full disk or an unwritable directory must not turn a successful fetch into a
        // failed request. The next launch simply starts cold.
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` then `npm run check`

Expected: 329 passing, 0 failing; `tsc` exits 0.

- [ ] **Step 5: Verify the tests can actually fail**

1. Change `FILE_MODE` to `0o644` → the modes test fails.
2. Replace the `rename` call with `fs.writeFile(target, ...)` → the atomicity test fails.
3. Replace the temp name with a constant `${target}.tmp` → the unique-name test fails.
4. Change `looksLikePayload` to `return isRecord(value)` → several corrupt-file cases fail.
5. Make `read` rethrow instead of returning `undefined` → the absent-file test fails.
6. Make `write` rethrow → the write-failure test fails.

Revert each and confirm `git status --short` is empty.

- [ ] **Step 6: Commit**

```bash
git add src/payload-store.ts tests/payload-store.test.ts
git commit -m "Add a payload store that survives a crash mid-write"
```

---

## Task 4: Restore the payload at startup

**Files:**
- Modify: `home/dot_local/share/pr-dash/src/main-lib.ts` (`withFallback` and `createLoadPrs`)
- Modify: `home/dot_local/share/pr-dash/src/main.ts`
- Test: `home/dot_local/share/pr-dash/tests/refresh.test.ts`

**Interfaces:**
- Consumes: `createPayloadStore(dir, fs?)` and `DEFAULT_STATE_DIR` from Task 3.
- Produces:
  - `withFallback(load, opts?)` where `opts` is `{ initial?: LoadResult; onSuccess?: (result: LoadResult) => void }`. The second parameter is optional, so every existing caller still compiles.
  - `createLoadPrs(client, cache, opts?)` forwarding the same `opts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/refresh.test.ts`:

```ts
test('a seeded payload is served, marked stale, when the first fetch fails', async () => {
  const seeded: LoadResult = { prs: one, fetchedAt: '2026-09-15T06:00:00.000Z', partialErrors: [] };
  const load = async () => {
    throw new Error('network down');
  };

  const result = await withFallback(load, { initial: seeded })();

  assert.strictEqual(result.stale, true, 'a restored payload must never render as fresh');
  assert.strictEqual(result.fetchedAt, seeded.fetchedAt, 'the banner must name the real last success');
  assert.deepStrictEqual(result.prs, one);
  assert.strictEqual(result.error, 'network down');
});

test('a cold start with no seed still throws, so the server can 500', async () => {
  const load = async () => {
    throw new Error('network down');
  };
  await assert.rejects(() => withFallback(load)());
});

test('a successful fetch replaces the seeded payload', async () => {
  const seeded: LoadResult = { prs: [], fetchedAt: 'OLD', partialErrors: [] };
  const fresh: LoadResult = { prs: one, fetchedAt: 'NEW', partialErrors: [] };
  const loadPrs = withFallback(async () => fresh, { initial: seeded });

  const first = await loadPrs();

  assert.strictEqual(first.stale, false);
  assert.strictEqual(first.fetchedAt, 'NEW');
});

test('onSuccess receives each successful payload, and not a stale one', async () => {
  const fresh: LoadResult = { prs: one, fetchedAt: 'NEW', partialErrors: [] };
  const seen: string[] = [];
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 2) throw new Error('network down');
    return fresh;
  };
  const loadPrs = withFallback(load, { onSuccess: (r) => seen.push(r.fetchedAt) });

  await loadPrs();
  await loadPrs();

  assert.deepStrictEqual(seen, ['NEW'], 'only the successful fetch is worth persisting');
});

test('a throwing onSuccess does not fail the request', async () => {
  const fresh: LoadResult = { prs: one, fetchedAt: 'NEW', partialErrors: [] };
  const loadPrs = withFallback(async () => fresh, {
    onSuccess: () => {
      throw new Error('disk full');
    },
  });

  const result = await loadPrs();

  assert.strictEqual(result.stale, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`

Expected: FAIL. `withFallback` takes one argument, so `tsc` reports TS2554 and the seeded tests get `undefined` behaviour at runtime.

- [ ] **Step 3: Give `withFallback` a seed and a success hook**

In `src/main-lib.ts`, replace the `withFallback` signature and body's first lines:

```ts
export type FallbackOpts = {
  /**
   * A payload restored from disk. Seeds the retained-payload slot, **not** the cache: a
   * seeded cache would make the startup pre-load a cache hit and skip the fetch, so the
   * dashboard would show the restored rows and never refresh them.
   */
  initial?: LoadResult;
  /**
   * Called with each successful payload, for persisting it. Synchronous and
   * fire-and-forget by contract — a slow or failing disk must not delay or fail the
   * request that produced the payload.
   */
  onSuccess?: (result: LoadResult) => void;
};

export function withFallback(
  load: LoadPrs,
  opts: FallbackOpts = {},
): (loadOpts?: LoadOpts) => Promise<FallbackResult> {
  let lastGood: LoadResult | undefined = opts.initial;

  return async (loadOpts?: LoadOpts) => {
    try {
      const result = await load(loadOpts);
      lastGood = result;
      // Wrapped: onSuccess writes to disk, and a full disk must not turn a successful
      // fetch into a failed request.
      try {
        opts.onSuccess?.(result);
      } catch {
        // Not persisted this time; the next successful fetch tries again.
      }
      return { ...result, stale: false };
    } catch (err) {
      if (lastGood === undefined) throw err;
      return {
        ...lastGood,
        stale: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
```

Keep the existing explanatory comments above `withFallback` and inside the success branch — they record why a partial result is retained and why `lastGood` is one assignment rather than two variables.

Then forward the options through `createLoadPrs`:

```ts
export function createLoadPrs(
  client: Client,
  cache: Cache<LoadResult>,
  opts: FallbackOpts = {},
): (loadOpts?: LoadOpts) => Promise<FallbackResult> {
  return withFallback(createPrLoader(client, cache), opts);
}
```

- [ ] **Step 4: Wire the store into `main.ts`**

In `src/main.ts`, add the import:

```ts
import { createPayloadStore, DEFAULT_STATE_DIR } from './payload-store.ts';
```

and replace the `createLoadPrs` line with:

```ts
const store = createPayloadStore(DEFAULT_STATE_DIR);
// Read before the server starts: it is one small local file, and having it in hand means
// the very first /api/prs can answer from it while the pre-loaded fetch is still running.
const restored = await store.read();
const loadPrs = createLoadPrs(client, cache, {
  initial: restored,
  onSuccess: (result) => {
    void store.write(result);
  },
});
```

`store.write` already swallows its own failures, so the `void` here discards a promise that cannot reject.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` then `npm run check`

Expected: 334 passing, 0 failing; `tsc` exits 0.

- [ ] **Step 6: Verify the tests can actually fail**

1. Change `let lastGood = opts.initial` to `let lastGood: LoadResult | undefined` → the seeded tests fail.
2. Return `{ ...lastGood, stale: false }` in the catch → the "never render as fresh" assertion fails.
3. Call `opts.onSuccess?.(result)` in the catch branch as well → the onSuccess test fails.
4. Remove the try/catch around `onSuccess` → the throwing-onSuccess test fails.

Revert each and confirm `git status --short` is empty.

- [ ] **Step 7: Verify by hand that a restored payload is honest**

`main.ts` has no test, so exercise the composed path once:

```bash
node -e '
const { createPayloadStore } = await import("./src/payload-store.ts");
const s = createPayloadStore(process.env.TMPDIR + "/pr-dash-probe");
await s.write({ prs: [], fetchedAt: "2026-09-15T06:00:00.000Z", partialErrors: [] });
console.log(await s.read());
' --input-type=module
```

Expected: the payload prints back with its original `fetchedAt`. Then check the file's mode with `ls -l "$TMPDIR/pr-dash-probe/last-payload.json"` — it must read `-rw-------`. Delete the probe directory afterwards.

- [ ] **Step 8: Commit**

```bash
git add src/main-lib.ts src/main.ts tests/refresh.test.ts
git commit -m "Restore pr-dash's last payload at startup, marked stale"
```

---

## Task 5: Group state summaries

**Files:**
- Modify: `home/dot_local/share/pr-dash/public/group.js`
- Test: `home/dot_local/share/pr-dash/tests/group.test.ts`

**Interfaces:**
- Consumes: `PrRecord`, `Ci` and `Review` from `../src/types.ts` via JSDoc `import()` annotations, the convention this file already uses.
- Produces:
  - `groupSummary(records)` → `{ total: number, ci: Record<Ci, number>, review: Record<Review, number> }`.
  - `summaryChips(summary)` → `{ label: string, tone: string }[]`, ordered problems-first, omitting zero counts.

- [ ] **Step 1: Write the failing tests**

Append to `tests/group.test.ts`, reusing that file's existing `buildRecord` helper:

```ts
test('groupSummary counts every ci and review state', () => {
  const records = [
    buildRecord({ id: 'a#1', ci: 'failure', review: 'changes_requested' }),
    buildRecord({ id: 'a#2', ci: 'failure', review: 'approved' }),
    buildRecord({ id: 'a#3', ci: 'success', review: 'approved' }),
    buildRecord({ id: 'a#4', ci: 'pending', review: 'review_required' }),
    buildRecord({ id: 'a#5', ci: 'none', review: 'none' }),
  ];

  const summary = groupSummary(records);

  assert.strictEqual(summary.total, 5);
  assert.deepStrictEqual(summary.ci, { success: 1, failure: 2, pending: 1, none: 1 });
  assert.deepStrictEqual(summary.review, {
    approved: 2,
    changes_requested: 1,
    review_required: 1,
    none: 1,
  });
});

test('groupSummary reports zeroes rather than omitting a state', () => {
  // A caller reading summary.ci.failure must get 0, not undefined, or the chip logic has
  // to guard every lookup.
  const summary = groupSummary([buildRecord({ id: 'a#1', ci: 'success', review: 'approved' })]);
  assert.strictEqual(summary.ci.failure, 0);
  assert.strictEqual(summary.review.changes_requested, 0);
});

test('groupSummary of no records is all zeroes', () => {
  const summary = groupSummary([]);
  assert.strictEqual(summary.total, 0);
  assert.deepStrictEqual(summary.ci, { success: 0, failure: 0, pending: 0, none: 0 });
});

test('summaryChips leads with problems and omits empty states', () => {
  const records = [
    buildRecord({ id: 'a#1', ci: 'failure', review: 'approved' }),
    buildRecord({ id: 'a#2', ci: 'failure', review: 'approved' }),
    buildRecord({ id: 'a#3', ci: 'success', review: 'approved' }),
  ];

  const chips = summaryChips(groupSummary(records));

  assert.deepStrictEqual(chips, [
    { label: '2 failing', tone: 'bad' },
    { label: '3 approved', tone: 'good' },
  ]);
});

test('summaryChips puts failing CI before changes requested', () => {
  const records = [
    buildRecord({ id: 'a#1', ci: 'failure', review: 'review_required' }),
    buildRecord({ id: 'a#2', ci: 'success', review: 'changes_requested' }),
  ];

  const chips = summaryChips(groupSummary(records));

  assert.deepStrictEqual(chips.map((c) => c.label), ['1 failing', '1 changes', '1 waiting']);
});

test('summaryChips of a clean group is empty', () => {
  // Nothing to say is better than a chip saying so. The count is already in the header.
  const chips = summaryChips(groupSummary([buildRecord({ id: 'a#1', ci: 'success', review: 'none' })]));
  assert.deepStrictEqual(chips, []);
});
```

Add `groupSummary` and `summaryChips` to the existing `../public/group.js` import at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`

Expected: FAIL — `groupSummary is not exported`, and TS2305 from `tsc`.

- [ ] **Step 3: Implement both functions**

Append to `public/group.js`:

```js
/**
 * Counts of each CI and review state within one group, plus the group's size. Every
 * state is present with a count of 0 rather than omitted, so a caller can read
 * `summary.ci.failure` without guarding the lookup.
 * @typedef {object} GroupSummary
 * @property {number} total
 * @property {Record<import('../src/types.ts').Ci, number>} ci
 * @property {Record<import('../src/types.ts').Review, number>} review
 */

/**
 * Summarises a group's records. Pure, and here rather than in `app.js`, because
 * `app.js` cannot be imported under `node --test` — a count that silently drifts is
 * exactly the kind of thing a test has to hold.
 * @param {import('../src/types.ts').PrRecord[]} records
 * @returns {GroupSummary}
 */
export function groupSummary(records) {
  /** @type {GroupSummary} */
  const summary = {
    total: records.length,
    ci: { success: 0, failure: 0, pending: 0, none: 0 },
    review: { approved: 0, changes_requested: 0, review_required: 0, none: 0 },
  };
  for (const pr of records) {
    summary.ci[pr.ci] += 1;
    summary.review[pr.review] += 1;
  }
  return summary;
}

/**
 * One chip per state worth surfacing on a collapsed header, ordered so a problem is read
 * first, with empty states omitted.
 *
 * A collapsed header has to keep its signal: folding a repository away must not hide that
 * something inside it is failing or waiting on you, or collapsing becomes a way to lose
 * track of work. A clean group produces no chips at all — the count in the header already
 * says how much is in there.
 * @typedef {object} SummaryChip
 * @property {string} label
 * @property {'bad' | 'warn' | 'good'} tone
 *
 * @param {GroupSummary} summary
 * @returns {SummaryChip[]}
 */
export function summaryChips(summary) {
  /** @type {SummaryChip[]} */
  const chips = [];
  if (summary.ci.failure > 0) chips.push({ label: `${summary.ci.failure} failing`, tone: 'bad' });
  if (summary.review.changes_requested > 0) {
    chips.push({ label: `${summary.review.changes_requested} changes`, tone: 'bad' });
  }
  if (summary.review.review_required > 0) {
    chips.push({ label: `${summary.review.review_required} waiting`, tone: 'warn' });
  }
  if (summary.ci.pending > 0) chips.push({ label: `${summary.ci.pending} pending`, tone: 'warn' });
  if (summary.review.approved > 0) {
    chips.push({ label: `${summary.review.approved} approved`, tone: 'good' });
  }
  return chips;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` then `npm run check`

Expected: 340 passing, 0 failing; `tsc` exits 0.

- [ ] **Step 5: Verify the tests can actually fail**

1. Initialise `ci` as `{}` instead of all-zeroes → the zeroes test fails, and `tsc` rejects the incomplete `Record`.
2. Reorder `summaryChips` to push `approved` first → the ordering tests fail.
3. Drop the `> 0` guards → the clean-group test fails.
4. Change `summary.ci[pr.ci] += 1` to `= 1` → the counting test fails.

Revert each and confirm `git status --short` is empty.

- [ ] **Step 6: Commit**

```bash
git add public/group.js tests/group.test.ts
git commit -m "Summarise a group's CI and review states for a collapsed header"
```

---

## Task 6: Persist collapse state

**Files:**
- Modify: `home/dot_local/share/pr-dash/public/render-guards.js`
- Test: `home/dot_local/share/pr-dash/tests/render-guards.test.ts`

**Interfaces:**
- Consumes: `parseStoredView`, `DEFAULT_VIEW`, `VIEW_KEY`, `loadStoredView`, `saveStoredView`, `clearStoredView`, all already in this file.
- Produces:
  - `toCollapsedKeys(value)` → `string[]`, deduped, non-strings dropped.
  - `StoredView` gains `collapsed: string[]`, and `DEFAULT_VIEW.collapsed` is `[]`. Task 7 reads and writes it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/render-guards.test.ts`:

```ts
test('toCollapsedKeys keeps strings, drops everything else, and dedupes', () => {
  assert.deepStrictEqual(
    toCollapsedKeys(['acme/api', 'acme/api', 42, null, 'acme/web', undefined]),
    ['acme/api', 'acme/web'],
  );
});

test('toCollapsedKeys of a non-array is empty', () => {
  assert.deepStrictEqual(toCollapsedKeys('acme/api'), []);
  assert.deepStrictEqual(toCollapsedKeys({ 0: 'acme/api' }), []);
  assert.deepStrictEqual(toCollapsedKeys(undefined), []);
});

test('an unknown collapse key survives parsing rather than being rejected', () => {
  // Collapse keys legitimately outlive the payload they described: a merged PR or a
  // repository with nothing open leaves a key nothing reads. Dropping the whole view over
  // one would un-collapse everything after any PR merged.
  const view = parseStoredView(JSON.stringify({ collapsed: ['gone/repo', 'acme/api#9'] }));
  assert.deepStrictEqual(view.collapsed, ['gone/repo', 'acme/api#9']);
});

test('the default view collapses nothing', () => {
  assert.deepStrictEqual(parseStoredView(null).collapsed, []);
});

test('a corrupt collapsed field falls back without discarding the rest of the view', () => {
  const view = parseStoredView(JSON.stringify({ sort: 'age', collapsed: 'nope' }));
  assert.deepStrictEqual(view.collapsed, []);
  assert.strictEqual(view.sort, 'age', 'one bad field must not reset the others');
});

test('collapse state round-trips through storage', () => {
  const store = fakeStorage();
  saveStoredView(store, { ...parseStoredView(null), collapsed: ['acme/api'] });
  assert.deepStrictEqual(loadStoredView(store).collapsed, ['acme/api']);
});

test('clearStoredView clears collapse state along with the filters', () => {
  // Reset exists to un-stick a view the user can no longer see or change. A dashboard
  // collapsed to nothing is exactly that trap, so collapse must not survive a reset.
  const store = fakeStorage();
  saveStoredView(store, { ...parseStoredView(null), collapsed: ['acme/api'], ci: ['failure'] });
  clearStoredView(store);
  const after = loadStoredView(store);
  assert.deepStrictEqual(after.collapsed, []);
  assert.deepStrictEqual(after.ci, []);
});
```

Add `toCollapsedKeys` to the existing `../public/render-guards.js` import in the test file, and reuse that file's existing `fakeStorage` helper.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`

Expected: FAIL — `toCollapsedKeys is not exported`, plus assertion failures on `view.collapsed` being `undefined`.

- [ ] **Step 3: Add the validator and extend the stored view**

In `public/render-guards.js`, add after `toDraftValues`:

```js
/**
 * The collapsed section keys from a stored value: repository names for group headers and
 * PR ids for stack roots. Non-strings are dropped and duplicates collapsed, so a hand-
 * edited or older stored value cannot put anything but strings into the set.
 *
 * Unlike the axis and status validators, this one does not check membership in a known
 * list, because there is no such list: a key naming a merged PR or a repository with
 * nothing open is normal, and the section it named is simply not rendered. Rejecting
 * unknown keys would un-collapse everything the first time a PR merged.
 * @param {unknown} value
 * @returns {string[]}
 */
export function toCollapsedKeys(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string'))];
}
```

Add `collapsed` to the `StoredView` typedef:

```js
 * @property {string[]} collapsed
```

Add it to `DEFAULT_VIEW`:

```js
  collapsed: [],
```

And to the object `parseStoredView` returns:

```js
    collapsed: toCollapsedKeys(obj['collapsed']),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` then `npm run check`

Expected: 347 passing, 0 failing; `tsc` exits 0.

- [ ] **Step 5: Verify the tests can actually fail**

1. Drop the `new Set` → the dedupe assertion fails.
2. Drop the `typeof v === 'string'` filter → the drop-everything-else assertion fails.
3. Return `value` directly for a non-array → the non-array test fails.
4. Remove `collapsed` from `parseStoredView`'s returned object → the default and round-trip tests fail.
5. Add a membership check against a fixed list of keys → the unknown-key test fails.

Revert each and confirm `git status --short` is empty.

- [ ] **Step 6: Commit**

```bash
git add public/render-guards.js tests/render-guards.test.ts
git commit -m "Persist which pr-dash sections are collapsed"
```

---

## Task 7: Collapsible headers in the page

**Files:**
- Modify: `home/dot_local/share/pr-dash/public/index.html:48` (add two buttons before `#reset`)
- Modify: `home/dot_local/share/pr-dash/public/app.js` (`readControls`, `applyView`, `renderStack`, `render`, the listener block at the end)
- Modify: `home/dot_local/share/pr-dash/public/style.css`
- Test: `home/dot_local/share/pr-dash/tests/render-guards.test.ts` (markup sync only)

**Interfaces:**
- Consumes: `groupSummary` and `summaryChips` from `./group.js` (Task 5); `toCollapsedKeys` and the extended `StoredView` from `./render-guards.js` (Task 6).
- Produces: nothing other modules import. `app.js` is the leaf.

- [ ] **Step 1: Write the failing markup-sync test**

Append to `tests/render-guards.test.ts`, following the pattern the existing `AXES`/`SORTS` sync tests use to read `public/index.html`:

```ts
test('index.html carries the controls app.js binds by id', () => {
  // app.js looks these up by id and silently does nothing if one is missing, so a renamed
  // or dropped button is invisible without this assertion. emptyStateMessage also names
  // "Reset view" in its text, so that label is pinned here too.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['group-by', 'sort-by', 'collapse-all', 'expand-all', 'reset', 'refresh']) {
    assert.ok(html.includes(`id="${id}"`), `index.html must carry an element with id="${id}"`);
  }
  assert.ok(html.includes('>Reset view<'), 'emptyStateMessage names the "Reset view" control');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | tail -20`

Expected: FAIL — `index.html must carry an element with id="collapse-all"`.

- [ ] **Step 3: Add the buttons to `index.html`**

Immediately before the `#reset` button:

```html
  <button id="collapse-all" type="button">Collapse all</button>
  <button id="expand-all" type="button">Expand all</button>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`

Expected: 348 passing, 0 failing.

- [ ] **Step 5: Track collapse state in `app.js`**

Add to the imports from `./group.js`: `groupSummary`, `summaryChips`. Add to the imports from `./render-guards.js`: `toCollapsedKeys`.

Add the state and its helpers above `readControls`:

```js
/**
 * Keys of the sections the user has folded shut: a repository name for a group header, a
 * root PR's id for a stack. Held as a Set for the membership test `render` does per
 * section, and written back to storage as an array.
 * @type {Set<string>}
 */
let collapsed = new Set();

/** @param {string} key */
function toggleCollapsed(key) {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  saveView();
  render(current, currentStacks);
}
```

Extend `readControls` to persist it, adding one line to the returned object:

```js
    collapsed: [...collapsed],
```

Extend `applyView` to restore it, adding one line:

```js
  collapsed = new Set(toCollapsedKeys(view.collapsed));
```

`resetView` needs no change: it calls `applyView(parseStoredView(null))`, whose `collapsed` is `[]`, so the set empties with the filters.

- [ ] **Step 6: Render collapsible headers**

Add a header builder above `render`:

```js
/**
 * A section header that folds its contents away. The disclosure state lives on the button
 * as `aria-expanded`, and the header keeps the group's size and a state summary while
 * collapsed so folding a repository away never hides that something inside is failing.
 * @param {string} key
 * @param {string} label
 * @param {import('./group.js').GroupSummary} summary
 * @returns {HTMLElement}
 */
function collapsibleHeader(key, label, summary) {
  const isCollapsed = collapsed.has(key);
  const h2 = document.createElement('h2');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'disclosure';
  button.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  button.addEventListener('click', () => toggleCollapsed(key));

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = isCollapsed ? '▸' : '▾';
  button.append(chevron);

  const name = document.createElement('span');
  name.className = 'section-name';
  name.textContent = label;
  button.append(name);

  const count = document.createElement('span');
  count.className = 'section-count';
  count.textContent = summary.total === 1 ? '1 PR' : `${summary.total} PRs`;
  button.append(count);

  for (const chip of summaryChips(summary)) {
    const el = document.createElement('span');
    el.className = `summary-chip ${chip.tone}`;
    el.textContent = chip.label;
    button.append(el);
  }

  h2.append(button);
  return h2;
}
```

Replace the `for (const group of groupBy(...))` body in `render` with:

```js
  for (const group of groupBy(filtered, axis)) {
    const section = document.createElement('section');
    section.append(collapsibleHeader(group.key, group.key, groupSummary(group.records)));
    if (!collapsed.has(group.key)) {
      if (axis === 'repo') {
        // The tree, not the flat sort-selectable row list every other axis gets, since a
        // stack's shape is the point of grouping by repo. The Sort control still applies,
        // to the stack roots: without that it had no effect at all in the default view,
        // because buildStacks orders roots by number. Children keep their stack order.
        // `allowed` hides a filtered-out row without dropping its place in the tree.
        const roots = stacks.filter((s) => s.pr.repo === group.key);
        for (const root of sortStackRoots(roots, sort)) renderStack(root, section, allowed);
      } else {
        for (const pr of sortWithin(group.records, sort)) {
          const row = renderRow(pr);
          addStackBadges(row, byId.get(pr.id));
          section.append(row);
        }
      }
    }
    host.append(section);
  }
```

- [ ] **Step 7: Make stacks collapsible**

Replace `renderStack` with:

```js
/**
 * @param {StackNode} node
 * @param {HTMLElement} into
 * @param {Set<string>} allowed
 */
function renderStack(node, into, allowed) {
  if (allowed.has(node.pr.id)) {
    const row = renderRow(node.pr);
    row.style.marginLeft = `${node.depth * 20}px`;
    addStackBadges(row, node);
    // Only a root with children is worth a toggle: a single PR has nothing to fold, and a
    // child's own subtree folds with its root.
    if (node.depth === 0 && node.children.length > 0) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'disclosure stack-toggle';
      const isCollapsed = collapsed.has(node.pr.id);
      toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      toggle.textContent = isCollapsed ? '▸' : '▾';
      toggle.addEventListener('click', () => toggleCollapsed(node.pr.id));
      row.prepend(toggle);
    }
    into.append(row);
  }
  if (node.depth === 0 && collapsed.has(node.pr.id)) return;
  for (const child of node.children) renderStack(child, into, allowed);
}
```

- [ ] **Step 8: Wire the collapse-all controls**

Add beside the existing `#reset` and `#refresh` listeners at the end of `app.js`:

```js
// A way in needs a way out at the same granularity: per-section toggles alone leave no way
// to undo a session's worth of collapsing.
document.getElementById('collapse-all')?.addEventListener('click', () => {
  const groupSel = document.getElementById('group-by');
  const axis = toAxis(groupSel instanceof HTMLSelectElement ? groupSel.value : '');
  for (const group of groupBy(current, axis)) collapsed.add(group.key);
  saveView();
  render(current, currentStacks);
});

document.getElementById('expand-all')?.addEventListener('click', () => {
  collapsed.clear();
  saveView();
  render(current, currentStacks);
});
```

`expand-all` clears every key rather than only the visible groups, so a key left behind by a filter or an axis change cannot keep something folded invisibly.

- [ ] **Step 9: Style the new elements**

Append to `public/style.css`, matching the file's existing custom properties:

```css
/* The header is a button so the whole row is a click target and screen readers get the
   disclosure state from aria-expanded. Stripped back to look like the h2 it replaced. */
.disclosure {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.chevron {
  width: 1em;
  color: var(--dim);
}
.section-count {
  color: var(--dim);
  font-size: 0.8em;
  font-weight: 400;
}
.summary-chip {
  font-size: 0.72em;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--line);
}
.summary-chip.bad { color: var(--bad); }
.summary-chip.warn { color: var(--warn); }
.summary-chip.good { color: var(--good); }
.stack-toggle {
  width: auto;
  margin-right: 6px;
}
```

Before writing these, read `public/style.css` and confirm the custom property names — use whatever that file already defines for its dim, line, bad, warn and good colours rather than the names above.

- [ ] **Step 10: Run the suite and the type gate**

Run: `npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'` then `npm run check`

Expected: 348 passing, 0 failing; `tsc` exits 0. No new unit tests here — the logic worth testing went into `group.js` and `render-guards.js` in Tasks 5 and 6, because `app.js` cannot be imported under `node --test`.

- [ ] **Step 11: Verify in a browser**

`app.js`'s DOM wiring has no automated coverage, so check it by hand. Start the server with mock data rather than a real token:

```bash
PR_DASH_SECRET=$(node -e 'process.stdout.write("a".repeat(48))') GH_TOKEN=unused node src/main.ts
```

Then confirm each of these, which are the failure modes this task can introduce:

1. A repository header collapses on click and its rows disappear; the header keeps its count and any chips.
2. Reloading the page leaves it collapsed.
3. **Reset view expands everything** and clears the filters. A collapsed-everything dashboard that survives a reset is the trap the spec names.
4. Collapse all folds every group; Expand all restores them.
5. A stack root with children shows a toggle; collapsing it hides its descendants and leaves the root visible.
6. A single PR with no children shows no stack toggle.
7. Switching the grouping axis does not leave a section folded with no way to open it.

Record what you actually saw for each, not that you intended to check them.

- [ ] **Step 12: Commit**

```bash
git add public/app.js public/index.html public/style.css tests/render-guards.test.ts
git commit -m "Let pr-dash repositories and stacks fold away without losing their signal"
```

---

## Task 8: Document what shipped

**Files:**
- Modify: `docs/specs/2026-09-15-pr-dash-startup-and-collapse-design.md`
- Modify: `docs/specs/2026-09-14-pr-dashboard-design.md` (the refresh-and-failure and persistence surfaces)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Reconcile the new spec against the code**

Read the new spec top to bottom against the seven tasks above as implemented, and correct anything that is no longer true. Docs change in the same PR as the code they describe; a spec corrected in a follow-up is a spec that stays wrong until someone notices.

Check specifically: the file name and path in Part 2, the exact modes, `withFallback`'s real signature, the names `groupSummary` / `summaryChips` / `toCollapsedKeys`, and the chip wording, which the spec's mockup shows as `●2 failing  ●1 approved`.

- [ ] **Step 2: Update the parent spec's affected sections**

The parent spec describes the refresh and failure surface and lists nothing about disk persistence. Add the persisted payload to it, with its path, its modes and the fact that a restored payload renders as stale. State that the startup fetch is pre-loaded, so the cache is normally warm by the time the browser asks.

Do not restate the new spec in the parent; link to it by path and keep each fact in one place.

- [ ] **Step 3: Record anything deliberately left undone**

If any step above was skipped or landed differently, add it to the new spec's *Deferred* section with the reason. An undocumented deviation is the thing a later reader cannot recover.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-09-15-pr-dash-startup-and-collapse-design.md docs/specs/2026-09-14-pr-dashboard-design.md
git commit -m "Correct the pr-dash specs against the shipped startup and collapse work"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task:

| Spec section | Task |
|---|---|
| Part 1, pre-load | 2 |
| Part 1, in-flight deduplication | 1 |
| Part 2, where it plugs in | 4 |
| Part 2, at rest (modes, path) | 3 |
| Part 2, writing and reading | 3 |
| Part 3, collapsed header keeps its signal | 5, 7 |
| Part 3, state and the way back out | 6, 7 |
| Part 3, keys | 6 |
| Testing (all eight bullets) | 1, 3, 4, 5, 6 |

The spec's testing list is covered except the mode assertion, which Task 3 pins on the constants rather than on a real `stat` — the injected seam has no filesystem to stat. Task 4's step 7 checks the real mode by hand once, which is the only place a real `stat` can happen without writing to the operator's state directory during the suite.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries the code. Task 7 step 9 asks the implementer to read `style.css` for its real custom-property names rather than trusting the ones written here, which is a verification instruction, not a placeholder.

**Type consistency.** `LoadResult` is `{ prs, fetchedAt, partialErrors }` in Tasks 3 and 4 and matches `src/loader.ts`. `FallbackOpts` is named identically in Tasks 4's signature and its forwarding through `createLoadPrs`. `GroupSummary` is produced in Task 5 and consumed by name in Task 7's `collapsibleHeader` JSDoc. `toCollapsedKeys` is produced in Task 6 and consumed in Task 7's `applyView`. `collapsed` is `string[]` on `StoredView` and a `Set<string>` in `app.js`, converted at both boundaries.

**Test-count arithmetic.** The expected totals assume the baseline of 302 and that no task adds tests beyond those written above: 302 → 305 → 308 → 329 → 334 → 340 → 347 → 348. An implementer who adds a test should expect a higher number rather than treating the mismatch as a failure.
