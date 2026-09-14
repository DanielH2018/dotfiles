import type { Ci, PrRecord, Review } from './types.ts';

export type RawPr = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  repository: { nameWithOwner: string };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};

// GitHub's StatusState enum today: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED — every branch
// below is a real value, none of them a guess. A state this repo doesn't recognize (GitHub
// adding one later) falls through to 'pending' rather than 'none' or 'success': something is
// actively resolving that this mapping doesn't have a name for yet, and 'pending' is the one
// answer that neither hides it (as 'none' would) nor asserts a result we can't back up (as
// 'success' or 'failure' would).
const CI_BY_STATE: Record<string, Ci> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

// GitHub's PullRequestReviewDecision enum today: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
// — again exhaustive. An unrecognized value falls back to 'none', matching how a genuinely
// absent decision (the repository requires no review) is treated: a review-decision value
// this code can't name is closer to "no decision to report" than to any of the three known,
// actionable states.
const REVIEW_BY_DECISION: Record<string, Review> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

const DAY_MS = 86_400_000;

// Whole days between an ISO timestamp and `now`, never negative and never NaN.
//
// GitHub's timestamp can be later than the local clock reads (clock skew between GitHub and
// the machine running this — reachable, not hypothetical) and clamping that to 0 rather than
// returning a negative count is deliberate: `stalenessBucket` in group.js already treats
// anything under 1 as '<1d', so a negative "age" and a zero one land in the same bucket, but
// only the clamped value avoids printing as "-1d" in app.js's `${pr.staleDays}d` label.
//
// An unparseable `from` (a malformed field GitHub should never send, but nothing in this
// module's input type rules out) makes `new Date(from).getTime()` return NaN. Propagating
// that would satisfy render-guards.js's `validateRecord` — it only checks `typeof`, and
// `typeof NaN === 'number'` — so a NaN would sail past that boundary and corrupt the render
// path silently instead: `sortWithin`'s comparator returns 0 for any comparison touching
// NaN, leaving stale/age sort undefined, and the row label reads literally as "NaNd". Both
// failure modes are worse than falling back to 0, so an unparseable date is treated as "no
// elapsed time" rather than let NaN escape this module.
function days(from: string, to: Date): number {
  const parsed = new Date(from).getTime();
  const elapsed = Number.isNaN(parsed) ? 0 : to.getTime() - parsed;
  return Math.max(0, Math.floor(elapsed / DAY_MS));
}

export function normalize(nodes: readonly RawPr[], now: Date = new Date()): PrRecord[] {
  return nodes.map((n) => {
    // statusCheckRollup hangs off the head commit, not the PR, so this reaches through
    // commits.nodes[0] — which noUncheckedIndexedAccess correctly types as possibly
    // undefined, because a PR with no commits yields an empty nodes array. That is a real
    // state (see the "no commits edge case" fixture), not one to assert away with `!`.
    const state = n.commits.nodes[0]?.commit.statusCheckRollup?.state;
    return {
      id: `${n.repository.nameWithOwner}#${n.number}`,
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      url: n.url,
      headRef: n.headRefName,
      baseRef: n.baseRefName,
      isDraft: n.isDraft,
      // `state === undefined` covers both a null statusCheckRollup (no checks ran) and no
      // commits at all (nothing to have a rollup). Neither is "pending" — GitHub reported
      // nothing, which is 'none'. Folding this into 'pending' would paint every PR in a repo
      // without CI permanently yellow.
      ci: state === undefined ? 'none' : (CI_BY_STATE[state] ?? 'pending'),
      review: n.reviewDecision === null ? 'none' : (REVIEW_BY_DECISION[n.reviewDecision] ?? 'none'),
      openedAt: n.createdAt,
      updatedAt: n.updatedAt,
      ageDays: days(n.createdAt, now),
      staleDays: days(n.updatedAt, now),
      additions: n.additions,
      deletions: n.deletions,
    };
  });
}
