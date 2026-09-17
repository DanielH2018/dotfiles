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
 * The owner segment of a `owner/name` repository string, lowercased. GitHub owner names are
 * case-insensitive, and `nameWithOwner` preserves whatever casing the owner registered, so
 * both sides of every comparison go through this.
 * @param {string} repo
 * @returns {string}
 */
export function repoOwner(repo) {
  const slash = repo.indexOf('/');
  return (slash === -1 ? repo : repo.slice(0, slash)).toLowerCase();
}

/**
 * Whether `repo` belongs to one of the work organizations in `workOrgs`.
 *
 * An empty `workOrgs` makes this true for every repository, matching the "an empty list is
 * no constraint" rule {@link applyFilters} already follows. That is the case on a machine
 * that sets no `PR_DASH_WORK_ORGS`: nothing is personal, so the Personal toggle hides
 * nothing and the dashboard behaves as it did before the toggle existed.
 * @param {string} repo
 * @param {readonly string[]} workOrgs Already lowercased by `parseWorkOrgs` in src/main-lib.ts.
 * @returns {boolean}
 */
export function isWorkRepo(repo, workOrgs) {
  if (workOrgs.length === 0) return true;
  return workOrgs.includes(repoOwner(repo));
}

/**
 * Keeps the records the Personal toggle admits: every record when the toggle is on or no
 * work organizations are configured, and only work-owned records when it is off.
 *
 * Deliberately separate from {@link applyFilters} rather than a fifth axis inside it. The
 * two cuts need telling apart downstream: Reset view clears the filters but leaves Personal
 * off, so an empty page caused by the toggle must name the toggle rather than Reset —
 * see `emptyStateMessage` in render-guards.js.
 * @param {readonly PrRecord[]} records
 * @param {boolean} personal Whether the Personal toggle is on.
 * @param {readonly string[]} workOrgs
 * @returns {PrRecord[]}
 */
export function applyPersonalCut(records, personal, workOrgs) {
  if (personal) return [...records];
  return records.filter((pr) => isWorkRepo(pr.repo, workOrgs));
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

/**
 * Counts of each CI and review state within one group, plus the group's size. Every
 * state is present with a count of 0 rather than omitted, so a caller can read
 * `summary.ci.failure` without guarding the lookup.
 * @typedef {object} GroupSummary
 * @property {number} total
 * @property {Record<import('../src/types.ts').Ci, number>} ci
 * @property {Record<import('../src/types.ts').Review, number>} review
 */

/**
 * Summarises a group's records. Pure, and here rather than in `app.js`, because
 * `app.js` cannot be imported under `node --test` — a count that silently drifts is
 * exactly the kind of thing a test has to hold.
 * @param {readonly PrRecord[]} records
 * @returns {GroupSummary}
 */
export function groupSummary(records) {
  /** @type {GroupSummary} */
  const summary = {
    total: records.length,
    ci: { success: 0, failure: 0, pending: 0, none: 0 },
    review: { approved: 0, changes_requested: 0, review_required: 0, none: 0 },
  };
  for (const pr of records) {
    summary.ci[pr.ci] += 1;
    summary.review[pr.review] += 1;
  }
  return summary;
}

/**
 * One chip to show on a collapsed section header.
 * @typedef {object} SummaryChip
 * @property {string} label
 * @property {'bad' | 'warn' | 'good'} tone
 */

/**
 * One chip per state worth surfacing on a collapsed header, ordered so a problem is read
 * first, with empty states omitted.
 *
 * A collapsed header has to keep its signal: folding a repository away must not hide that
 * something inside it is failing or waiting on you, or collapsing becomes a way to lose
 * track of work. A clean group produces no chips at all — the count in the header already
 * says how much is in there.
 * @param {GroupSummary} summary
 * @returns {SummaryChip[]}
 */
export function summaryChips(summary) {
  /** @type {SummaryChip[]} */
  const chips = [];
  if (summary.ci.failure > 0) chips.push({ label: `${summary.ci.failure} failing`, tone: 'bad' });
  if (summary.review.changes_requested > 0) {
    chips.push({ label: `${summary.review.changes_requested} changes`, tone: 'bad' });
  }
  if (summary.review.review_required > 0) {
    chips.push({ label: `${summary.review.review_required} waiting`, tone: 'warn' });
  }
  if (summary.ci.pending > 0) chips.push({ label: `${summary.ci.pending} pending`, tone: 'warn' });
  if (summary.review.approved > 0) {
    chips.push({ label: `${summary.review.approved} approved`, tone: 'good' });
  }
  return chips;
}

/**
 * The key a collapsed group header is tracked under: the axis and the group's own key,
 * joined so the same key text under two axes — both `ci` and `review` have a `none` group —
 * can't collide and fold a section nobody collapsed. A stack key is a bare PR id instead,
 * never axis-qualified; a PR id always contains `#`, which none of these joined strings do,
 * so the two kinds of key can never collide with each other either.
 *
 * Here rather than in `app.js` so the suite can call it: `app.js` cannot be imported under
 * `node --test`, and a source-reading test could only assert that the right return statement
 * appears somewhere in the body — which a `return key;` inserted above it satisfies.
 * @param {Axis} axis
 * @param {string} key
 * @returns {string}
 */
export function groupCollapseKey(axis, key) {
  return `${axis}:${key}`;
}
