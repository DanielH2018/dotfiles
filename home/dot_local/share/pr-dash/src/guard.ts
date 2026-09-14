export type GuardResult = { ok: true } | { ok: false; reason: string };

export type Expected = { host: string; secret: string };

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

export function checkRequest(headers: Headers, expected: Expected): GuardResult {
  const host = one(headers['host']);
  if (host === undefined || canonicalHost(host) !== canonicalHost(expected.host)) {
    return { ok: false, reason: `unexpected Host: ${String(host)}` };
  }

  // Same-origin navigations and plain GETs omit Origin entirely, so refusing an absent
  // header here would break the page itself. That means Origin is not what authenticates
  // these requests — the per-launch secret checked below is — and this check exists only
  // to reject a *present* cross-origin (or otherwise invalid) Origin, not to require one.
  const origin = one(headers['origin']);
  if (origin !== undefined) {
    const originAuthority = originHost(origin);
    if (originAuthority === undefined || canonicalHost(originAuthority) !== canonicalHost(expected.host)) {
      return { ok: false, reason: `cross-origin request from ${origin}` };
    }
  }

  const secret = one(headers['x-pr-dash-secret']);
  if (secret !== expected.secret) {
    return { ok: false, reason: 'missing or incorrect secret' };
  }

  return { ok: true };
}
