// @ts-check
/** @typedef {import('../src/types.ts').PrRecord} PrRecord */
/** @typedef {'repo' | 'ci' | 'review' | 'staleness' | 'draft'} Axis */
/** @typedef {'stale' | 'age' | 'title' | 'size'} Sort */

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
  return [...buckets.entries()]
    .map(([key, rs]) => ({ key, records: rs }))
    .sort((a, b) => a.key.localeCompare(b.key));
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
