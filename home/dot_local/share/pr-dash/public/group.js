// @ts-check
/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {'repo' | 'ci' | 'review' | 'staleness' | 'draft'} Axis */
/** @typedef {'stale' | 'age' | 'title' | 'size'} Sort */

/**
 * Declares the display order for every axis except `repo`, most actionable
 * first. `repo` has no fixed set of values, so it sorts alphabetically
 * instead and has no entry here.
 * @type {{ [K in Exclude<Axis, 'repo'>]: readonly string[] }}
 */
const GROUP_ORDER = {
  staleness: ['<1d', '1-3d', '3-7d', '>7d'],
  ci: ['failure', 'pending', 'none', 'success'],
  review: ['changes_requested', 'review_required', 'none', 'approved'],
  draft: ['ready', 'draft'],
};

/**
 * @param {number} staleDays
 * @returns {string}
 */
export function stalenessBucket(staleDays) {
  if (staleDays < 1) return '<1d';
  if (staleDays <= 3) return '1-3d';
  if (staleDays <= 7) return '3-7d';
  return '>7d';
}

/**
 * @param {PrRecord} pr
 * @param {Axis} axis
 * @returns {string}
 */
function keyFor(pr, axis) {
  switch (axis) {
    case 'repo': return pr.repo;
    case 'ci': return pr.ci;
    case 'review': return pr.review;
    case 'staleness': return stalenessBucket(pr.staleDays);
    case 'draft': return pr.isDraft ? 'draft' : 'ready';
  }
}

/**
 * Ranks a group key within its axis's declared order. A key absent from
 * that order (data the axis's type doesn't admit) sorts last rather than
 * throwing.
 * @param {Exclude<Axis, 'repo'>} axis
 * @param {string} key
 * @returns {number}
 */
function groupRank(axis, key) {
  const order = GROUP_ORDER[axis];
  const index = order.indexOf(key);
  return index === -1 ? order.length : index;
}

/**
 * @param {readonly PrRecord[]} records
 * @param {Axis} axis
 * @returns {{ key: string, records: PrRecord[] }[]}
 */
export function groupBy(records, axis) {
  /** @type {Map<string, PrRecord[]>} */
  const buckets = new Map();
  for (const pr of records) {
    const key = keyFor(pr, axis);
    const existing = buckets.get(key);
    if (existing === undefined) buckets.set(key, [pr]);
    else existing.push(pr);
  }
  const groups = [...buckets.entries()].map(([key, rs]) => ({ key, records: rs }));
  if (axis === 'repo') return groups.sort((a, b) => a.key.localeCompare(b.key));
  return groups.sort((a, b) => groupRank(axis, a.key) - groupRank(axis, b.key));
}

/**
 * @typedef {object} Filters
 * @property {import('../src/types.ts').Ci[]} ci
 * @property {import('../src/types.ts').Review[]} review
 * @property {('draft'|'ready')[]} draft
 */

/**
 * Keeps the records matching every axis's constraint (AND across `ci`,
 * `review` and `draft`), where any one axis matches a record if the
 * record's value is among that axis's list (OR within the axis). An empty
 * list for an axis is not a "match nothing" filter — it means the axis
 * imposes no constraint at all, so the default all-unchecked state shows
 * every record.
 * @param {readonly PrRecord[]} records
 * @param {Filters} filters
 * @returns {PrRecord[]}
 */
export function applyFilters(records, filters) {
  return records.filter((pr) => {
    if (filters.ci.length > 0 && !filters.ci.includes(pr.ci)) return false;
    if (filters.review.length > 0 && !filters.review.includes(pr.review)) return false;
    if (filters.draft.length > 0 && !filters.draft.includes(pr.isDraft ? 'draft' : 'ready')) return false;
    return true;
  });
}

/**
 * @param {readonly PrRecord[]} records
 * @param {Sort} sort
 * @returns {PrRecord[]}
 */
export function sortWithin(records, sort) {
  const copy = [...records];
  switch (sort) {
    case 'stale': return copy.sort((a, b) => b.staleDays - a.staleDays);
    case 'age': return copy.sort((a, b) => b.ageDays - a.ageDays);
    case 'title': return copy.sort((a, b) => a.title.localeCompare(b.title));
    case 'size':
      return copy.sort(
        (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions),
      );
  }
}
