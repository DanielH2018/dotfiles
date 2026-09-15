import { test } from 'node:test';
import assert from 'node:assert';
import { withFallback, createLoadPrs } from '../src/main-lib.ts';
import { createClient } from '../src/github.ts';
import { createCache } from '../src/cache.ts';
import type { LoadResult } from '../src/loader.ts';
import type { PrRecord } from '../src/types.ts';

// A non-empty payload, not `[]`: a fallback that returns the fresh (empty) result
// instead of the retained one would still pass `deepStrictEqual([], [])` below, so
// an empty fixture can't tell "retained" apart from "fresh but empty".
const one: PrRecord[] = [
  {
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
  },
];

test('a successful load is not stale', async () => {
  const load = withFallback(async () => ({ prs: one, fetchedAt: '2026-01-01T00:00:00.000Z', partialErrors: [] }));
  const r = await load();
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.error, undefined);
});

test('a failure after a success returns the last good payload, marked stale', async () => {
  let fail = false;
  const load = withFallback(async () => {
    if (fail) throw new Error('network down');
    return { prs: one, fetchedAt: '2026-01-01T00:00:00.000Z', partialErrors: [] };
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

// createLoadPrs is the assembly main.ts hands straight to the server: a real client and
// cache feed createPrLoader, and withFallback sits on top. main.ts itself has no test
// coverage — it is a process shell that reads env vars and calls process.exit — so this
// wiring only stays honest if the assembled function is tested here, not just its pieces
// in isolation.
function pageResponse(nodes: unknown[]) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }),
    text: async () => '',
  } as unknown as Response;
}

const RAW_NODE = {
  number: 1,
  title: 'Add feature',
  url: 'https://github.com/acme/api/pull/1',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'feature',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  additions: 1,
  deletions: 1,
  reviewDecision: null,
  repository: { nameWithOwner: 'acme/api' },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};

test('createLoadPrs falls back to the retained payload when a later fetch fails', async () => {
  let fail = false;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      if (fail) throw new Error('network down');
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createLoadPrs(client, cache);

  const first = await loadPrs();
  assert.strictEqual(first.stale, false);

  // Force a real re-fetch attempt rather than a cache hit, so the failure actually
  // reaches createLoadPrs instead of being masked by a warm cache.
  cache.invalidate();
  fail = true;
  const second = await loadPrs();

  assert.strictEqual(second.stale, true);
  assert.match(String(second.error), /network down/);
  assert.deepStrictEqual(second.prs, first.prs);
});

test("a poll within the TTL reports the loader's real fetch time, not the time of the poll", async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => pageResponse([RAW_NODE]),
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createLoadPrs(client, cache);

  const before = Date.now();
  const first = await loadPrs();
  const after = Date.now();
  const fetchedAt = Date.parse(first.fetchedAt);
  assert.ok(fetchedAt >= before && fetchedAt <= after, `expected ${first.fetchedAt} within [${before}, ${after}]`);

  // A real gap, not a same-tick second call: a broken implementation that re-stamps
  // fetchedAt to "now" on every successful call (rather than trusting the loader's own
  // timestamp) would otherwise slip through, since two `new Date().toISOString()` calls
  // microseconds apart round to the same string. Within the cache's TTL this second call
  // is a cache hit, which must report the original fetch time, not the time of this read.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await loadPrs();
  assert.strictEqual(second.fetchedAt, first.fetchedAt);
});

test('a forced refresh through createLoadPrs re-fetches inside the TTL', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createLoadPrs(client, cache);

  const first = await loadPrs();
  assert.strictEqual(calls, 1);

  // The assembled function is what main.ts hands the server, so this is the layer where
  // a `force` dropped by withFallback would go unnoticed — createPrLoader honouring it
  // in isolation is not enough. The real gap is needed for the same reason as in the
  // poll test above: two `new Date().toISOString()` calls in the same millisecond are
  // the same string, so a forced re-fetch would be indistinguishable from a cache hit.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const forced = await loadPrs({ force: true });

  assert.strictEqual(calls, 2);
  assert.strictEqual(forced.stale, false);
  assert.notStrictEqual(forced.fetchedAt, first.fetchedAt);
});

test('a forced refresh that fails still falls back to the retained payload', async () => {
  let fail = false;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      if (fail) throw new Error('network down');
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createLoadPrs(client, cache);

  const first = await loadPrs();
  fail = true;
  // Forcing clears the cache before fetching, so this is the case where the only copy of
  // the data left is withFallback's retained one. Going blank here would be the spec's
  // worst outcome: the user clicked Refresh and lost the rows they could already see.
  const second = await loadPrs({ force: true });

  assert.strictEqual(second.stale, true);
  assert.match(String(second.error), /network down/);
  assert.deepStrictEqual(second.prs, first.prs);
});
