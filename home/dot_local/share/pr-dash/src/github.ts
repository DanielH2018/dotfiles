export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type ClientOpts = { token: string; fetchImpl?: FetchImpl };

// GraphQL can answer one request with both data and errors, so a query result carries
// both rather than being either/or. `errors` is empty on a complete response; a caller
// with a non-empty `errors` holds a partial result and must say so, not treat `data` as
// the whole picture.
export type QueryResult<T> = { data: T; errors: string[] };

export type Client = {
  query<T>(query: string, variables: Record<string, unknown>): Promise<QueryResult<T>>;
};

const ENDPOINT = 'https://api.github.com/graphql';

// How much of an upstream response body an error message quotes. GitHub's own GraphQL
// errors are a sentence or two, but an intermediary can answer with an HTML page or a long
// proxy diagnostic, and this message is what the browser banner shows.
const MAX_BODY_CHARS = 300;

/**
 * Shortens `body` to something a one-line banner can hold, marking it when anything was
 * dropped so a reader can tell a short upstream message from a clipped one.
 */
function quoteBody(body: string): string {
  return body.length <= MAX_BODY_CHARS
    ? body
    : `${body.slice(0, MAX_BODY_CHARS)}… (truncated, ${body.length} chars)`;
}

export function createClient(opts: ClientOpts): Client {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async query<T>(query: string, variables: Record<string, unknown>): Promise<QueryResult<T>> {
      const res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });

      // A 401 means the token itself is bad, not that the network or the query is — name
      // the renewal step rather than a generic failure.
      //
      // The item reference is deliberately NOT named here. This message travels to the
      // client: it reaches the banner through a 200 /api/prs body carrying a retained
      // payload, and through server.ts's 500 path. The literal `op://...` path is not the
      // secret, but it does state where the credential lives, and an operator does not need
      // it here — token.ts prints the exact `op read` command at startup, which is the point
      // where someone is actually about to renew the token.
      if (res.status === 401) {
        throw new Error(
          'GitHub rejected the token (401): it is expired or revoked. Renew the token in ' +
            'its 1Password item and restart pr-dash.',
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
        //
        // Scoping both header signals to 403 is also what makes the order of this check
        // and the 401 above irrelevant: a 401 carrying either header still reports as an
        // expired token, whichever check runs first, so nothing here rests on that order.
        //
        // `headers.get` returns '' for a present-but-empty header, which is not null, so an
        // empty Retry-After used to enter this branch and then fail the digit test below,
        // rendering the sentence "Retry after ." An empty header is no signal.
        const retryAfterHeader = res.headers?.get('retry-after') ?? null;
        const retryAfter = retryAfterHeader === '' ? null : retryAfterHeader;
        const remaining = res.headers?.get('x-ratelimit-remaining') ?? null;
        if (res.status === 429 || (res.status === 403 && (retryAfter !== null || remaining === '0'))) {
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
        throw new Error(`GitHub returned ${res.status}: ${quoteBody(await res.text())}`);
      }

      const body = (await res.json()) as { data?: T | null; errors?: { message: string }[] };
      const errors = (body.errors ?? []).map((e) => String(e?.message ?? e));

      // GraphQL returns HTTP 200 even when the query failed server-side, and a query that
      // failed outright still carries `data: null`. Both are failures: an empty result
      // returned as success would read as "you have no open PRs" instead of the actual
      // rate-limit or query error. A response carrying `data` *and* `errors` is neither —
      // GitHub nulls the field that timed out and reports it here — so it returns both and
      // the caller decides how much of `data` is usable.
      if (body.data === undefined || body.data === null) {
        throw new Error(
          errors.length > 0
            ? `GraphQL error: ${errors.join('; ')}`
            : 'GraphQL response contained no data',
        );
      }
      return { data: body.data, errors };
    },
  };
}
