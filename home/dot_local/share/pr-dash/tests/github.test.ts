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
  const result = await fetchAllPrs(client);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(result.prs.map((n: { number: number }) => n.number), [1, 2]);
});

test('a 401 says how to renew the token without disclosing where it is stored', async () => {
  // This message reaches the browser banner (via a 200 /api/prs body carrying a retained
  // payload, and via server.ts's 500 path), so the 1Password item reference it used to
  // embed was a client-visible statement of where the credential lives. token.ts already
  // prints the exact `op read` command at startup, which is where an operator needs it.
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => 'Bad credentials',
      } as unknown as Response),
  });
  await assert.rejects(
    () => fetchAllPrs(client),
    (e: Error) =>
      /expired or revoked/.test(e.message) &&
      /1Password/.test(e.message) &&
      /restart pr-dash/.test(e.message) &&
      !e.message.includes('op://'),
  );
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

// GitHub answers a large `search` query with HTTP 200 carrying both usable `data` and an
// `errors` array when one field timed out. Spec:191 requires rendering the rows that did
// arrive and naming what failed, so these four tests pin the line between a partial
// success (usable data, keep it) and a failure (no usable data, throw).

test('a 200 carrying both rows and errors keeps the rows and reports the errors', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 7 }] } },
          errors: [{ message: 'Something went wrong while executing your query.' }],
        }),
        text: async () => '',
      } as Response),
  });
  const result = await fetchAllPrs(client);
  assert.deepStrictEqual(result.prs.map((n: { number: number }) => n.number), [7]);
  assert.deepStrictEqual(result.errors, ['Something went wrong while executing your query.']);
});

test('a complete 200 reports no errors', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => pageResponse([{ number: 1 }], false, null),
  });
  const result = await fetchAllPrs(client);
  assert.deepStrictEqual(result.errors, []);
});

test('errors with a null search field are a failure, not a partial success', async () => {
  // The realistic shape when the whole `search` field is what timed out. There is no row
  // to keep here, so retaining it as a partial success would present "no open PRs".
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ data: { search: null }, errors: [{ message: 'timeout on search' }] }),
        text: async () => '',
      } as Response),
  });
  await assert.rejects(() => fetchAllPrs(client), (e: Error) => /timeout on search/.test(e.message));
});

test('a null search field after a good page keeps the rows already collected', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return pageResponse([{ number: 1 }], true, 'cur');
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { search: null }, errors: [{ message: 'timeout on page 2' }] }),
        text: async () => '',
      } as Response;
    },
  });
  const result = await fetchAllPrs(client);
  assert.deepStrictEqual(result.prs.map((n: { number: number }) => n.number), [1]);
  assert.deepStrictEqual(result.errors, ['timeout on page 2']);
});

test('errors with zero rows collected are a failure, not an empty result', async () => {
  // `nodes: []` passes an "is it an array" check while carrying nothing. Returning that
  // as a partial success would hand the loader an empty payload to cache and retain,
  // replacing the rows the user can already see with "no open PRs" behind a banner.
  // withFallback only retains on a throw, so this has to throw.
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
          errors: [{ message: 'timeout on search' }],
        }),
        text: async () => '',
      } as Response),
  });
  await assert.rejects(() => fetchAllPrs(client), (e: Error) => /timeout on search/.test(e.message));
});

test('an empty result with no errors is a real answer: no open PRs', async () => {
  // The other side of the test above. Zero rows is only a failure when something failed;
  // a user with no open PRs must not see an error.
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => pageResponse([], false, null),
  });
  const result = await fetchAllPrs(client);
  assert.deepStrictEqual(result.prs, []);
  assert.deepStrictEqual(result.errors, []);
});

test('an empty page with errors after a good page keeps the earlier rows', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return pageResponse([{ number: 1 }], true, 'cur');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
          errors: [{ message: 'timeout on page 2' }],
        }),
        text: async () => '',
      } as Response;
    },
  });
  const result = await fetchAllPrs(client);
  assert.deepStrictEqual(result.prs.map((n: { number: number }) => n.number), [1]);
  assert.deepStrictEqual(result.errors, ['timeout on page 2']);
});

test('a partial page stops pagination rather than trusting its pageInfo', async () => {
  // A page that carries errors may carry a null or garbage pageInfo alongside its rows.
  // Reading hasNextPage off it would throw; following it would be chasing a cursor the
  // server never really issued.
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { search: { pageInfo: null, nodes: [{ number: calls }] } },
          errors: [{ message: 'partial page' }],
        }),
        text: async () => '',
      } as Response;
    },
  });
  const result = await fetchAllPrs(client);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(result.prs.map((n: { number: number }) => n.number), [1]);
});

test('a 429 raises a rate-limit error naming the retry delay', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '30' }),
        text: async () => 'rate limited',
      } as unknown as Response),
  });
  await assert.rejects(() => fetchAllPrs(client), (e: Error) => /rate.limited/i.test(e.message) && /30s/.test(e.message));
});

test('a bare 403 falls through to the generic message rather than being called rate limiting', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => 'Resource not accessible: missing scope',
      } as unknown as Response),
  });
  await assert.rejects(
    () => fetchAllPrs(client),
    (e: Error) => /missing scope/.test(e.message) && !/rate.limited/i.test(e.message),
  );
});

test('a 403 carrying Retry-After is secondary rate limiting, not a scope problem', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 403,
        headers: new Headers({ 'retry-after': '60' }),
        text: async () => 'You have exceeded a secondary rate limit',
      } as unknown as Response),
  });
  await assert.rejects(() => fetchAllPrs(client), (e: Error) => /rate.limited/i.test(e.message) && /60s/.test(e.message));
});

test('a Retry-After given as an HTTP-date is reported without a bogus "s" unit', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }),
        text: async () => 'rate limited',
      } as unknown as Response),
  });
  await assert.rejects(
    () => fetchAllPrs(client),
    (e: Error) => e.message.includes('Retry after Wed, 21 Oct 2015 07:28:00 GMT.') && !e.message.includes('GMTs'),
  );
});

test('a 503 carrying Retry-After surfaces as a generic failure, not rate limiting', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 503,
        headers: new Headers({ 'retry-after': '120' }),
        text: async () => 'Service Unavailable: scheduled maintenance',
      } as unknown as Response),
  });
  await assert.rejects(
    () => fetchAllPrs(client),
    (e: Error) => /scheduled maintenance/.test(e.message) && !/rate.limited/i.test(e.message),
  );
});

test('a huge upstream body is truncated rather than becoming the whole banner', async () => {
  // The generic branch quotes GitHub's response body, and that message reaches the browser
  // banner. It renders through textContent, so it cannot inject anything, but an HTML error
  // page or a long proxy diagnostic would otherwise be the entire banner.
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => 'x'.repeat(5000),
      } as unknown as Response),
  });
  await assert.rejects(
    () => fetchAllPrs(client),
    (e: Error) =>
      e.message.length < 500 && /GitHub returned 500/.test(e.message) && /truncated/.test(e.message),
  );
});

test('a short upstream body is quoted whole, with no truncation marker', async () => {
  const client = createClient({
    token: 'tok',
    fetchImpl: async () =>
      ({
        ok: false,
        status: 502,
        headers: new Headers(),
        text: async () => 'Bad gateway',
      } as unknown as Response),
  });
  await assert.rejects(
    () => fetchAllPrs(client),
    (e: Error) => e.message.includes('Bad gateway') && !/truncated/.test(e.message),
  );
});

test('pagination terminates when hasNextPage stays true but the cursor never advances', async () => {
  let calls = 0;
  const client = createClient({
    token: 'tok',
    fetchImpl: async () => {
      calls += 1;
      // A hostile/malformed server keeps saying there's more, with the same cursor
      // every time. Without a bound this loops forever; fetchAllPrs must give up.
      return pageResponse([{ number: calls }], true, 'same-cursor');
    },
  });
  await assert.rejects(() => fetchAllPrs(client), /pagination/i);
  assert.ok(calls < 1000, `expected the loop to bail out well before ${calls} calls`);
});
