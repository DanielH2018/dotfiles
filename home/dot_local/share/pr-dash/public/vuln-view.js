// @ts-check

/** @typedef {import('../src/vulns.ts').VulnAlert} VulnAlert */
/** @typedef {import('../src/vulns.ts').Severity} Severity */
/** @typedef {'repo' | 'severity' | 'package'} VulnAxis */
/** @typedef {'severity' | 'age' | 'package'} VulnSort */
/** @typedef {'runtime' | 'development' | 'unknown'} ScopeFilter */
/** @typedef {'patched' | 'unpatched'} FixFilter */

// The pure half of the vulnerabilities page, kept out of vulns.js for the same reason
// render-guards.js is kept out of app.js: vulns.js touches `document` at module scope, so a
// Node test cannot import it.

/**
 * Severities from worst to least, the order every severity-ranked list on the page uses.
 * @type {readonly Severity[]}
 */
export const SEVERITIES = ['critical', 'high', 'moderate', 'low'];

/** @type {readonly VulnAxis[]} */
export const VULN_AXES = ['repo', 'severity', 'package'];

/** @type {readonly VulnSort[]} */
export const VULN_SORTS = ['severity', 'age', 'package'];

/**
 * @typedef {object} VulnsBody
 * @property {VulnAlert[]} alerts
 * @property {string[]} repos
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

/**
 * Checks one alert from the wire. Every field the page renders or sorts on is checked, since
 * a field that is the wrong type here surfaces as a row that throws mid-render.
 * @param {unknown} a
 * @returns {a is VulnAlert}
 */
function isAlert(a) {
  if (!isRecord(a)) return false;
  return (
    typeof a['repo'] === 'string' &&
    typeof a['number'] === 'number' &&
    typeof a['url'] === 'string' &&
    typeof a['severity'] === 'string' &&
    SEVERITIES.includes(/** @type {Severity} */ (a['severity'])) &&
    typeof a['ecosystem'] === 'string' &&
    typeof a['packageName'] === 'string' &&
    typeof a['manifestPath'] === 'string' &&
    (a['scope'] === 'runtime' || a['scope'] === 'development' || a['scope'] === null) &&
    typeof a['summary'] === 'string' &&
    typeof a['ghsaId'] === 'string' &&
    isStringArray(a['cveIds']) &&
    typeof a['advisoryUrl'] === 'string' &&
    typeof a['vulnerableRange'] === 'string' &&
    (typeof a['patchedVersion'] === 'string' || a['patchedVersion'] === null) &&
    typeof a['createdAt'] === 'string'
  );
}

/**
 * Validates a `/api/vulns` body, which tsc cannot check across the network.
 *
 * Throws when the envelope itself is malformed. A single malformed alert is dropped rather
 * than failing the page, and the returned `partialErrors` gains a line saying how many, so
 * the gap is still visible.
 * @param {unknown} body
 * @returns {VulnsBody}
 */
export function parseVulnsBody(body) {
  if (
    !isRecord(body) ||
    !Array.isArray(body['alerts']) ||
    !isStringArray(body['repos']) ||
    typeof body['fetchedAt'] !== 'string' ||
    !isStringArray(body['partialErrors']) ||
    typeof body['stale'] !== 'boolean' ||
    !(typeof body['error'] === 'string' || body['error'] === null)
  ) {
    throw new Error('the /api/vulns response did not have the expected shape');
  }
  const alerts = body['alerts'].filter(isAlert);
  const partialErrors = [.../** @type {string[]} */ (body['partialErrors'])];
  const dropped = body['alerts'].length - alerts.length;
  if (dropped > 0) partialErrors.push(`${dropped} alert(s) were malformed and are not shown`);
  return {
    alerts,
    repos: /** @type {string[]} */ (body['repos']),
    fetchedAt: body['fetchedAt'],
    partialErrors,
    stale: body['stale'],
    error: /** @type {string | null} */ (body['error']),
  };
}

/**
 * @typedef {object} VulnFilters
 * @property {Severity[]} severities
 * @property {ScopeFilter[]} scopes
 * @property {FixFilter[]} fixes
 */

/**
 * Keeps the alerts that pass every filter. Within one filter the checked values are ORed;
 * an empty list means that filter is off, as with the PR page's fieldsets.
 * @param {readonly VulnAlert[]} alerts
 * @param {VulnFilters} filters
 * @returns {VulnAlert[]}
 */
export function filterAlerts(alerts, filters) {
  return alerts.filter((a) => {
    if (filters.severities.length > 0 && !filters.severities.includes(a.severity)) return false;
    if (filters.scopes.length > 0 && !filters.scopes.includes(a.scope ?? 'unknown')) return false;
    const fix = a.patchedVersion === null ? 'unpatched' : 'patched';
    if (filters.fixes.length > 0 && !filters.fixes.includes(fix)) return false;
    return true;
  });
}

/** @param {Severity} s */
function rank(s) {
  return SEVERITIES.indexOf(s);
}

/**
 * Returns a sorted copy. `severity` puts the worst first and, within a level, the oldest
 * first, since the alert that has waited longest at a given severity is the one most overdue.
 * `age` is oldest first across levels; `package` is alphabetical by package name.
 * @param {readonly VulnAlert[]} alerts
 * @param {VulnSort} sort
 * @returns {VulnAlert[]}
 */
export function sortAlerts(alerts, sort) {
  const byAge = (/** @type {VulnAlert} */ a, /** @type {VulnAlert} */ b) =>
    a.createdAt.localeCompare(b.createdAt);
  const copy = [...alerts];
  if (sort === 'age') return copy.sort(byAge);
  if (sort === 'package') {
    return copy.sort(
      (a, b) => a.packageName.localeCompare(b.packageName) || rank(a.severity) - rank(b.severity),
    );
  }
  return copy.sort((a, b) => rank(a.severity) - rank(b.severity) || byAge(a, b));
}

/**
 * @param {readonly VulnAlert[]} alerts
 * @returns {Record<Severity, number>}
 */
export function severityCounts(alerts) {
  /** @type {Record<Severity, number>} */
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const a of alerts) counts[a.severity] += 1;
  return counts;
}

/**
 * @typedef {object} VulnGroup
 * @property {string} key
 * @property {string} label
 * @property {VulnAlert[]} alerts
 */

/**
 * Groups `alerts` along `axis`. Severity groups run worst first. Repository and package
 * groups run by their worst alert, then by how many alerts they hold, so the group that needs
 * attention first is at the top; ties fall back to the label. Empty groups are omitted.
 * @param {readonly VulnAlert[]} alerts
 * @param {VulnAxis} axis
 * @returns {VulnGroup[]}
 */
export function groupAlerts(alerts, axis) {
  /** @type {Map<string, VulnGroup>} */
  const groups = new Map();
  for (const a of alerts) {
    const key =
      axis === 'repo' ? a.repo : axis === 'severity' ? a.severity : `${a.ecosystem}/${a.packageName}`;
    const label = axis === 'package' ? `${a.packageName} (${a.ecosystem})` : key;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, label, alerts: [] };
      groups.set(key, group);
    }
    group.alerts.push(a);
  }
  const list = [...groups.values()];
  if (axis === 'severity') {
    return list.sort((a, b) => rank(/** @type {Severity} */ (a.key)) - rank(/** @type {Severity} */ (b.key)));
  }
  const worst = (/** @type {VulnGroup} */ g) => Math.min(...g.alerts.map((a) => rank(a.severity)));
  return list.sort(
    (a, b) => worst(a) - worst(b) || b.alerts.length - a.alerts.length || a.label.localeCompare(b.label),
  );
}

/**
 * The configured repositories with no open alert at all, before any filter. Listed on the
 * page so a repository with nothing to show is visibly checked rather than silently absent.
 * @param {readonly string[]} repos
 * @param {readonly VulnAlert[]} alerts
 * @returns {string[]}
 */
export function cleanRepos(repos, alerts) {
  const withAlerts = new Set(alerts.map((a) => a.repo));
  return repos.filter((r) => !withAlerts.has(r));
}

/**
 * Whole days since `createdAt`, never negative.
 * @param {string} createdAt
 * @param {number} now
 * @returns {number}
 */
export function ageDays(createdAt, now) {
  const ms = now - Date.parse(createdAt);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}

/**
 * The banner text for a successful response, or `null` for none. A stale body names the
 * failed refresh; a partial one names what is missing. Both can apply at once.
 * @param {Pick<VulnsBody, 'stale' | 'error' | 'partialErrors' | 'fetchedAt'>} body
 * @returns {string | null}
 */
export function vulnsBanner(body) {
  const parts = [];
  if (body.stale) {
    parts.push(
      `Showing alerts fetched ${body.fetchedAt}; the refresh failed: ${body.error ?? 'unknown error'}.`,
    );
  }
  if (body.partialErrors.length > 0) parts.push(`Some alerts are missing: ${body.partialErrors.join('; ')}`);
  return parts.length > 0 ? parts.join(' ') : null;
}
