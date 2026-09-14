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
