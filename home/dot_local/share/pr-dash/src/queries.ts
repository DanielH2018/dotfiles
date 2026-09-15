import type { Client, QueryResult } from './github.ts';
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

// `search`, its `pageInfo` and the individual `nodes` are all nullable because a partial
// response nulls exactly the field that failed while still returning HTTP 200 — the shape
// this module has to survive, not a hypothetical one. `pageInfo` is additionally typed
// `| undefined` because nothing validates the body against this type before it arrives
// here: an omitted key is indistinguishable from a null one at the point of use, and the
// query always asks for the field, so a missing one is the same server misbehaviour.
type SearchData = {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null } | null | undefined;
    nodes: (RawPr | null)[];
  } | null;
};

// The rows that arrived plus the GraphQL errors that came with them. `errors` is empty on
// a complete response; non-empty means these rows are a partial view of the user's PRs,
// which is what the page's banner has to tell the user.
export type FetchAllResult = { prs: RawPr[]; errors: string[] };

// A generous ceiling on pages, not a realistic count: one open-PR search fits in a handful
// of pages of 100. This exists solely to bound a malformed or hostile server that keeps
// reporting hasNextPage: true — with or without advancing endCursor — which without a
// bound would loop forever.
const MAX_PAGES = 100;

export async function fetchAllPrs(client: Client): Promise<FetchAllResult> {
  const all: RawPr[] = [];
  const errors: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    // Annotated, not inferred: `cursor` is reassigned from this page's endCursor at the
    // bottom of the loop, and without the annotation that circles back through `page` and
    // tsc gives up with an implicit `any` (TS7022).
    const page: QueryResult<SearchData> = await client.query<SearchData>(SEARCH, { cursor });
    errors.push(...page.errors);
    const search = page.data.search;

    // A partial response nulls the field that failed, so `search` itself can be null
    // alongside a non-empty `errors`. With no rows on this page there is nothing to keep:
    // if earlier pages did arrive, stop and return those as a partial result, and if this
    // was the first page there is nothing to show and the errors are the failure.
    if (search === null || !Array.isArray(search.nodes)) {
      if (all.length > 0) break;
      throw new Error(
        errors.length > 0
          ? `GraphQL error: ${errors.join('; ')}`
          : 'GitHub returned no search results',
      );
    }

    // A row GitHub could not read arrives as a null element, with the `errors` array beside
    // it explaining why. Handing that null to normalize() throws a TypeError off
    // `n.commits`, and the throw discards those errors — so the user reads "Cannot read
    // properties of null" where the reason should be, and on a `nodes: [null]` carrying no
    // errors at all nothing explains the gap. Dropping the row here and naming the count
    // keeps both halves: the rows that did arrive, and why the others did not.
    //
    // This is the boundary that guarantees normalize()'s `readonly RawPr[]` input, which is
    // why normalize() itself has no null branch — it would be unreachable from a real call.
    const rows = search.nodes.filter((n): n is RawPr => n !== null);
    const dropped = search.nodes.length - rows.length;
    if (dropped > 0) {
      errors.push(
        `GitHub returned ${dropped} pull request row(s) it could not read, so this list is incomplete.`,
      );
    }
    all.push(...rows);

    // The other shape a failed page takes: `nodes` arrives as a well-formed empty array
    // beside the errors. Zero rows collected anywhere means there is still nothing to
    // show, and calling that a partial success would be worse than throwing — since
    // `withFallback` only retains on a throw, a zero-row success replaces the rows the
    // user can already see with "no open PRs" behind a banner.
    //
    // An empty page with no errors is a different thing: a user with genuinely no open
    // PRs. That falls through to the pagination checks below rather than failing.
    if (all.length === 0 && errors.length > 0) {
      throw new Error(`GraphQL error: ${errors.join('; ')}`);
    }

    pages += 1;

    // A page carrying errors may carry a null or meaningless pageInfo beside its rows, so
    // stop here rather than reading a cursor the server never really issued. The rows
    // collected so far are the partial result.
    if (page.errors.length > 0) break;

    // A null or missing pageInfo is not a clean end of pagination: the field that says
    // whether more pages remain arrived absent, so the rows collected so far may be a
    // truncated view of the user's PRs. Reading it as "no more pages" is how 100 of 250
    // open PRs present as all of them, with a fresh timestamp and no banner — worse than
    // the empty list, because a truncated list looks right. Whether GitHub can actually
    // produce this shape is unresolved (nulling a field without an `errors` entry would
    // violate the GraphQL spec), so this takes the safe reading rather than betting on the
    // server's conformance.
    if (search.pageInfo === null || search.pageInfo === undefined) {
      errors.push(
        'GitHub did not report whether more pull requests remain, so this list is incomplete.',
      );
      // Same rule as the zero-row cases above: with nothing collected there is nothing to
      // present as partial, and a zero-row success would replace rows the user can still
      // see with "no open PRs" behind a banner, since `withFallback` only retains on a throw.
      if (all.length === 0) throw new Error(errors.join('; '));
      break;
    }
    if (!search.pageInfo.hasNextPage) break;

    const nextCursor = search.pageInfo.endCursor;
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

  return { prs: all, errors };
}
