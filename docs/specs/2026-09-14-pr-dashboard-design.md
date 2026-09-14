# PR dashboard — a local, grouped view of my open pull requests

**Date:** 2026-09-14
**Status:** Proposal (branch `worktree-pr-dashboard-spec`)

## Problem

`github.com/pulls` presents every open PR I authored as one flat, chronologically sorted
list. It cannot group. It shows CI state only as a small icon, review state not at all
without opening each PR, and it has no concept of a stacked PR — the four branches of a
stack appear as four unrelated rows, in whatever order they were last touched.

The result is that answering "which of mine are red right now", "which are waiting on
someone else", and "which have gone stale" each takes a pass over the same list with my
own eyes doing the grouping.

This spec designs a local dashboard that does that grouping.

## Scope

In scope:

- Open pull requests I authored, across every repository I can see.
- Grouping and filtering by repository, CI status, review state, staleness, and draft state.
- Stacked PRs rendered as a nested tree rather than as unrelated rows.
- Read-only. Every mutating action is a deep link out to GitHub.

Out of scope, deliberately:

- PRs where review is requested of me, bot-authored PRs, and recently merged PRs. Each is a
  different triage workflow and would change the grouping defaults. The data layer does not
  preclude adding them.
- Diff viewing and review. GitHub's review UI is not the thing that is broken.
- Any mutating action: merge, close, comment, approve, re-run CI.

## Chosen approach: one GraphQL query, stacks derived from branch refs

A single GraphQL `search` query returns every open PR I authored, with every field the
dashboard needs, in pages of 100. Stacks are then reconstructed from the data already in
that response: within a repository, a PR whose `baseRefName` equals another open PR's
`headRefName` is a child of that PR.

### Why not the alternatives

**REST plus a call per PR.** The search endpoint returns PR stubs without check or review
state, so each row costs two further requests. That is N+1 against a rate limit, and it is
slow enough to be felt past roughly twenty PRs. GraphQL asks for those fields inline.

**Shelling out to `gh stack view --json` for stack state.** This is the authoritative
source for stacks that `gh-stack` created, and it is the only way to get `needsRebase`.
It cannot be used here: it reads the stack from the local checkout and exits 2 when the
working directory is not on a stack. A dashboard spanning every repository has no checkout
to stand in, and making it depend on which repositories happen to be cloned locally would
make the same account render differently on two machines.

Branch-ref chaining has a further advantage: it reconstructs stacks built by hand, not only
those `gh-stack` tracks.

## Architecture

One Node process, started by `pr-dash`, listening on `127.0.0.1`. It fetches and normalizes
GitHub data, and serves a static page plus one JSON endpoint. The browser performs all
grouping, filtering, and sorting against a single payload — a few hundred rows at most, so
there is no reason to round-trip to the server to regroup.

| Module | Purpose | I/O |
|---|---|---|
| `src/github.ts` | GraphQL query, pagination, token acquisition | network |
| `src/normalize.ts` | raw response nodes to flat PR records | none |
| `src/stacks.ts` | PR records to a forest of stacks | none |
| `src/server.ts` | `node:http`, static files, `/api/prs`, cache | filesystem |
| `src/client/*.ts` | rendering, grouping, filtering, sorting | none |
| `bin/pr-dash` | port selection, launch, open browser | process |

`normalize.ts`, `stacks.ts`, and the client's grouping logic are pure functions over plain
data. They are the whole testable core and none of them touch the network.

## The GraphQL query

```graphql
query($cursor: String) {
  search(query: "is:open is:pr author:@me", type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft baseRefName headRefName
        createdAt updatedAt additions deletions reviewDecision
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
```

`statusCheckRollup` hangs off the head commit, not off the pull request, which is why the
query reaches through `commits(last: 1)`.

## The PR record

`normalize.ts` flattens each node into one shape that everything downstream works against:

```ts
type PrRecord = {
  repo: string;          // "owner/name"
  number: number;
  title: string;
  url: string;
  headRef: string;
  baseRef: string;
  isDraft: boolean;
  ci: "success" | "failure" | "pending" | "none";
  review: "approved" | "changes_requested" | "review_required" | "none";
  openedAt: string;      // ISO 8601
  updatedAt: string;     // ISO 8601
  ageDays: number;
  staleDays: number;
  additions: number;
  deletions: number;
};
```

Both `ci` and `review` have a genuine "GitHub reported nothing" case, and it is distinct
from "pending". `statusCheckRollup` is null when no checks ran at all; `reviewDecision` is
null when the repository requires no review. Both normalize to `"none"`. Collapsing them
into `"pending"` would paint every PR in a repository without CI permanently yellow.

## Reconstructing stacks

`stacks.ts` builds a `headRef -> PrRecord` index per repository, then resolves each record's
`baseRef` against it. A hit makes that record a child; a miss makes it a root sitting on
trunk. Roots render at top level, children nested beneath with a depth indent and a
position badge reading `2/4`.

Cases the algorithm must handle, each with a test:

| Case | Expected behavior |
|---|---|
| Linear chain of four PRs | One root, three descendants, positions 1/4 through 4/4 |
| Two PRs sharing one base | One root with two children; the tree forks |
| Middle PR merged, child still open | Child's `baseRef` resolves to nothing — treat as root, flag it |
| Cycle in the base/head graph | Detect and break; render affected PRs flat rather than hanging |

The third case is not an error to hide. A dangling parent is precisely the state where a
stack needs a rebase, so the row carries a marker saying so — recovering most of the signal
`needsRebase` would have given.

A cycle should be impossible through GitHub's own UI. The traversal still tracks visited
nodes, because a server that hangs is worse than a tree rendered flat.

## Grouping, filtering, sorting

Group-by is a single control with five settings rather than five separate views:
**repository** (default), **CI status**, **review state**, **staleness bucket**
(`<1d`, `1-3d`, `3-7d`, `>7d`), and **draft vs ready**.

Filters are independent toggles over those same axes, so grouping by repository while
filtering to failing CI is an ordinary combination rather than a special case.

Sorting within a group defaults to staleness, and switches to age, title, or diff size.

Stacks stay nested when grouping by repository. Under any other axis a stack's members
belong to different groups by definition, so the stack collapses to a badge linking its
siblings. Nesting a tree inside a grouping that cuts across it would show the same PR twice
or hide it entirely.

Group-by, active filters, and sort persist to `localStorage`, with a visible reset control.
A saved filter state that cannot be cleared is a trap: the dashboard looks empty and the
reason is invisible.

## Refresh, caching, error handling

The server holds the normalized payload in memory with a 60-second TTL. A refresh control
in the page bypasses the TTL.

The last successful payload is retained. When a refresh fails, the page continues to show
that data behind a banner naming the failure and the time of the last success. Going blank
on a transient network error would be a worse failure than showing data a few minutes old.

- **No token at startup:** exit with the literal `gh auth login` command to run.
- **GraphQL partial errors:** render the rows that did arrive, with a banner listing what failed.
- **Rate limit exhausted:** banner naming the reset time, serving cached data until then.

## Authentication

This touches a GitHub credential, so the handling is explicit. The server reads a token by
invoking `gh auth token` at startup and holds it in memory for the process lifetime. It is
never written to disk, never logged, and never sent to the browser — the client talks only
to `127.0.0.1` and receives normalized PR records. The dashboard performs no mutating
operation, so a read-scoped token is sufficient.

`GH_TOKEN` in the environment overrides the `gh` lookup, for the case where `gh`'s config
is unreadable.

Note for development: this repository's Claude sandbox denies reads of `~/.config/gh` and
denies network access to `github.com`, so `gh auth token` fails inside a sandboxed shell.
The server must be run from an ordinary shell.

## Language and tooling

TypeScript throughout, checked by `tsc --noEmit`.

Node 24 strips type annotations natively, so `src/server.ts` and its imports run with no
build step. The browser cannot do the same, so `src/client/` is bundled with esbuild into
`public/app.js`. Two execution paths, one type system, one check command.

Types for the GraphQL response are generated from GitHub's published schema rather than
written by hand, so a schema change surfaces as a type error instead of as a null at
runtime.

## Testing

`node:test`, matching the repository's existing scripts.

- `normalize.ts` — recorded GraphQL fixtures, including the null `statusCheckRollup` and
  null `reviewDecision` cases.
- `stacks.ts` — hand-built record arrays, one test per case in the table above.
- Grouping and sorting — one test per axis, over a shared fixture.
- `server.ts` — a single smoke test: start with a stubbed fetch, request `/api/prs`,
  assert the response shape.

No test performs network I/O.

## Deployment

`bin/pr-dash` deploys via chezmoi to `~/.local/bin/pr-dash`, as
`home/dot_local/bin/executable_pr-dash`. The source modules live alongside it under
`home/dot_local/share/pr-dash/`.

## Deferred

- **`needsRebase` from `gh stack view --json`,** as an enrichment where a local clone
  exists. Additive to the design above, not a change to it. Worth doing if the dangling-base
  marker proves too coarse.
- **Other PR scopes** — review-requested, bot-authored, recently merged. The query is one
  search string; the work is in the grouping defaults each would want.
- **Actions.** Would require a write-scoped token and a confirmation step on anything
  irreversible. Deliberately excluded from v1.
