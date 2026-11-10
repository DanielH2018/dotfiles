// @ts-check
import { CI_VALUES } from './render-guards.js';
import { SEVERITIES, severityCounts } from './vuln-view.js';

/** @typedef {import('../src/repos.ts').RepoRow} RepoRow */
/** @typedef {import('../src/vulns.ts').Severity} Severity */
/** @typedef {import('./vuln-view.js').VulnsBody} VulnsBody */

// The pure half of the repositories page, kept out of repos.js because repos.js touches
// `document` at module scope and a Node test cannot import it.

/**
 * @typedef {object} ReposBody
 * @property {RepoRow[]} rows
 * @property {string} fetchedAt
 * @property {string[]} partialErrors
 * @property {boolean} stale
 * @property {string | null} error
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isRecord(v) {
  return typeof v === 'object' && v !== null;
}

/** @param {unknown} v */
function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** @param {unknown} v */
function isStringOrNull(v) {
  return typeof v === 'string' || v === null;
}

/** @param {unknown} b */
function isBranch(b) {
  return (
    b === null ||
    (isRecord(b) &&
      typeof b['name'] === 'string' &&
      CI_VALUES.includes(/** @type {never} */ (b['ci'])) &&
      typeof b['commitUrl'] === 'string' &&
      typeof b['headline'] === 'string' &&
      typeof b['committedAt'] === 'string' &&
      typeof b['author'] === 'string')
  );
}

/** @param {unknown} p */
function isPrSummary(p) {
  return (
    p === null ||
    (isRecord(p) &&
      Number.isInteger(p['open']) &&
      Number.isInteger(p['drafts']) &&
      Number.isInteger(p['awaitingReview']) &&
      isStringOrNull(p['oldestOpenedAt']) &&
      typeof p['url'] === 'string')
  );
}

/**
 * A row is usable when it is either a loaded repository (no error, PR summary present) or a
 * failed one (error set, nothing else). Anything in between would render as a quiet repo.
 * @param {unknown} r
 * @returns {r is RepoRow}
 */
function isRow(r) {
  if (!isRecord(r) || typeof r['repo'] !== 'string' || !isStringOrNull(r['url'])) return false;
  if (!isBranch(r['branch']) || !isPrSummary(r['prs']) || !isStringOrNull(r['error'])) return false;
  return r['error'] === null ? r['prs'] !== null : r['prs'] === null && r['branch'] === null;
}

/**
 * Validates a `/api/repos` body. Throws on a malformed envelope; drops a malformed row and
 * says how many in `partialErrors`, as parseVulnsBody does for alerts.
 * @param {unknown} body
 * @returns {ReposBody}
 */
export function parseReposBody(body) {
  if (
    !isRecord(body) ||
    !Array.isArray(body['rows']) ||
    typeof body['fetchedAt'] !== 'string' ||
    !isStringArray(body['partialErrors']) ||
    typeof body['stale'] !== 'boolean' ||
    !isStringOrNull(body['error'])
  ) {
    throw new Error('the /api/repos response did not have the expected shape');
  }
  const rows = body['rows'].filter(isRow);
  const partialErrors = [.../** @type {string[]} */ (body['partialErrors'])];
  const dropped = body['rows'].length - rows.length;
  if (dropped > 0) partialErrors.push(`${dropped} malformed repositor${dropped === 1 ? 'y is' : 'ies are'} not shown`);
  return {
    rows,
    fetchedAt: body['fetchedAt'],
    partialErrors,
    stale: body['stale'],
    error: /** @type {string | null} */ (body['error']),
  };
}

/**
 * @typedef {object} VulnStatus
 * @property {Record<Severity, number> | null} counts `null` when the count is unknown.
 * @property {'unavailable' | 'incomplete' | 'out of date' | null} caveat
 */

/**
 * One repository's open-alert counts from the `/api/vulns` body, with how far to trust them.
 *
 * An unknown count is never reported as zero: a repository the vulnerabilities load failed
 * for, or that it never covered, is `unavailable`, not clean. That is the false "clean" the
 * vulnerabilities page's own zero-drop guard exists to prevent.
 * @param {string} repo
 * @param {VulnsBody | null} vulns `null` when `/api/vulns` could not be read at all.
 * @returns {VulnStatus}
 */
export function vulnStatus(repo, vulns) {
  if (vulns === null || !vulns.repos.includes(repo)) return { counts: null, caveat: 'unavailable' };
  const counts = severityCounts(vulns.alerts.filter((a) => a.repo === repo));
  if (vulns.staleRepos.includes(repo) || vulns.stale) return { counts, caveat: 'out of date' };
  if (vulns.partialErrors.some((e) => e.startsWith(`${repo}: `))) {
    const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
    return total === 0 ? { counts: null, caveat: 'unavailable' } : { counts, caveat: 'incomplete' };
  }
  return { counts, caveat: null };
}

/**
 * The banner for a successful `/api/repos` body, or `null` for none. `vulnsError` is why
 * `/api/vulns` could not be read, when it could not.
 * @param {Pick<ReposBody, 'stale' | 'error' | 'partialErrors' | 'fetchedAt'>} body
 * @param {string | null} vulnsError
 * @returns {string | null}
 */
export function reposBanner(body, vulnsError) {
  const parts = [];
  if (body.stale) {
    parts.push(`Showing repositories fetched ${body.fetchedAt}; the refresh failed: ${body.error ?? 'unknown error'}.`);
  }
  if (body.partialErrors.length > 0) parts.push(`Some counts are incomplete: ${body.partialErrors.join('; ')}`);
  if (vulnsError !== null) parts.push(`Vulnerability counts are unavailable: ${vulnsError}`);
  return parts.length > 0 ? parts.join(' ') : null;
}
