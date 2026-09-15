export type GuardResult = { ok: true } | { ok: false; reason: string };

type Headers = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// 'localhost' and '127.0.0.1' name the same loopback interface, so the launcher's expected
// host and an incoming Host/Origin header must compare equal under either spelling. The
// mapping is a literal, whole-label rewrite — 'localhost' or 'localhost:<port>' only — never
// a prefix or suffix match, so 'localhost.evil.com' or 'notlocalhost:8770' are left untouched
// and still fail comparison against a loopback expectation. Nothing else is normalized: no
// case-folding, no other hostname is treated as an alias of anything.
function canonicalHost(h: string): string {
  if (h === 'localhost') return '127.0.0.1';
  if (h.startsWith('localhost:')) return `127.0.0.1${h.slice('localhost'.length)}`;
  return h;
}

// Matches exactly `http://<host>` with nothing else — no path, no query, no trailing slash,
// no uppercase scheme. A real browser's Origin header is always this exact shape (scheme and
// host only, lowercase, no path); anything else is either a forgery or malformed, and both
// are refused rather than parsed leniently. `[^/]+` also means a userinfo trick like
// `http://127.0.0.1:8770@evil.com` is captured whole and compared as one opaque string, so it
// can never equal the clean expected host without needing dedicated handling.
const ORIGIN_PATTERN = /^http:\/\/([^/]+)$/;

function originHost(origin: string): string | undefined {
  return ORIGIN_PATTERN.exec(origin)?.[1];
}

/**
 * The DNS-rebinding half of the guard: `Host` must be the host the launcher bound to, and
 * `Origin`, when present, must name that same host. Separate from {@link checkSecret}
 * because the server applies this half to *every* request — a mismatched `Host` must not be
 * served the page shell or `app.js` either — while the secret applies only to `/api/prs`.
 * The browser cannot attach a custom header to the address-bar navigation that loads the
 * shell, so requiring the secret there would stop the dashboard loading at all.
 *
 * An absent `Host` is refused rather than defaulted: HTTP/1.1 requires it, there is nothing
 * to compare without it, and the server has no other host to fall back to.
 */
export function checkHost(headers: Headers, expected: { host: string }): GuardResult {
  const host = one(headers['host']);
  if (host === undefined || host === '' || canonicalHost(host) !== canonicalHost(expected.host)) {
    return { ok: false, reason: `unexpected Host: ${String(host)}` };
  }

  // Same-origin navigations and plain GETs omit Origin entirely, so refusing an absent
  // header here would break the page itself. That means Origin is not what authenticates
  // these requests — the per-launch secret is — and this check exists only to reject a
  // *present* cross-origin (or otherwise invalid) Origin, not to require one.
  const origin = one(headers['origin']);
  if (origin !== undefined) {
    const originAuthority = originHost(origin);
    if (originAuthority === undefined || canonicalHost(originAuthority) !== canonicalHost(expected.host)) {
      return { ok: false, reason: `cross-origin request from ${origin}` };
    }
  }

  return { ok: true };
}

/**
 * The per-launch secret half of the guard, which applies to `/api/prs` alone. The secret is
 * what actually authenticates an API request, since `Origin` is optional and `Host` only
 * rules out rebinding.
 *
 * This deliberately does *not* re-check the host. It used to, and that check was
 * unreachable: the server calls {@link checkHost} on every request before dispatching a
 * route, so by the time this runs a mismatched host has already been refused. A second
 * check that can never disagree with the first is one nothing can test through the server —
 * swapping its expectation for the request's own `Host` header, the very defect that left
 * this dashboard with no rebinding defence, left the whole suite green. Host defence now
 * lives in exactly one place, so there is no second copy to rot.
 */
export function checkSecret(headers: Headers, expected: { secret: string }): GuardResult {
  const secret = one(headers['x-pr-dash-secret']);
  if (secret !== expected.secret) {
    return { ok: false, reason: 'missing or incorrect secret' };
  }

  return { ok: true };
}
