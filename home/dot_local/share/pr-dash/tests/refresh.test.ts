import { test } from 'node:test';
import assert from 'node:assert';
import { withFallback, createLoadPrs, startPreload } from '../src/main-lib.ts';
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

test('createLoadPrs forwards its opts (initial and onSuccess) to withFallback', async () => {
  let fail = true;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      if (fail) throw new Error('network down');
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const seeded: LoadResult = { prs: one, fetchedAt: '2026-09-15T06:00:00.000Z', partialErrors: [] };
  const seen: LoadResult[] = [];
  const loadPrs = createLoadPrs(client, cache, {
    initial: seeded,
    onSuccess: (result) => seen.push(result),
  });

  // The cache is cold and the fetch fails, so this result can only come from `initial` —
  // it proves createLoadPrs actually hands its opts to withFallback rather than dropping
  // them (as `createLoadPrs(client, cache, {})` would, since main.ts has no test of its
  // own to catch that).
  const first = await loadPrs();
  assert.strictEqual(first.stale, true);
  assert.strictEqual(first.fetchedAt, seeded.fetchedAt);
  assert.deepStrictEqual(first.prs, one);

  // That first call took withFallback's prime path, which answers from `initial` and runs
  // the fetch behind the response. Draining lets that fetch fail before the next call, so
  // the assertions below are about a request that starts with nothing in flight.
  await new Promise((r) => setTimeout(r, 0));
  fail = false;
  const second = await loadPrs();

  assert.strictEqual(second.stale, false);
  assert.strictEqual(seen.length, 1, 'onSuccess must be forwarded through createLoadPrs');
  assert.strictEqual(seen[0]?.fetchedAt, second.fetchedAt);
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

test('startPreload calls the loader without being awaited', async () => {
  let calls = 0;
  const loadPrs = async () => {
    calls += 1;
    return { prs: one, fetchedAt: 'T1', partialErrors: [], stale: false };
  };

  startPreload(loadPrs);

  assert.strictEqual(calls, 1);
});

test('a rejected preload neither throws nor leaves an unhandled rejection (cold start)', async () => {
  // Composed with withFallback rather than a bare rejecting loadPrs: main.ts never hands
  // startPreload a bare loader, so a test that does can't disagree with the composition
  // main.ts actually builds. A cold start has no seed, so withFallback still rejects and
  // onError is the only way the operator learns about the failure.
  const seen: string[] = [];
  const loadPrs = withFallback(async () => {
    throw new Error('network down');
  });

  startPreload(loadPrs, (m) => seen.push(m));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepStrictEqual(seen, ['network down']);
});

test('a warm start never calls onError, since the stale banner already says so', async () => {
  // With a restored payload seeded as `initial`, withFallback resolves to it marked stale
  // rather than rejecting — the page's own banner names the failure and the last-good
  // time, so onError firing here would be a second, redundant channel for the same fact.
  const seen: string[] = [];
  const seeded: LoadResult = { prs: one, fetchedAt: '2026-09-15T06:00:00.000Z', partialErrors: [] };
  const loadPrs = withFallback(
    async () => {
      throw new Error('network down');
    },
    { initial: seeded },
  );

  startPreload(loadPrs, (m) => seen.push(m));
  await new Promise((r) => setTimeout(r, 0));

  assert.deepStrictEqual(seen, []);
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

test('a seeded payload is served, marked stale, when the first fetch fails', async () => {
  const seeded: LoadResult = { prs: one, fetchedAt: '2026-09-15T06:00:00.000Z', partialErrors: [] };
  const load = async () => {
    throw new Error('network down');
  };
  const loadPrs = withFallback(load, { initial: seeded });

  // The first call is the prime path, whose whole point is not to wait for the fetch — so
  // it cannot name a failure that has not happened yet, and its swallowed rejection is why
  // the error surfaces on the next request instead.
  const primeResult = await loadPrs();
  assert.strictEqual(primeResult.refreshing, true, 'the prime path tells the client to ask again');
  assert.strictEqual(primeResult.error, undefined, 'the fetch has not failed yet');
  await new Promise((r) => setTimeout(r, 0));

  const result = await loadPrs();

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
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) return fresh;
    throw new Error('network down');
  };
  const loadPrs = withFallback(load, { initial: seeded });

  // The successful fetch is the one the prime path starts behind its own response, so the
  // seed is what the first call returns and the drain is what lets that fetch land.
  const first = await loadPrs();
  assert.strictEqual(first.fetchedAt, 'OLD', 'the prime path answers from the seed');
  await new Promise((r) => setTimeout(r, 0));

  // A second, failing call is what actually proves the seed was replaced: its stale
  // fallback carries whatever withFallback thinks is the last good payload, so if the
  // first call's success never overwrote the seed, this would still read 'OLD'.
  const second = await loadPrs();
  assert.strictEqual(second.stale, true);
  assert.strictEqual(second.fetchedAt, 'NEW');
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

// The launchd path, which is the only one the agent uses: PR_DASH_PRELOAD is unset, so
// nothing is in flight when the browser's first /api/prs arrives. Before the prime path that
// request awaited createLazyToken -> resolveToken -> the `op` process -> the Touch ID prompt
// -> the paginated GraphQL query, and the page was blank for all of it.
test('the first request is answered from the restored payload while the fetch runs behind it', async () => {
  const seeded: LoadResult = { prs: one, fetchedAt: '2026-09-15T06:00:00.000Z', partialErrors: [] };
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fresh: LoadResult = { prs: [], fetchedAt: 'NEW', partialErrors: [] };
  let calls = 0;
  const loadPrs = withFallback(async () => {
    calls += 1;
    await gate;
    return fresh;
  }, { initial: seeded });

  // The gate is still shut, so this call resolving at all is the property under test: a
  // slow GitHub cannot hold up the first paint.
  const first = await loadPrs();
  assert.strictEqual(first.refreshing, true, 'the client must be told to ask again');
  assert.strictEqual(first.stale, true, 'a restored payload must never render as fresh');
  assert.strictEqual(first.error, undefined, 'nothing failed, so there is no error to name');
  assert.strictEqual(first.fetchedAt, seeded.fetchedAt);
  assert.deepStrictEqual(first.prs, one);
  assert.strictEqual(calls, 1, 'the fetch must have started behind that response');

  // A poll landing while that fetch is still running takes the `fetching > 0` shortcut and
  // answers from the same payload rather than starting a second fetch.
  const during = await loadPrs();
  assert.strictEqual(during.refreshing, true);
  assert.strictEqual(during.fetchedAt, seeded.fetchedAt);
  assert.strictEqual(calls, 1, 'a request behind the prime must not start a second fetch');

  release();
  await new Promise((r) => setTimeout(r, 0));
  const after = await loadPrs();
  assert.strictEqual(after.stale, false, 'once the fetch has landed, a later request is fresh');
  assert.strictEqual(after.fetchedAt, 'NEW');
});

test('a failing background fetch does not start a second fetch on the next poll', async () => {
  // The 4xx retry storm this project has already shipped once, in the other direction: if
  // each poll took the prime path it would start its own background fetch on top of the one
  // it awaits, so one unreachable GitHub would be two requests per poll.
  const seeded: LoadResult = { prs: one, fetchedAt: 'OLD', partialErrors: [] };
  let calls = 0;
  const loadPrs = withFallback(async () => {
    calls += 1;
    throw new Error('network down');
  }, { initial: seeded });

  await loadPrs();
  await new Promise((r) => setTimeout(r, 0));
  const secondPoll = await loadPrs();
  const thirdPoll = await loadPrs();

  assert.strictEqual(calls, 3, 'one fetch behind the prime, then exactly one per poll');
  assert.strictEqual(secondPoll.fetchedAt, 'OLD', 'the retained payload is unchanged');
  assert.strictEqual(secondPoll.error, 'network down');
  assert.strictEqual(thirdPoll.error, 'network down');
  assert.strictEqual(thirdPoll.refreshing, undefined, 'no fetch is running behind this one');
});

test('a forced first call bypasses the prime path, and the next poll starts no extra fetch', async () => {
  // The operator whose first action is clicking Refresh. `primed` is set before the force
  // check for this case: if a forced call left it false, this poll would take the prime path
  // and start a second background fetch alongside the one it awaits.
  const seeded: LoadResult = { prs: one, fetchedAt: 'OLD', partialErrors: [] };
  let calls = 0;
  const loadPrs = withFallback(async () => {
    calls += 1;
    return { prs: [], fetchedAt: 'NEW', partialErrors: [] };
  }, { initial: seeded });

  const forced = await loadPrs({ force: true });
  assert.strictEqual(forced.stale, false, 'a Refresh click waits for GitHub');
  assert.strictEqual(forced.refreshing, undefined, 'and is never answered from the seed');

  const poll = await loadPrs();

  assert.strictEqual(calls, 2, 'one fetch for the click and one for the poll, not three');
  assert.strictEqual(poll.refreshing, undefined, 'nothing is running behind this response');
});

test('a first-ever launch with nothing restored still waits for the fetch', async () => {
  // The prime path has nothing to answer with here, so the behaviour is unchanged: the
  // request awaits GitHub rather than painting an empty dashboard.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loadPrs = withFallback(async () => {
    await gate;
    return { prs: one, fetchedAt: 'NEW', partialErrors: [] };
  });

  let settled = false;
  const pending = loadPrs().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(settled, false, 'with nothing restored there is nothing to answer with');

  release();
  const result = await pending;
  assert.strictEqual(result.stale, false);
  assert.strictEqual(result.refreshing, undefined);
  assert.deepStrictEqual(result.prs, one);
});

test('a forced request waits for GitHub rather than taking the seed', async () => {
  const seeded: LoadResult = { prs: one, fetchedAt: 'OLD', partialErrors: [] };
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loadPrs = withFallback(async () => {
    await gate;
    return { prs: [], fetchedAt: 'NEW', partialErrors: [] };
  }, { initial: seeded });

  const pending = loadPrs();
  const forced = loadPrs({ force: true });
  release();

  const result = await forced;
  assert.strictEqual(result.refreshing, undefined, 'a Refresh click is never answered from the seed');
  assert.strictEqual(result.stale, false);
  assert.strictEqual(result.fetchedAt, 'NEW');
  await pending;
});

test('the shortcut closes once the fetch settles', async () => {
  const seeded: LoadResult = { prs: one, fetchedAt: 'OLD', partialErrors: [] };
  const loadPrs = withFallback(async () => ({ prs: [], fetchedAt: 'NEW', partialErrors: [] }), {
    initial: seeded,
  });

  // The prime path's own fetch has to land first, or the shortcut this test is about is
  // still open for the wrong reason.
  await loadPrs();
  await new Promise((r) => setTimeout(r, 0));
  const second = await loadPrs();

  assert.strictEqual(second.refreshing, undefined, 'no fetch is running, so nothing is pending');
  assert.strictEqual(second.stale, false);
  assert.strictEqual(second.fetchedAt, 'NEW');
});

test('a cold start with no seed waits for the fetch instead of answering empty', async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loadPrs = withFallback(async () => {
    await gate;
    return { prs: one, fetchedAt: 'NEW', partialErrors: [] };
  });

  const pending = loadPrs();
  const during = loadPrs();
  release();

  const result = await during;
  assert.strictEqual(result.refreshing, undefined, 'there is nothing to serve, so it must wait');
  assert.strictEqual(result.stale, false);
  assert.deepStrictEqual(result.prs, one);
  await pending;
});

test('the seed served mid-fetch is not recorded as a success', async () => {
  const seeded: LoadResult = { prs: one, fetchedAt: 'OLD', partialErrors: [] };
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const loadPrs = withFallback(
    async () => {
      await gate;
      return { prs: [], fetchedAt: 'NEW', partialErrors: [] };
    },
    { initial: seeded, onSuccess: (r) => seen.push(r.fetchedAt) },
  );

  const pending = loadPrs();
  await loadPrs();
  release();
  // The prime path's fetch is the one that produces 'NEW', and it settles behind the
  // response rather than with `pending`, so the drain is what gives it time to notify.
  await pending;
  await new Promise((r) => setTimeout(r, 0));

  assert.deepStrictEqual(seen, ['NEW'], 'only a real fetch is worth persisting');
});

test('a cold start with two concurrent calls fires onSuccess exactly once', async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      await gate;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  const seen: string[] = [];
  const loadPrs = createLoadPrs(client, cache, { onSuccess: (r) => seen.push(r.fetchedAt) });

  // Neither call has a seed to be served from, so both skip the shortcut and reach
  // createPrLoader's own in-flight dedup, which resolves both to the same object.
  const first = loadPrs();
  const second = loadPrs();
  release();
  await Promise.all([first, second]);

  assert.strictEqual(seen.length, 1, 'both calls join one real fetch, not two');
});

test('two sequential calls served from the same cached object fire onSuccess once', async () => {
  const client = createClient({ token: 'tok', fetchImpl: async () => pageResponse([RAW_NODE]) });
  const cache = createCache<LoadResult>(60_000);
  const seen: string[] = [];
  const loadPrs = createLoadPrs(client, cache, { onSuccess: (r) => seen.push(r.fetchedAt) });

  await loadPrs();
  await loadPrs();

  assert.strictEqual(seen.length, 1, 'the second call is a cache hit returning the same object, not a new fetch');
});

test('a throwing onSuccess is re-offered the same result on the next call', async () => {
  const fresh: LoadResult = { prs: one, fetchedAt: 'NEW', partialErrors: [] };
  let calls = 0;
  const seen: string[] = [];
  const loadPrs = withFallback(async () => fresh, {
    onSuccess: (r) => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      seen.push(r.fetchedAt);
    },
  });

  await loadPrs();
  await loadPrs();

  assert.strictEqual(calls, 2, 'a throw must not mark the result as already notified');
  assert.deepStrictEqual(seen, ['NEW']);
});

test('a throw on the first of two concurrent cold-start calls notifies onSuccess twice for one fetch', async () => {
  // Documents the retry's one side effect rather than suppressing it: a cold start with no
  // seed skips the retained-payload shortcut, so both concurrent calls join createPrLoader's
  // in-flight fetch and both land in the branch that calls onSuccess. If the first of them
  // throws, the fix for the throw-then-retry case above also leaves this result eligible for
  // the second -- two notifications for the one real fetch. Ruled benign and kept: this
  // repo's only onSuccess (main.ts's store.write) does an atomic rename to a randomUUID temp
  // file, so a second write of identical bytes cannot race destructively. A future onSuccess
  // that is not idempotent needs its own guard; this test exists so removing the second
  // notification without updating FallbackOpts.onSuccess's doc comment fails loudly.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      await gate;
      return pageResponse([RAW_NODE]);
    },
  });
  const cache = createCache<LoadResult>(60_000);
  let calls = 0;
  const seen: LoadResult[] = [];
  const loadPrs = createLoadPrs(client, cache, {
    onSuccess: (r) => {
      calls += 1;
      seen.push(r);
      if (calls === 1) throw new Error('disk full');
    },
  });

  const first = loadPrs();
  const second = loadPrs();
  release();
  await Promise.all([first, second]);

  assert.strictEqual(calls, 2);
  assert.strictEqual(seen[0], seen[1], 'both notifications receive the same result object');
});
