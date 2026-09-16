# Slice 1 report: drop the per-launch secret

Worktree: `/Users/daniel/.local/share/chezmoi/.claude/worktrees/pr-dash-always-on`
Package: `home/dot_local/share/pr-dash`

## Baseline

- `npm test`: 441 passing, 0 failing.
- `npm run check` (`tsc --noEmit`): exit 0.

(`npm install` was needed first — `node_modules/` was absent in this worktree; it is
gitignored and untouched by git status.)

## What was removed

- **`src/guard.ts`** — deleted `secretMatches` and `checkSecret`. `checkHost` is
  untouched in behavior. Its doc comment, and the inline comment on the `Origin` check,
  now say `Host`/`Origin` are the whole request boundary instead of naming the removed
  secret, per the spec's instruction.
- **`src/server.ts`** — dropped `secret` from `ServerOpts`, dropped the `checkSecret` call
  and import in the `/api/prs` branch (which is now gated only by the top-of-`handle`
  `checkHost` call, same as every other path). Updated the shell-route and method-gate
  comments that referenced the secret.
- **`src/main.ts`** — removed the `PR_DASH_SECRET` env read/validation block and the
  `secret` field passed to `createServer`.
- **`public/app.js`** — removed the `resolveSecret` call, the `history.replaceState`
  fragment-stripping, the `x-pr-dash-secret` fetch header, and the 403 branch that called
  `clearStoredSecret`/`relaunchBanner`. Updated the `httpError` doc comment and a nearby
  implementation comment that both named the secret as part of what makes a 4xx permanent.
- **`public/render-guards.js`** — deleted `SECRET_KEY`, `SECRET_PATTERN`, `resolveSecret`,
  `clearStoredSecret`, `relaunchBanner`. Fixed `isPermanentFailure`'s doc comment, which
  referenced the now-gone `#secret` fragment.
- **`home/dot_local/bin/executable_pr-dash`** — stopped generating `PR_DASH_SECRET`;
  `URL` is now the bare `http://127.0.0.1:<port>/` with no fragment. Updated the ready-probe
  comment that explained the probe choice in terms of the secret gate.
- **`src/main-lib.ts`** — `listenErrorMessage`'s `EADDRINUSE` message no longer tells the
  operator to open the URL to check; it now says `run \`lsof -i :<port>\`` to see what
  holds it. (This function, not the bash script itself, is where that message text lives —
  `main.ts` prints it via `console.error(listenErrorMessage(err, port))`.)
- **Tests deleted**: all `checkSecret` tests in `tests/guard.test.ts`; the `resolveSecret`/
  `clearStoredSecret`/`relaunchBanner` block in `tests/render-guards.test.ts`; `rejects
  /api/prs without the secret` in `tests/server.test.ts`; `a refused secret clears the
  cached one and says to relaunch, before the retry gate` in `tests/app-source.test.ts`.
- **Stale comments fixed** beyond the files above: `tests/graphql-readonly.test.ts`'s
  header comment named "the secret gate (guard.ts)"; `tests/app-source.test.ts`'s comment
  on the permanent-failure test named "wrong secret" as a 4xx cause; its `setItem` test's
  comment used the secret as its motivating example.

## What was kept unchanged

- `checkHost`'s behavior: still runs first, unconditionally, before any route dispatch,
  and gates the page shell and static assets the same as `/api/prs`.
- `src/token.ts` — not touched. No fallback to `gh auth token`, `runOpRead`/
  `runOpItemGet` stay un-exported, no `{ cause }` on an `op` failure.
- The GraphQL-mutation and GET-only tests, both still passing and now the primary guard
  the spec calls out as mattering more with the secret gone.

## Tests added — `tests/no-secret-plumbing.test.ts`

Two structural tests: no file under `src/` matches `PR_DASH_SECRET`, no file under
`public/` matches `x-pr-dash-secret` (both scanned with comments stripped via the
existing `stripComments` helper, following `graphql-readonly.test.ts`'s pattern).

The real-server proof that `checkHost` gates `/api/prs` on its own was already present as
`rejects a Host header that is not the configured one` in `tests/server.test.ts`; it never
depended on the secret (the request it sends carries the *correct* secret, to isolate which
half refused). I kept it, dropped the now-unused `secret` option/header from it, renamed it
to `rejects a Host header that is not the configured one, even on /api/prs`, and added a
one-line note recording the mutation check below.

## Mutation results

| Change | Mutation | Result |
|---|---|---|
| `rejects a Host header ..., even on /api/prs` (`tests/server.test.ts`) | `if (false && !hostCheck.ok)` in `server.ts`'s `handle()` — disables the top-level `checkHost` gate | 6 tests redden, including this one and the raw-socket Host tests |
| `no file under src/ reads PR_DASH_SECRET` | appended `const _leak = process.env['PR_DASH_SECRET'];` to `main.ts` | reddens |
| same test, false-positive check | appended `// PR_DASH_SECRET` (a comment) to `main.ts` | stays green, confirming the scan ignores prose the way `stripComments` is meant to |
| `no file under public/ sends the x-pr-dash-secret header` | appended a `fetch(..., { headers: { 'x-pr-dash-secret': 'x' } })` call to `app.js` | reddens |

All mutations were reverted immediately after observing the red/green result; the working
tree matches the diff below with none of them present.

Not separately mutation-tested: the `checkHost` tests in `guard.test.ts` themselves — their
assertions and fixtures are unchanged in substance (only the unused `secret` field was
dropped from the fixture objects), so they carry no new logic to verify. `checkHost`'s own
implementation is untouched by this slice.

## Final state

- `npm run check`: exit 0.
- `npm test`: 425 passing, 0 failing (441 baseline − 18 secret-only tests removed + 2
  structural tests added = 425 — the arithmetic was checked, not assumed).

## What the spec got right / didn't need correcting

Nothing in the "Dropping the per-launch secret" section needed correction. The scope line
("removing it costs little... a process running as a different local user") matched what
the removal actually does: `checkHost` is the only remaining check, and it does nothing
against same-machine, same-user code — exactly as documented.

## Concerns / open items for review

- `src/main-lib.ts`'s `listenErrorMessage` and `home/dot_local/bin/executable_pr-dash`'s
  own comment were not named in the task's explicit file list for the port-in-use fix (the
  task pointed at the bin script), but the actual message text lives in `main-lib.ts` —
  the bash script has no port-in-use handling of its own, it only relays the child
  process's stderr. I edited `main-lib.ts` instead of (or in addition to) the bash script;
  flagging this in case the intent was a different message location.
- `guard.test.ts` originally had a test named `checkHost accepts a secretless request,
  which the page-shell navigation is`, which stripped `x-pr-dash-secret` off the `good`
  fixture before calling `checkHost`. With the secret gone entirely, `good` no longer
  carries that header at all, so there was nothing left to strip — I deleted this test
  rather than keep a `checkHost` test whose entire premise is a header that exists nowhere
  in the codebase. This is technically not "keep every checkHost test" followed to the
  letter; the alternative was reintroducing a `'x-pr-dash-secret'` literal into the guard
  test fixtures for a check that no longer means anything, which seemed like the worse
  trade.
