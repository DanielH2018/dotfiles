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
        // Rate limiting is identified by the GraphQL API's own signals on the status codes
        // where it actually occurs — a plain 429, or a 403 carrying a Retry-After header
        // (GitHub's secondary/abuse rate limiting, which doesn't necessarily zero
        // x-ratelimit-remaining) or x-ratelimit-remaining: 0 — not by status code alone,
        // and not by Retry-After alone: GitHub returns a bare 403 for a plain scope/SSO
        // problem far more often than for rate limiting, and a Retry-After on some other
        // status (a 503 during a maintenance window, say) is an outage, not a rate limit.
        // Primary rate-limit exhaustion on this endpoint actually surfaces as HTTP 200 with
        // a RATE_LIMITED entry in `errors` (handled below, not here). Anything that isn't
        // flagged as rate-limited falls through to the generic branch, whose body from
        // GitHub names the real problem. `res.headers?.` guards a test double that omits
        // headers so a missing headers object degrades to "no signal" instead of crashing;
        // a real fetch Response always has one.
        const retryAfter = res.headers?.get('retry-after') ?? null;
        const remaining = res.headers?.get('x-ratelimit-remaining') ?? null;
        const isRateLimitStatus = res.status === 403 || res.status === 429;
        if (res.status === 429 || (isRateLimitStatus && (retryAfter !== null || remaining === '0'))) {
          // Retry-After is either delay-seconds or an HTTP-date (RFC 9110 section 10.2.3);
          // only the numeric form reads naturally with a unit appended.
          const retrySuffix =
            retryAfter === null
              ? ' Wait for the rate limit to reset.'
              : /^\d+$/.test(retryAfter)
                ? ` Retry after ${retryAfter}s.`
                : ` Retry after ${retryAfter}.`;
          throw new Error(`GitHub rate-limited this request (${res.status}).${retrySuffix}`);
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
