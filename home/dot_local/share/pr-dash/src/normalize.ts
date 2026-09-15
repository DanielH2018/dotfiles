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
  repository: { nameWithOwner: string; defaultBranchRef: { name: string } | null };
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

// A sentinel for when `from` or `to` can't be read as a date. Chosen to be finite — so it
// still satisfies render-guards.js's numeric field check — and larger than any real day
// count, so it sorts to the top of the descending 'stale'/'age' sorts in group.js's
// sortWithin and lands in stalenessBucket's '>7d' bucket rather than '<1d'.
const UNPARSEABLE_DAYS = 9999;

// Whole days between an ISO timestamp and `now`, never negative and never NaN or Infinity.
//
// GitHub's timestamp can be later than the local clock reads (clock skew between GitHub and
// the machine running this — reachable, not hypothetical) and clamping that to 0 rather than
// returning a negative count is deliberate: `stalenessBucket` in group.js already treats
// anything under 1 as '<1d', so a negative "age" and a zero one land in the same bucket, but
// only the clamped value avoids printing as "-1d" in app.js's `${pr.staleDays}d` label.
//
// An unparseable `from` (a malformed field GitHub should never send, but nothing in this
// module's input type rules out) or an invalid `to` makes `.getTime()` return NaN.
// Propagating that would satisfy render-guards.js's `validateRecord` — it only checked
// `typeof`, and `typeof NaN === 'number'` — but that check now also rejects non-finite
// values, closing that hole at the boundary too. Falling back to 0 here would still be
// wrong in a different way: 0 reads as "freshly touched", the opposite of "this PR's
// staleness is unknown," on the one axis (staleness) whose entire job is surfacing
// neglected PRs. UNPARSEABLE_DAYS instead makes a malformed record render looking wrong —
// sorted to the top, bucketed into '>7d' — rather than looking fine when it isn't. This
// function does not throw on a bad date: one malformed record from GitHub should not blank
// the whole dashboard.
function days(from: string, to: Date): number {
  const parsedFrom = new Date(from).getTime();
  const parsedTo = to.getTime();
  if (Number.isNaN(parsedFrom) || Number.isNaN(parsedTo)) return UNPARSEABLE_DAYS;
  return Math.max(0, Math.floor((parsedTo - parsedFrom) / DAY_MS));
}

export function normalize(nodes: readonly RawPr[], now: Date = new Date()): PrRecord[] {
  return nodes.map((n) => {
    // statusCheckRollup hangs off a commit, not the PR itself. The caller must query
    // commits(last: 1) — GitHub returns commits oldest-first, so a caller that queries
    // first: 1 instead would silently hand this the oldest commit's rollup rather than the
    // head's, and nothing here can detect that mistake from the shape of the data alone.
    // Trusting that obligation, this reads the *last* element of commits.nodes, not the
    // first. noUncheckedIndexedAccess correctly types `.at(-1)` as possibly undefined,
    // because a PR with no commits yields an empty nodes array — a real state (see the "no
    // commits edge case" fixture), not one to assert away with `!`.
    const state = n.commits.nodes.at(-1)?.commit.statusCheckRollup?.state;
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
      defaultBranch: n.repository.defaultBranchRef?.name ?? null,
    };
  });
}
