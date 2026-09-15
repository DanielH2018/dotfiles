import { test } from 'node:test';
import assert from 'node:assert';
import { createPrLoader } from '../src/loader.ts';
import { createClient } from '../src/github.ts';
import { createCache } from '../src/cache.ts';
import type { Cache } from '../src/cache.ts';
import type { LoadResult } from '../src/loader.ts';

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

test('a cache miss fetches, normalizes, and populates the cache', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createPrLoader(client, cache);

  const before = Date.now();
  const result = await loadPrs();
  const after = Date.now();

  assert.strictEqual(calls, 1);
  assert.strictEqual(result.prs.length, 1);
  assert.strictEqual(result.prs[0]?.id, 'acme/api#1');
  assert.deepStrictEqual(cache.get(), result);
  // Pins the actual value loader.ts stamps on a fresh fetch, not just that whatever value
  // it picked round-trips through the cache unchanged (deepStrictEqual above would pass
  // just the same if fetchedAt were hardcoded to any fixed string).
  const fetchedAt = Date.parse(result.fetchedAt);
  assert.ok(fetchedAt >= before && fetchedAt <= after, `expected ${result.fetchedAt} within [${before}, ${after}]`);
});

test('a cache hit does not re-fetch', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createPrLoader(client, cache);

  const first = await loadPrs();
  const second = await loadPrs();

  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(second, first);
});

test('a failed fetch leaves the previously cached value intact', async () => {
  // A real createCache can't model "stale but still holding the last good value" from the
  // outside — get() either returns the live value or undefined, with no way to seed
  // "expired, but something used to be there" and then observe whether it got overwritten.
  // What actually matters is narrower and directly testable: a fetch that throws must never
  // reach cache.set(), so whatever the cache held before (a fresh value, an expired one, or
  // nothing) is left exactly as it was — not cleared, not replaced with an empty result.
  let setCalls = 0;
  let invalidateCalls = 0;
  const cache: Cache<LoadResult> = {
    get: () => undefined,
    set: () => {
      setCalls += 1;
    },
    invalidate: () => {
      invalidateCalls += 1;
    },
  };

  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const loadPrs = createPrLoader(client, cache);

  await assert.rejects(() => loadPrs(), /network down/);
  assert.strictEqual(setCalls, 0);
  // "Poisoning or clearing" covers both directions: nothing about a throwing fetch should
  // call cache.invalidate() either, even though the shipped loadPrs never does today —
  // this guards against a later "clean up on error" instinct wiping a value that was still
  // good.
  assert.strictEqual(invalidateCalls, 0);
});

test('a cache hit reports the original fetch time, not the time of the read', async () => {
  const cache = createCache<LoadResult>(60_000);
  const seeded: LoadResult = { prs: [], fetchedAt: '2020-01-01T00:00:00.000Z' };
  cache.set(seeded);

  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      throw new Error('should not be called on a cache hit');
    },
  });
  const loadPrs = createPrLoader(client, cache);

  const result = await loadPrs();
  assert.strictEqual(result.fetchedAt, '2020-01-01T00:00:00.000Z');
});

test('a forced load bypasses a warm cache and re-fetches', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createPrLoader(client, cache);

  await loadPrs();
  assert.strictEqual(calls, 1);

  // The cache is warm and well inside its 60s TTL, so an unforced call here would be a
  // hit. This is what the Refresh control needs: a click must reach GitHub rather than
  // being served the payload the user is trying to replace.
  await loadPrs({ force: true });
  assert.strictEqual(calls, 2);
});

test('a forced load repopulates the cache, so the next poll is a hit', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createPrLoader(client, cache);

  const forced = await loadPrs({ force: true });
  assert.strictEqual(calls, 1);
  // Invalidating without repopulating would leave every later poll fetching too, turning
  // the TTL off for good after the first click.
  assert.deepStrictEqual(cache.get(), forced);
  await loadPrs();
  assert.strictEqual(calls, 1);
});

test('an unforced load is a poll: force defaults to off', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const loadPrs = createPrLoader(client, cache);

  await loadPrs();
  await loadPrs({ force: false });
  await loadPrs({});
  assert.strictEqual(calls, 1);
});
