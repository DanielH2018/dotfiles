import type { Client } from './github.ts';
import type { RawPr } from './normalize.ts';

// commits(last: 1): GitHub returns a PR's commits oldest-first, and normalize() reads
// statusCheckRollup off the *last* element of commits.nodes expecting it to be the head
// commit. `first: 1` would silently hand normalize() the oldest commit's rollup instead —
// wrong on every multi-commit PR, and wrong in a way nothing downstream can detect from the
// shape of the data alone. Do not change this to `first: 1`.
export const PR_FIELDS = `
  number title url isDraft baseRefName headRefName
  createdAt updatedAt additions deletions reviewDecision
  repository { nameWithOwner defaultBranchRef { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const SEARCH = `
query($cursor: String) {
  search(query: "is:open is:pr author:@me", type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

type SearchData = {
  search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawPr[] };
};

// A generous ceiling on pages, not a realistic count: one open-PR search fits in a handful
// of pages of 100. This exists solely to bound a malformed or hostile server that keeps
// reporting hasNextPage: true — with or without advancing endCursor — which without a
// bound would loop forever.
const MAX_PAGES = 100;

export async function fetchAllPrs(client: Client): Promise<RawPr[]> {
  const all: RawPr[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const data: SearchData = await client.query<SearchData>(SEARCH, { cursor });
    all.push(...data.search.nodes);
    pages += 1;

    if (!data.search.pageInfo.hasNextPage) break;

    const nextCursor = data.search.pageInfo.endCursor;
    // A cursor that doesn't advance (null, or repeating the same value) alongside
    // hasNextPage: true means the server is not making forward progress — stop rather
    // than spin.
    if (nextCursor === null || nextCursor === cursor) {
      throw new Error(
        `GitHub search pagination did not terminate after ${pages} page(s): ` +
          'hasNextPage stayed true without the cursor advancing. Aborting rather than looping forever.',
      );
    }
    // MAX_PAGES is a separate defense: a server that advances the cursor every time but
    // never says hasNextPage: false would pass the check above forever.
    if (pages >= MAX_PAGES) {
      throw new Error(`GitHub search pagination did not stop after ${pages} pages. Aborting.`);
    }
    cursor = nextCursor;
  }

  return all;
}
