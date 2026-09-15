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
- Grouping by repository, CI status, review state, staleness, or draft state; filtering by
  CI status, review state, staleness, and draft state.
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
| `src/github.ts` | GraphQL transport: `query()`, pagination, token acquisition | network |
| `src/queries.ts` | The PR fragment, plus fetch-many and fetch-one built from it | none |
| `src/normalize.ts` | raw response nodes to flat PR records | none |
| `src/stacks.ts` | PR records to a forest of stacks | none |
| `src/server.ts` | `node:http`, static files, `/api/prs`, cache | filesystem |
| `public/app.js` | rendering and control wiring (DOM) | none |
| `public/group.js` | grouping, filtering, sorting (pure) | none |
| `bin/pr-dash` | generate the secret, launch the server, wait for it, open browser | process |

`normalize.ts`, `stacks.ts`, and `public/group.js` are pure functions over plain data. They
are the whole testable core and none of them touch the network. Grouping lives in its own
module rather than inside `app.js` precisely so it can be tested without a DOM.

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
  id: string;            // "owner/name#123" — stable, unique, survives a refetch
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

Filters are independent toggles over four of those axes — CI status, review state,
staleness and draft state — so grouping by repository while filtering to failing CI is an
ordinary combination rather than a special case. There is deliberately no repository
filter: repository is the default grouping axis, which already answers the question a
repository filter would, and the original request was to group by repository rather than
filter by it.

Sorting within a group defaults to staleness, and switches to age, title, or diff size.

Stacks stay nested when grouping by repository. Under any other axis a stack's members
belong to different groups by definition, so the stack collapses to a badge giving the
PR's position in its stack (`2/4`). Nesting a tree inside a grouping that cuts across it
would show the same PR twice or hide it entirely. The badge carries the position and
nothing else — it is not a link to the sibling PRs, which was never asked for.

Group-by, active filters, and sort persist to `localStorage`, with a visible reset control.
A saved filter state that cannot be cleared is a trap: the dashboard looks empty and the
reason is invisible.

## Refresh, caching, error handling

The server holds the normalized payload in memory with a 60-second TTL. A refresh control
in the page bypasses the TTL: the button requests `/api/prs?refresh=1`, and only that exact
value counts, so no value from the query string reaches the loader — just a boolean. The
loader invalidates the cache entry and fetches, rather than skipping the cache read, so the
fetch it just made repopulates the entry and the TTL restarts from it. Without that,
every later request would re-fetch.

The cache is a small object exposing `get()`, `set()`, and `invalidate()` rather than a
bare timestamp compared inline at the call site. The behavior in v1 is identical; the
difference is that an action which changes state on GitHub has something to call.

The last successful payload is retained. When a refresh fails, the page continues to show
that data behind a banner naming the failure and the time of the last success. Going blank
on a transient network error would be a worse failure than showing data a few minutes old.

- **No token at startup:** exit with the literal `op read` command to run, naming the item.
- **401 from GitHub:** the token is expired or revoked — banner naming its 1Password item
  and the renewal step, distinct from a network failure.
- **GraphQL partial errors:** render the rows that did arrive, with a banner listing what failed.
- **Rate limit exhausted:** banner naming the reset time, serving cached data until then.

## Authentication and local-server hardening

This touches a GitHub credential, so the handling is explicit. The server resolves a token
once at startup and holds it in memory for the process lifetime. It is never written to
disk, never logged, and never sent to the browser — the client talks only to `127.0.0.1`
and receives normalized PR records.

### The token comes from 1Password

```
op read "op://Private/GitHub PR Dashboard/token"
```

`PR_DASH_OP_ITEM` overrides the item reference. `GH_TOKEN` in the environment overrides
everything, for debugging and for running without 1Password available.

**There is deliberately no fallback to `gh auth token`.** That was the original design and
it is wrong, for a reason worth recording: `gh auth token` returns whatever scopes
`gh auth login` negotiated — in practice `repo`, which grants write, plus `read:org`,
`gist`, and `workflow`. A read-only dashboard holding a token that can push to every
repository I can see is a scope mismatch, and this spec claimed a read-scoped token was
sufficient while using a mechanism that could not provide one.

A dedicated token makes the claim true. Silently falling back to `gh` would re-broaden the
scope at the moment 1Password is unavailable, which is precisely when nobody is watching,
so the failure is a clear error naming the `op` command to run instead.

Three further reasons this is the better source: the token at rest is encrypted in the
vault rather than sitting in a config file; rotation happens in one place; and 1Password
already holds the SSH key that signs every commit in this repository, so the credential
story stays in one system rather than two.

### Practical notes

- **A fine-grained PAT is the goal; a classic PAT may be the reality.** Fine-grained tokens
  can be restricted to read-only pull request access, which is exactly right. Against
  organization-owned repositories they often require organization approval. A classic token
  with `repo` scope works without approval but grants write. Start by requesting the
  fine-grained token; if approval is not forthcoming, use a classic one and record in the
  1Password item that its scope is broader than the tool needs.
- **Expiry is a real failure mode, unlike the others.** Fine-grained tokens expire. GitHub
  answers an expired token with a 401, which must render as a banner naming the token's
  1Password item and the renewal step — not as a generic authentication failure that looks
  identical to a network problem.
- **`op` prompts once.** The read happens at startup, so unlocking costs one biometric
  prompt per server launch, not one per refresh.
- **This repository's Claude sandbox cannot run `op read`.** It permits the 1Password SSH
  agent socket, which is a different channel from the one the `op` CLI uses. The server
  runs outside the sandbox regardless, so this affects debugging sessions only.

### Why the guard exists in v1

`127.0.0.1` is not a security boundary. Any page open in the same browser can issue requests
to a loopback server, and a server holding a GitHub token is worth attacking: reading my
private PR titles today, and merging or closing PRs once actions exist. Nothing about that
threat is created by adding actions later — actions only raise the severity from disclosure
to writes against my repositories.

Retrofitting this guard onto an endpoint surface designed without it is how this class of
tool gets it wrong, so the four controls below ship in v1, while there is one endpoint to
apply them to.

1. **Bind to `127.0.0.1` only,** never `0.0.0.0`. Nothing off the machine can connect.
2. **Reject unexpected `Host` and `Origin` headers, on every request.** `Host` must be
   `127.0.0.1:<port>` or `localhost:<port>`; any other value means a DNS-rebinding attacker
   resolved their own hostname to loopback. `Origin`, when present, must match the server's
   own. No CORS headers are ever sent, so a cross-origin page cannot read a response even if
   it connects. This check covers the static files too, not just `/api/prs`: serving the
   dashboard's own client code to an attacker's hostname is a foothold in its own right.
3. **Require a per-launch secret on `/api/prs`.** `bin/pr-dash` generates a random token at
   startup, opens the browser at `http://127.0.0.1:<port>/#<secret>`, and the client sends
   it as a header on every API request. A page that did not receive the secret cannot use
   the API even from a permitted origin. The secret lives in memory and dies with the
   process. It is scoped to the API rather than to every path because a browser cannot
   attach a custom header to the address-bar navigation that loads the page shell —
   requiring it there would stop the dashboard loading at all. The shell carries no PR data.
4. **Serve `GET` and nothing else.** No route in v1 changes GitHub state and a cross-origin
   form POST cannot set the secret header, so this closes nothing exploitable today. It is
   here for the same reason as the rest: a method gate costs less to add before a mutating
   route exists than after.

None of the four depends on what the endpoints do, which is the point — the guard is
written once against a read-only surface and does not change when mutating routes arrive.

## Language and tooling

TypeScript on the server, JSDoc-annotated JavaScript in the browser, both checked by
`tsc --noEmit`. **There is no build step and no bundler.**

Node 24 strips type annotations natively, so `src/server.ts` and its imports run as written.
The browser cannot execute `.ts` — but that is a constraint on syntax, not on modules. The
client is plain `.js` with `// @ts-check`, loaded as native ES modules, annotated with
JSDoc, and type-checked against the same `src/types.ts` the server uses via
`/** @type {import("./types.ts").PrRecord} */`. Verified: `tsc --checkJs` resolves types
across that boundary and reports real errors in the `.js` files.

Adding esbuild to write the client in TypeScript would buy uniform syntax at the cost of a
build step, a committed or generated bundle, and a way for the deployed bundle to drift
from its source. Two syntaxes with one type system and zero build is the better trade for
a tool deployed by copying files into place.

`tsconfig.json` sets `erasableSyntaxOnly`, which rejects the TypeScript features Node's
stripping cannot run — enums, namespaces, parameter properties. Without it a type check
passes and the server fails at startup.

There are no runtime dependencies. The only devDependencies are `typescript` and
`@types/node`, both types-only and neither deployed — without `@types/node` the type check
cannot resolve `node:http` or `node:fs` and fails on the first server file.

`moduleResolution` is `nodenext`, not `bundler`. Since there is no bundler, `tsc` is the
only thing standing between an extensionless relative import and a failed launch, and
`bundler` resolution accepts imports Node's ESM loader rejects.

## Testing

`node:test`, matching the repository's existing scripts.

- `normalize.ts` — recorded GraphQL fixtures, including the null `statusCheckRollup` and
  null `reviewDecision` cases.
- `stacks.ts` — hand-built record arrays, one test per case in the table above.
- Grouping and sorting — one test per axis, over a shared fixture.
- `server.ts` — a single smoke test: start with a stubbed fetch, request `/api/prs`,
  assert the response shape.
- Token resolution — `GH_TOKEN` wins over `op`, and a failed `op read` produces the error
  naming the item rather than starting with no token.
- The request guard — a rejected `Host`, a mismatched `Origin`, and a missing secret each
  get a test. This is the one piece of v1 whose failure mode is silent, so it is the one
  piece that does not rely on the smoke test to cover it.

No test performs network I/O.

## Deployment

`bin/pr-dash` deploys via chezmoi to `~/.local/bin/pr-dash`, as
`home/dot_local/bin/executable_pr-dash`. The source modules live alongside it under
`home/dot_local/share/pr-dash/`.

## Designing for actions later

v1 is read-only, but merge, close, comment, approve, and re-run CI are likely enough that
the design should not have to be unpicked to add them. The decisions below cost nothing
now and are expensive to reverse.

What is deliberately **not** built now: no action registry, no abstract `Action` interface,
no permission model, no undo stack. Scaffolding built against imagined requirements is how
a small tool acquires a framework nobody needed. The list is short on purpose.

| Decision | Made now because |
|---|---|
| `Host` and `Origin` guard on every request, a per-launch secret on `/api/prs`, and `GET`-only routing | The only item that is a vulnerability if retrofitted. See the hardening section. |
| `PrRecord.id` as `"owner/name#123"` | Gives the client stable row identity, so a single row can be patched after an action instead of re-rendering the list. |
| `github.ts` is a transport with `query()`, not a function per screen | Adding `mutate()` beside `query()` is a few lines. A module shaped around the read path would need restructuring. |
| Shared PR fragment in `queries.ts`, used by fetch-many and fetch-one | An action needs to refetch exactly one PR. The fragment guarantees the refetched row has the same shape as the rows around it. |
| Cache exposes `invalidate()` | An action that changes GitHub state must be able to drop stale data. |

Two rules recorded here so a later session inherits them rather than deciding freshly:

**The token scope changes, and sourcing it from 1Password makes that a deliberate act.**
v1 needs read access only. Merge, close, and approve need write. Because the token is a
dedicated item rather than whatever `gh` happens to hold, granting write means editing that
item — visible, dated, and reversible. Whoever adds the first mutating route re-scopes the
token, states the new scope in the spec and in the startup error, and records it on the
1Password item. A tool that silently starts wanting write access to every repository I can
see is a change worth noticing.

**Irreversible actions get a confirmation step, reversible ones do not.** Merge and close
are irreversible in practice and must name the specific PR in a confirmation before
proceeding. Comment, approve, and re-run CI are recoverable and can act on a single click.
Wiring merge to a bare click in a dense grouped list is a mis-click away from merging the
wrong PR.

## Deferred

- **`needsRebase` from `gh stack view --json`,** as an enrichment where a local clone
  exists. Additive to the design above, not a change to it. Worth doing if the dangling-base
  marker proves too coarse.
- **Other PR scopes** — review-requested, bot-authored, recently merged. The query is one
  search string; the work is in the grouping defaults each would want.
- **Actions** — merge, close, comment, approve, re-run CI. Excluded from v1, but the design
  is shaped to take them; see *Designing for actions later* above for what is already in
  place and the two rules that apply when they land.
