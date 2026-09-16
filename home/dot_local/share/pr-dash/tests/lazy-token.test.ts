// createLazyToken/createLazyClient are the seam the always-on design's "Lazy token
// resolution" section describes: main.ts builds these before any token exists, and the
// actual `op` process only ever runs once something (the startup pre-load or the browser's
// own first /api/prs) calls client.query. See docs/specs/2026-09-16-pr-dash-always-on-design.md.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLazyClient, createLazyToken, TOKEN_FAILURE_TTL_MS } from '../src/main-lib.ts';
import { createClient } from '../src/github.ts';
import { stripComments } from './strip-comments.ts';

function graphqlResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_LIB_TS = path.join(__dirname, '..', 'src', 'main-lib.ts');

test('resolves the token and returns it', async () => {
  const getToken = createLazyToken(async () => 'tok');
  assert.strictEqual(await getToken(), 'tok');
});

test('two concurrent callers resolve the token exactly once', async () => {
  let calls = 0;
  // Each call returns a distinct value, so a broken implementation that starts a second
  // resolution instead of joining the first would hand the two callers different tokens
  // rather than just running `resolve` an extra time that a bare call count could miss.
  const getToken = createLazyToken(async () => {
    calls += 1;
    return `tok-${calls}`;
  });

  const [a, b] = await Promise.all([getToken(), getToken()]);

  assert.strictEqual(calls, 1, 'the second caller must join the in-flight resolution');
  assert.strictEqual(a, 'tok-1');
  assert.strictEqual(b, 'tok-1', 'both callers must see the one resolution, not two');
});

test('a successful resolution is reused for later calls, not re-run', async () => {
  let calls = 0;
  const getToken = createLazyToken(async () => {
    calls += 1;
    return `tok-${calls}`;
  });

  const first = await getToken();
  const second = await getToken();

  assert.strictEqual(calls, 1);
  assert.strictEqual(second, first, 'a later call must reuse the cached token, not a new one');
});

// A clock these tests move by hand, so the negative cache's window can be crossed without
// waiting for it. Every test that retries after a failure needs one: the retry is inside
// TOKEN_FAILURE_TTL_MS by construction, and the real Date.now would keep it there.
function fakeClock(start = 1_000) {
  let ms = start;
  return {
    now: () => ms,
    advance: (by: number) => {
      ms += by;
    },
  };
}

test('a rejected resolution is not cached, so the next call tries again', async () => {
  let calls = 0;
  const clock = fakeClock();
  const getToken = createLazyToken(async () => {
    calls += 1;
    if (calls === 1) throw new Error('touch id dismissed');
    return 'tok';
  }, { now: clock.now });

  await assert.rejects(() => getToken(), /touch id dismissed/);
  // A retained rejected promise would replay 'touch id dismissed' here forever, which is
  // exactly the poisoned-process failure this function exists to avoid. The negative cache
  // bounds how long the replay lasts; it must not make it permanent.
  clock.advance(TOKEN_FAILURE_TTL_MS);
  const token = await getToken();

  assert.strictEqual(calls, 2);
  assert.strictEqual(token, 'tok');
});

test('a retry inside the failure TTL rethrows without starting another op process', async () => {
  // The spawn storm this bounds: a cold-start credential failure has the page polling a 500
  // every 600ms for 60 seconds, and without this each poll would start a fresh `op` and
  // re-prompt for the biometrics the operator just dismissed.
  let calls = 0;
  const clock = fakeClock();
  const getToken = createLazyToken(async () => {
    calls += 1;
    throw new Error('touch id dismissed');
  }, { now: clock.now });

  await assert.rejects(() => getToken(), /touch id dismissed/);
  clock.advance(TOKEN_FAILURE_TTL_MS - 1);
  await assert.rejects(() => getToken(), /touch id dismissed/);

  assert.strictEqual(calls, 1, 'the retained failure must answer without resolving again');
});

test('a success after a failure is what later calls see, not the retained failure', async () => {
  let calls = 0;
  const clock = fakeClock();
  const getToken = createLazyToken(async () => {
    calls += 1;
    if (calls === 1) throw new Error('vault locked');
    return 'tok';
  }, { now: clock.now });

  await assert.rejects(() => getToken(), /vault locked/);
  clock.advance(TOKEN_FAILURE_TTL_MS);
  await getToken();

  // Inside the TTL measured from the failure, so a negative cache consulted ahead of the
  // resolved token would rethrow 'vault locked' here.
  assert.strictEqual(await getToken(), 'tok');
  assert.strictEqual(calls, 2, 'the cached token answers this, with no third resolution');
});

test('two concurrent callers who both hit a rejection see the same error, and both retry after', async () => {
  let calls = 0;
  const clock = fakeClock();
  const getToken = createLazyToken(async () => {
    calls += 1;
    if (calls === 1) throw new Error('first attempt failed');
    return 'tok';
  }, { now: clock.now });

  const results = await Promise.allSettled([getToken(), getToken()]);
  assert.strictEqual(calls, 1, 'both concurrent callers must share the one failed attempt');
  for (const result of results) {
    assert.strictEqual(result.status, 'rejected');
  }

  clock.advance(TOKEN_FAILURE_TTL_MS);
  const token = await getToken();
  assert.strictEqual(calls, 2);
  assert.strictEqual(token, 'tok');
});

test('createLazyClient does not resolve the token until a query is made', async () => {
  let getTokenCalls = 0;
  const getToken = async (): Promise<string> => {
    getTokenCalls += 1;
    return 'tok';
  };
  createLazyClient(getToken, () => {
    throw new Error('makeClient must not run before a query needs it');
  });

  assert.strictEqual(getTokenCalls, 0);
});

test('createLazyClient resolves the token and forwards the query to the real client', async () => {
  let seenAuth = '';
  const client = createLazyClient(
    async () => 'resolved-tok',
    (token) =>
      createClient({
        token,
        fetchImpl: async (_url, init) => {
          seenAuth = String(new Headers(init?.headers).get('authorization'));
          return graphqlResponse({ data: { viewer: { login: 'octocat' } } });
        },
      }),
  );

  const result = await client.query<{ viewer: { login: string } }>('query { viewer { login } }', {});

  // The bearer header is how a wrong or stale token would actually show up on the wire,
  // which is what this test is really checking: not that some client was built, but that
  // it was built with the token createLazyClient resolved.
  assert.strictEqual(seenAuth, 'Bearer resolved-tok');
  assert.deepStrictEqual(result, { data: { viewer: { login: 'octocat' } }, errors: [] });
});

test('a token rejection propagates through query unchanged, without a client ever being built', async () => {
  const client = createLazyClient(
    async () => {
      throw new Error('Could not read the GitHub token from 1Password. Run: op read ...');
    },
    () => {
      throw new Error('makeClient must not run when the token failed to resolve');
    },
  );

  await assert.rejects(
    () => client.query('query {}', {}),
    /Could not read the GitHub token from 1Password/,
  );
});

// The token lives in createLazyToken's closure now, not in a `let token` variable in
// main.ts, so a leak of it would have to come from a log statement written in this module.
// There are none today; this pins that rather than counting mentions of the word "token",
// which appears legitimately many times here (parameter names, type names, doc comments).
test('main-lib.ts contains no console or stdout/stderr writes that could log a resolved token', () => {
  const stripped = stripComments(readFileSync(MAIN_LIB_TS, 'utf8'));
  assert.doesNotMatch(stripped, /console\.\w+\s*\(|process\.(stdout|stderr)\.write\s*\(/);
});
