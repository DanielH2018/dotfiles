import type { Client, QueryResult } from './github.ts';
import type { Cache } from './cache.ts';
import { FORCE_MIN_INTERVAL_MS } from './main-lib.ts';

// The open Dependabot alerts on a fixed list of repositories, for the vulnerabilities page.
// Kept apart from the PR loader: the PR list comes from one search over the operator's own
// PRs, while this is one query per configured repository, and a repository the token cannot
// read must cost that repository's rows and nothing else.

export type Severity = 'critical' | 'high' | 'moderate' | 'low';

/** One open alert, flattened to what the page renders. */
export type VulnAlert = {
  /** `owner/name`, as configured. */
  repo: string;
  number: number;
  /** The alert's own page in the repository's Security tab. */
  url: string;
  severity: Severity;
  ecosystem: string;
  packageName: string;
  manifestPath: string;
  /** `runtime` or `development`; `null` when GitHub could not tell. */
  scope: 'runtime' | 'development' | null;
  summary: string;
  ghsaId: string;
  cveIds: string[];
  advisoryUrl: string;
  vulnerableRange: string;
  /** `null` when no patched release exists yet, which the page shows as such. */
  patchedVersion: string | null;
  createdAt: string;
};

export type VulnRepo = { owner: string; name: string };

export type ParsedVulnRepos = { ok: true; repos: VulnRepo[] } | { ok: false; reason: string };

// GitHub's own character sets: an owner is alphanumerics and single hyphens, a repository
// name adds `.` and `_`. The check is a typo guard, not an injection guard — both parts reach
// GitHub only as GraphQL variables, never spliced into the operation text.
const REPO_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

/**
 * Reads the repositories the vulnerabilities page covers from a raw `PR_DASH_VULN_REPOS`
 * value: a comma-separated list of `owner/name`, such as `acme/api,acme/web`.
 *
 * Unset, empty, or all-whitespace yields an empty list, and the page then says no
 * repositories are configured. The list lives in the environment rather than in this repo for
 * the same reason as `PR_DASH_WORK_ORGS`: the repo is public-posture, and the names are an
 * employer's private repository inventory. A malformed entry rejects the whole value, naming
 * the variable and the entry, so the caller can refuse to start rather than silently drop a
 * repository from a security view.
 */
export function parseVulnRepos(raw: string | undefined): ParsedVulnRepos {
  if (raw === undefined) return { ok: true, repos: [] };
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const repos: VulnRepo[] = [];
  for (const entry of entries) {
    const match = REPO_PATTERN.exec(entry);
    if (match === null) {
      return {
        ok: false,
        reason: `PR_DASH_VULN_REPOS entries must each be owner/name, but one is "${entry}".`,
      };
    }
    repos.push({ owner: match[1] ?? '', name: match[2] ?? '' });
  }
  return { ok: true, repos };
}

const ALERTS = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    url
    vulnerabilityAlerts(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt vulnerableManifestPath dependencyScope
        securityAdvisory { ghsaId summary permalink identifiers { type value } }
        securityVulnerability {
          severity vulnerableVersionRange
          firstPatchedVersion { identifier }
          package { ecosystem name }
        }
      }
    }
  }
}`;

// Every level is nullable for the same reason as SearchData in queries.ts: a partial
// response nulls exactly the field that failed and still answers 200.
export type RawAlert = {
  number: number;
  createdAt: string;
  vulnerableManifestPath: string;
  dependencyScope: string | null;
  securityAdvisory: {
    ghsaId: string;
    summary: string;
    permalink: string | null;
    identifiers: { type: string; value: string }[];
  } | null;
  securityVulnerability: {
    severity: string;
    vulnerableVersionRange: string;
    firstPatchedVersion: { identifier: string } | null;
    package: { ecosystem: string; name: string };
  } | null;
};

type AlertsData = {
  repository: {
    url: string;
    vulnerabilityAlerts: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null } | null | undefined;
      nodes: (RawAlert | null)[];
    } | null;
  } | null;
};

// Bounds a server that keeps reporting hasNextPage, as MAX_PAGES does in queries.ts. A
// repository with ten thousand open alerts has a problem this page cannot help with.
const MAX_PAGES = 100;

const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'moderate', 'low']);

/**
 * Flattens one raw alert. Returns `null` for a node too damaged to place on the page — no
 * advisory or no vulnerability — and the caller counts those as a partial result.
 */
export function normalizeAlert(raw: RawAlert, repo: string, repoUrl: string): VulnAlert | null {
  const advisory = raw.securityAdvisory;
  const vuln = raw.securityVulnerability;
  if (advisory === null || vuln === null) return null;
  const severity = vuln.severity.toLowerCase();
  const scope = raw.dependencyScope?.toLowerCase();
  return {
    repo,
    number: raw.number,
    url: `${repoUrl}/security/dependabot/${raw.number}`,
    // An unknown level is filed under `low` rather than dropped: the row still exists, and
    // a security view that hides rows it cannot classify is worse than one that under-ranks.
    severity: SEVERITIES.has(severity) ? (severity as Severity) : 'low',
    ecosystem: vuln.package.ecosystem.toLowerCase(),
    packageName: vuln.package.name,
    manifestPath: raw.vulnerableManifestPath,
    scope: scope === 'runtime' || scope === 'development' ? scope : null,
    summary: advisory.summary,
    ghsaId: advisory.ghsaId,
    cveIds: advisory.identifiers.filter((i) => i.type === 'CVE').map((i) => i.value),
    advisoryUrl: advisory.permalink ?? `https://github.com/advisories/${advisory.ghsaId}`,
    vulnerableRange: vuln.vulnerableVersionRange,
    patchedVersion: vuln.firstPatchedVersion?.identifier ?? null,
    createdAt: raw.createdAt,
  };
}

export type RepoAlerts = { alerts: VulnAlert[]; errors: string[] };

/**
 * Every open alert on one repository, to the end of its pagination.
 *
 * Throws when the repository answered nothing usable: not found, or no access to its alerts,
 * which GitHub reports as a null `vulnerabilityAlerts` with an error beside it. Returns a
 * partial result, with `errors` naming the gap, when some rows did arrive.
 */
export async function fetchRepoAlerts(client: Client, repo: VulnRepo): Promise<RepoAlerts> {
  const label = `${repo.owner}/${repo.name}`;
  const alerts: VulnAlert[] = [];
  const errors: string[] = [];
  let dropped = 0;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const variables: Record<string, unknown> = { owner: repo.owner, name: repo.name, cursor };
    const response: QueryResult<AlertsData> = await client.query<AlertsData>(ALERTS, variables);
    for (const e of response.errors) if (!errors.includes(e)) errors.push(e);

    const repository = response.data.repository;
    const connection = repository?.vulnerabilityAlerts;
    if (repository === null || connection === null || connection === undefined) {
      // Nothing from this page. On the first page that is the whole repository, so it is a
      // failure; later, the rows already collected stand and the gap is reported.
      if (page === 0) {
        throw new Error(errors.length > 0 ? errors.join('; ') : 'no alert data returned');
      }
      errors.push('pagination stopped early');
      break;
    }

    for (const node of connection.nodes) {
      const alert = node === null ? null : normalizeAlert(node, label, repository.url);
      if (alert === null) dropped += 1;
      else alerts.push(alert);
    }

    const info: { hasNextPage: boolean; endCursor: string | null } | null | undefined = connection.pageInfo;
    if (info === null || info === undefined || !info.hasNextPage) break;
    if (info.endCursor === null || info.endCursor === cursor) {
      errors.push('pagination stopped early');
      break;
    }
    cursor = info.endCursor;
  }

  if (dropped > 0) errors.push(`${dropped} alert(s) arrived without advisory details`);
  return { alerts, errors };
}

/**
 * One complete answer for the page. `partialErrors` is empty when every configured repository
 * answered in full; otherwise each entry is prefixed with the repository it concerns.
 */
export type VulnLoadResult = {
  alerts: VulnAlert[];
  repos: string[];
  fetchedAt: string;
  partialErrors: string[];
};

/**
 * What the route serves: a load result, plus whether it is a retained payload behind a failed
 * refresh (`stale`, with `error` saying why) — the same split `withFallback` makes for PRs.
 */
export type VulnResponse = VulnLoadResult & { stale: boolean; error?: string };

export type VulnLoaderOpts = {
  /** Injectable for the force throttle, as in `withFallback`. Defaults to `Date.now`. */
  now?: () => number;
};

export type LoadVulns = (opts?: { force?: boolean }) => Promise<VulnResponse>;

/**
 * The `loadVulns` the server calls on every `/api/vulns`.
 *
 * Joins an in-flight fetch rather than starting a second one, serves from `cache` until its
 * TTL lapses, and lets `force` bypass the cache at most once per {@link FORCE_MIN_INTERVAL_MS}.
 * Repositories are queried in parallel and fail independently. Only when every one of them
 * fails does the load fail, and then the last good result is served marked stale; with
 * nothing to fall back on, the failure propagates.
 *
 * With no repositories configured there is nothing to query, so it answers an empty result
 * and a machine that never set the list never resolves a token on this route's account.
 */
export function createVulnLoader(
  client: Client,
  repos: readonly VulnRepo[],
  cache: Cache<VulnLoadResult>,
  opts: VulnLoaderOpts = {},
): LoadVulns {
  const now = opts.now ?? Date.now;
  const labels = repos.map((r) => `${r.owner}/${r.name}`);
  let inFlight: Promise<VulnLoadResult> | undefined;
  let lastGood: VulnLoadResult | undefined;
  let lastForcedAt: number | undefined;

  async function fetchAll(): Promise<VulnLoadResult> {
    const settled = await Promise.allSettled(repos.map((r) => fetchRepoAlerts(client, r)));
    const alerts: VulnAlert[] = [];
    const partialErrors: string[] = [];
    let failed = 0;
    settled.forEach((outcome, i) => {
      const label = labels[i] ?? '';
      if (outcome.status === 'fulfilled') {
        alerts.push(...outcome.value.alerts);
        partialErrors.push(...outcome.value.errors.map((e) => `${label}: ${e}`));
      } else {
        failed += 1;
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        partialErrors.push(`${label}: ${reason}`);
      }
    });
    if (repos.length > 0 && failed === repos.length) {
      // Every repository failing is almost always one cause — the token, the network, a rate
      // limit — so the distinct reasons are what the banner needs, not one line per repo.
      throw new Error([...new Set(partialErrors.map((e) => e.slice(e.indexOf(': ') + 2)))].join('; '));
    }
    return { alerts, repos: labels, fetchedAt: new Date(now()).toISOString(), partialErrors };
  }

  return async function loadVulns(loadOpts = {}): Promise<VulnResponse> {
    if (inFlight === undefined) {
      if (loadOpts.force === true) {
        const at = now();
        if (lastForcedAt === undefined || at - lastForcedAt >= FORCE_MIN_INTERVAL_MS) {
          lastForcedAt = at;
          cache.invalidate();
        }
      }
      const hit = cache.get();
      if (hit !== undefined) return { ...hit, stale: false };
      inFlight = fetchAll();
    }
    const pending = inFlight;
    try {
      const result = await pending;
      cache.set(result);
      lastGood = result;
      return { ...result, stale: false };
    } catch (err) {
      if (lastGood === undefined) throw err;
      return { ...lastGood, stale: true, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Cleared on rejection too, so one transient failure does not answer every later call.
      if (inFlight === pending) inFlight = undefined;
    }
  };
}
