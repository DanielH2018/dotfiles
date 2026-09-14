import { DEFAULT_ITEM } from './token.ts';

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

      // A 401 means the token itself is bad, not that the network or the query is —
      // name the 1Password item and the renewal step rather than a generic failure. The
      // item ref named here is the DEFAULT_ITEM token.ts falls back to; a caller running
      // with PR_DASH_OP_ITEM set uses a different item, which this message can't know.
      if (res.status === 401) {
        throw new Error(
          'GitHub rejected the token (401): it is expired or revoked. ' +
            `Renew it in 1Password at "${DEFAULT_ITEM}" (or whatever item PR_DASH_OP_ITEM ` +
            'points at), then restart pr-dash.',
        );
      }
      if (!res.ok) {
        // Rate limiting is identified by the GraphQL API's own signals — a 429, a
        // Retry-After header (GitHub's secondary/abuse rate limiting returns this on a
        // 403 without necessarily zeroing x-ratelimit-remaining), or x-ratelimit-remaining:
        // 0 — not by status code alone: GitHub returns a bare 403 for a plain scope/SSO
        // problem far more often than for rate limiting, and primary rate-limit exhaustion
        // on this endpoint actually surfaces as HTTP 200 with a RATE_LIMITED entry in
        // `errors` (handled below, not here). A 403 carrying none of these signals falls
        // through to the generic branch, whose body from GitHub names the real scope/SSO
        // problem. `res.headers?.` guards a test double that omits headers; a real fetch
        // Response always has one, so ordering these checks relative to the 401 check
        // above is not load-bearing either way.
        const retryAfter = res.headers?.get('retry-after') ?? null;
        const remaining = res.headers?.get('x-ratelimit-remaining') ?? null;
        if (res.status === 429 || retryAfter !== null || remaining === '0') {
          throw new Error(
            `GitHub rate-limited this request (${res.status}).` +
              (retryAfter !== null ? ` Retry after ${retryAfter}s.` : ' Wait for the rate limit to reset.'),
          );
        }
        throw new Error(`GitHub returned ${res.status}: ${await res.text()}`);
      }

      const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
      // GraphQL returns HTTP 200 even when the query failed server-side, so `errors` must
      // be checked before trusting `data` — an empty `data.search.nodes` here would read as
      // "you have no open PRs" instead of the actual rate-limit or query error.
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
