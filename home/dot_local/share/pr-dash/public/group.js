// @ts-check
/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {import('../src/types.ts').StackNode} StackNode */
/** @typedef {'repo' | 'ci' | 'review' | 'staleness' | 'draft'} Axis */
/** @typedef {'stale' | 'age' | 'title' | 'size'} Sort */
/** @typedef {'<1d' | '1-3d' | '3-7d' | '>7d'} StalenessBucket */
/** @typedef {'draft' | 'ready'} DraftState */

/**
 * Every bucket {@link stalenessBucket} can return, in display order. The one
 * definition of the set: it is the `staleness` grouping order, the staleness
 * filter's allowed values, and `stalenessBucket`'s own return type, so a bucket
 * renamed in one place cannot keep matching in another. Typed
 * `readonly StalenessBucket[]`, not `readonly string[]`, so a member outside the
 * union fails `tsc` at the declaration.
 * @type {readonly StalenessBucket[]}
 */
export const STALENESS_BUCKETS = ['<1d', '1-3d', '3-7d', '>7d'];

/**
 * Both draft states, ready first. Same role as {@link STALENESS_BUCKETS} for the
 * `draft` axis, and typed against its union for the same reason.
 * @type {readonly DraftState[]}
 */
export const DRAFT_STATES = ['ready', 'draft'];

/**
 * Declares the display order for every axis except `repo`, most actionable
 * first. `repo` has no fixed set of values, so it sorts alphabetically
 * instead and has no entry here.
 * @type {{ [K in Exclude<Axis, 'repo'>]: readonly string[] }}
 */
const GROUP_ORDER = {
  staleness: STALENESS_BUCKETS,
  ci: ['failure', 'pending', 'none', 'success'],
  review: ['changes_requested', 'review_required', 'none', 'approved'],
  draft: DRAFT_STATES,
};

/**
 * The staleness bucket `staleDays` falls in. The return type is the union rather
 * than `string`: it is what makes a mismatch between these thresholds and
 * {@link STALENESS_BUCKETS} a `tsc` error instead of a filter that silently
 * matches nothing.
 * @param {number} staleDays
 * @returns {StalenessBucket}
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
 * @property {DraftState[]} draft
 * @property {StalenessBucket[]} staleness
 */

/**
 * Keeps the records matching every axis's constraint (AND across `ci`,
 * `review`, `draft` and `staleness`), where any one axis matches a record if
 * the record's value is among that axis's list (OR within the axis). An empty
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
    // Reuses stalenessBucket rather than comparing staleDays against thresholds of its
    // own, so the filter and the staleness grouping can never disagree about which
    // bucket a PR is in.
    if (filters.staleness.length > 0 && !filters.staleness.includes(stalenessBucket(pr.staleDays))) {
      return false;
    }
    return true;
  });
}

/**
 * The comparator for one sort setting, shared by {@link sortWithin} and
 * {@link sortStackRoots} so the flat row list and the stack roots can never
 * disagree about what "sorted by age" means. The switch stays exhaustive over
 * `Sort` with no default branch, so adding a sort fails `tsc` here.
 * @param {Sort} sort
 * @returns {(a: PrRecord, b: PrRecord) => number}
 */
function comparatorFor(sort) {
  switch (sort) {
    case 'stale': return (a, b) => b.staleDays - a.staleDays;
    case 'age': return (a, b) => b.ageDays - a.ageDays;
    case 'title': return (a, b) => a.title.localeCompare(b.title);
    case 'size': return (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions);
  }
}

/**
 * @param {readonly PrRecord[]} records
 * @param {Sort} sort
 * @returns {PrRecord[]}
 */
export function sortWithin(records, sort) {
  return [...records].sort(comparatorFor(sort));
}

/**
 * Orders stack roots by `sort`, comparing each root's own PR.
 *
 * Only the roots move. A stack's children stay in stack order, because that order is
 * the stack's meaning — each child bases on the one above it — and re-sorting them by
 * staleness would render a stack that does not exist. This is what makes the Sort
 * control work under the repo grouping without breaking the nesting.
 * @param {readonly StackNode[]} roots
 * @param {Sort} sort
 * @returns {StackNode[]}
 */
export function sortStackRoots(roots, sort) {
  const compare = comparatorFor(sort);
  return [...roots].sort((a, b) => compare(a.pr, b.pr));
}
