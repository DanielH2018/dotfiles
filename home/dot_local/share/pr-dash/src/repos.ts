import type { Client, QueryResult } from './github.ts';
import type { Cache } from './cache.ts';
import { createCachedLoad, type CachedLoad } from './cached-load.ts';
import { ciFromRollup, reviewFromDecision } from './normalize.ts';
import type { Ci } from './types.ts';
import type { VulnRepo } from './vulns.ts';

// The repositories page: per configured repository, its open PRs and the CI state of its
// default branch's head. Open alerts are not fetched here; the page joins them from
// /api/vulns, which owns them. Same fan-out shape as vulns.ts: one query per repository, and
// a repository the token cannot read costs that repository's row and nothing else.

/** The default branch's head commit. */
export type BranchHead = {
  name: string;
  ci: Ci;
  commitUrl: string;
  headline: string;
  committedAt: string;
  /** A GitHub login when the commit maps to a user, otherwise the commit's author name. */
  author: string;
};

export type PrSummary = {
  open: number;
  drafts: number;
  /**
   * Non-draft PRs nobody has approved yet: GitHub's review decision is REVIEW_REQUIRED, or
   * the repository requires no review (decision null) and the PR has no review at all.
   */
  awaitingReview: number;
  /** `null` with no open PRs. */
  oldestOpenedAt: string | null;
  /** The URL of the repository's open-PR list. */
  url: string;
};

/**
 * One configured repository. `error` is set exactly when the repository answered nothing
 * usable, and then `branch` and `prs` are null: a failed fetch must never read as a quiet
 * repository with no PRs.
 */
export type RepoRow = {
  repo: string;
  url: string | null;
  /** `null` on an empty repository, which has no default branch yet. */
  branch: BranchHead | null;
  prs: PrSummary | null;
  error: string | null;
};

export type RepoLoadResult = {
  rows: RepoRow[];
  fetchedAt: string;
  /** Gaps in rows that did load, each prefixed with its repository. */
  partialErrors: string[];
};

export type LoadRepos = CachedLoad<RepoLoadResult>;

const OVERVIEW = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    url
    defaultBranchRef {
      name
      target {
        ... on Commit {
          url committedDate messageHeadline
          author { name user { login } }
          statusCheckRollup { state }
        }
      }
    }
    pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { isDraft createdAt reviewDecision reviews(first: 1) { totalCount } }
    }
  }
}`;

// Nullable at every level for the same reason as vulns.ts's AlertsData: a partial response
// nulls exactly the field that failed and still answers 200.
export type RawCommit = {
  url: string;
  committedDate: string;
  messageHeadline: string;
  author: { name: string | null; user: { login: string } | null } | null;
  statusCheckRollup: { state: string } | null;
};

export type RawPrNode = {
  isDraft: boolean;
  createdAt: string;
  reviewDecision: string | null;
  reviews: { totalCount: number } | null;
};

export type OverviewData = {
  repository: {
    url: string;
    // `target` is `{}` when the ref points at something other than a commit.
    defaultBranchRef: { name: string; target: Partial<RawCommit> | null } | null;
    pullRequests: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
      nodes: (RawPrNode | null)[];
    } | null;
  } | null;
};

// Bounds a server that keeps reporting hasNextPage, as in vulns.ts.
const MAX_PAGES = 20;

function branchHead(ref: NonNullable<NonNullable<OverviewData['repository']>['defaultBranchRef']>): BranchHead | null {
  const c = ref.target;
  if (c === null || typeof c.url !== 'string' || typeof c.committedDate !== 'string') return null;
  return {
    name: ref.name,
    ci: ciFromRollup(c.statusCheckRollup?.state),
    commitUrl: c.url,
    headline: c.messageHeadline ?? '',
    committedAt: c.committedDate,
    author: c.author?.user?.login ?? c.author?.name ?? 'unknown',
  };
}

function awaitsReview(pr: RawPrNode): boolean {
  if (pr.isDraft) return false;
  const review = reviewFromDecision(pr.reviewDecision);
  return review === 'review_required' || (review === 'none' && (pr.reviews?.totalCount ?? 0) === 0);
}

/**
 * One repository's row, following its open PRs to the end of their pagination.
 *
 * Throws when the repository answered nothing usable: not found, or no access. Returns the
 * row with `errors` naming the gap when only part of it arrived, such as a later PR page.
 */
export async function fetchRepoRow(client: Client, repo: VulnRepo): Promise<{ row: RepoRow; errors: string[] }> {
  const label = `${repo.owner}/${repo.name}`;
  const errors: string[] = [];
  let row: RepoRow | undefined;
  let prs: PrSummary | undefined;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response: QueryResult<OverviewData> = await client.query<OverviewData>(OVERVIEW, { owner: repo.owner, name: repo.name, cursor });
    const repository = response.data.repository;
    const connection = repository?.pullRequests;
    if (repository === null || connection === null || connection === undefined) {
      const reason = response.errors.join('; ') || 'GitHub returned no data for this repository';
      if (row === undefined) throw new Error(reason);
      errors.push(`PR counts stop after page ${page}: ${reason}`);
      break;
    }
    if (row === undefined || prs === undefined) {
      const first = connection.nodes.find((n) => n !== null);
      prs = {
        open: connection.totalCount,
        drafts: 0,
        awaitingReview: 0,
        // Ordered oldest first, so the first page's first node is the oldest of them all.
        oldestOpenedAt: first?.createdAt ?? null,
        url: `${repository.url}/pulls`,
      };
      const ref = repository.defaultBranchRef;
      row = { repo: label, url: repository.url, branch: ref === null ? null : branchHead(ref), prs, error: null };
    }
    errors.push(...response.errors);
    for (const node of connection.nodes) {
      if (node === null) continue;
      if (node.isDraft) prs.drafts += 1;
      if (awaitsReview(node)) prs.awaitingReview += 1;
    }
    if (connection.pageInfo?.hasNextPage !== true) break;
    cursor = connection.pageInfo.endCursor;
    if (page === MAX_PAGES - 1) errors.push(`PR counts stop after ${MAX_PAGES} pages`);
  }
  if (row === undefined) throw new Error('GitHub returned no data for this repository');
  return { row, errors };
}

/**
 * The `loadRepos` the server calls on every `/api/repos`. Repositories are queried in
 * parallel; a failed one becomes an error row. Only when every one fails does the load fail,
 * which {@link createCachedLoad} then answers from the last good result marked stale.
 *
 * With no repositories configured it answers an empty result without querying GitHub.
 */
export function createRepoLoader(
  client: Client,
  repos: readonly VulnRepo[],
  cache: Cache<RepoLoadResult>,
  now: () => number = Date.now,
): LoadRepos {
  async function fetchAll(): Promise<RepoLoadResult> {
    const settled = await Promise.allSettled(repos.map((r) => fetchRepoRow(client, r)));
    const rows: RepoRow[] = [];
    const partialErrors: string[] = [];
    const failures: string[] = [];
    settled.forEach((outcome, i) => {
      const r = repos[i];
      const label = r === undefined ? '' : `${r.owner}/${r.name}`;
      if (outcome.status === 'fulfilled') {
        rows.push(outcome.value.row);
        partialErrors.push(...outcome.value.errors.map((e) => `${label}: ${e}`));
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        failures.push(reason);
        rows.push({ repo: label, url: null, branch: null, prs: null, error: reason });
      }
    });
    if (repos.length > 0 && failures.length === repos.length) {
      // Almost always one cause (the token, the network, a rate limit), so name each distinct one once.
      throw new Error([...new Set(failures)].join('; '));
    }
    return { rows, fetchedAt: new Date(now()).toISOString(), partialErrors };
  }
  return createCachedLoad(fetchAll, cache, now);
}
