# Fix round: the whole-branch review of `worktree-pr-dash-always-on`

Six commits, one per group, on top of `f1c6066`. Measured in
`home/dot_local/share/pr-dash` at the end of the round: **477 pass / 0 fail**, no `not ok`
lines, `tsc --noEmit` exit 0. The baseline the brief recorded was 459 pass.

| Commit | Group |
|---|---|
| `f16ac29` | A — guards for four unpinned invariants |
| `ae693c5` | B — the restored payload paints on the launchd path |
| `4d0fda1` | C — the forced-fetch throttle and the token-failure negative cache |
| `9844740` | D — the plist moves to `scheduled/` and gains a lifecycle |
| `cb81c50` | E — three small ones |
| `7fa1b32` | F — the spec |

---

## Mutations run

Each mutated file was copied to `$TMPDIR/mut-backup` first, mutated, run, then restored with
`cp` and confirmed byte-identical with `diff`. No `git stash`, no reset, no index rewrite —
the index is shared with other worktrees. `git status` was clean after the last restore and
the tree ran 464 pass / 0 fail at that point.

### A1 — `main.ts` must not be able to log the credential

**Mutation a:** `console.error(await getToken());` inserted after the `getToken` declaration
at `src/main.ts:32`.
**RED — 464 tests, 463 pass, 1 fail:**

```
test at tests/startup-order.test.ts:158:1
✖ main.ts writes to stdout and stderr only at its four known call sites
  AssertionError [ERR_ASSERTION]: main.ts writes to stdout or stderr somewhere other than
  its four known call sites; under launchd that stream is a persistent log file
```

**Mutation b (the weaker variant):** `console.error(getToken);`.
**RED — 464 tests, 463 pass, 1 fail:** same test, same assertion.

**Discrepancy worth recording:** the brief and finding 1 both say `main.ts` has three
legitimate write sites. It has four. The fourth is the listen callback's
`console.log(\`pr-dash listening on http://127.0.0.1:${port}\`)` at `src/main.ts:77`. All four
are allowlisted by exact source text; a guard that failed on correct code would have been
worthless. The allowlist asserts each entry is still present before removing it, so a reworded
message fails the test rather than silently widening the scan.

### A2 — the idle window's scheduled delay

**Mutation a:** `}, timeoutMs);` → `}, 1);` in `createIdleExit` (`src/main-lib.ts`).
**RED — 464 tests, 462 pass, 2 fail:**

```
✖ the scheduled delay is the idle window, not just a constant declared alongside it
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  1 !== 1800000
✖ an injected timeoutMs is the delay actually scheduled
```

**Mutation b:** `opts.timeoutMs ?? IDLE_TIMEOUT_MS` → `opts.timeoutMs ?? 1_800`.
**RED — 464 tests, 463 pass, 1 fail:**

```
✖ the scheduled delay is the idle window, not just a constant declared alongside it
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  1800 !== 1800000
```

The second mutation leaves the injected-`timeoutMs` test green, which is correct: it asserts
the injected value reaches the timer, and the default is the other half.

### A3 — the guard's expected host

**Mutation:** `host: expectedHost(port),` → `host: '127.0.0.1',` at `src/main.ts:65`.
**RED — 464 tests, 463 pass, 1 fail:**

```
test at tests/startup-order.test.ts:178:1
✖ main.ts gives the server the guard expectation derived from the port it binds
  AssertionError [ERR_ASSERTION]: expected createServer's host to come from
  expectedHost(port), not a literal
```

### A4 — the `op` runners stay unexported

**Mutation:** `export ` added to both `runOpRead` and `runOpItemGet` in `src/token.ts`.
**RED — 464 tests, 463 pass, 1 fail:**

```
test at tests/token.test.ts:10:1
✖ the op runners stay unexported, so no other module can catch their rejections
  AssertionError [ERR_ASSERTION]: The input was expected to not match the regular
  expression /export\s+(async\s+)?function\s+runOp/.
```

`src/token.ts` is otherwise untouched, as the brief requires. The guard lives in
`tests/token.test.ts` and quotes the file's own comment as its reason.

### D3 — the plist's well-formedness and pinned values

**Mutation (three at once, as the reviewer ran it):** deleted `<key>RunAtLoad</key>` and its
`<true/>`, deleted `<key>ThrottleInterval</key>` and its `<integer>10</integer>`, and deleted
the closing `</dict>`.
**RED — 476 tests, 473 pass, 3 fail:**

```
test at tests/launch-agent.test.ts:92:1
✖ the plist template is well-formed XML
  Error: Command failed: plutil -lint .../scheduled/com.danielhunter.pr-dash.plist.tmpl
  .../scheduled/com.danielhunter.pr-dash.plist.tmpl: (Close tag on line 91 does not match
  open tag dict)

test at tests/launch-agent.test.ts:102:1
✖ ThrottleInterval is 10 seconds
  AssertionError: The input did not match the regular expression
  /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/

test at tests/launch-agent.test.ts:108:1
✖ RunAtLoad is true
  AssertionError: The input did not match the regular expression
  /<key>RunAtLoad<\/key>\s*<true\/>/
```

### E1 — the state directory's mode (not required by the brief, run anyway)

**Mutation:** `await fs.chmod(dir, DIR_MODE);` → `void 0;` in `payload-store.ts`'s `write`.
**RED — 477 tests, 476 pass, 1 fail:**

```
test at tests/payload-store.test.ts:328:1
✖ a state directory that already exists at a looser mode is tightened to 0700
  AssertionError [ERR_ASSERTION]: expected 700, got 770
```

---

## Group A — four guards

- `tests/startup-order.test.ts` gains the stdout/stderr scan (A1) and the `expectedHost`
  assertion (A3). The scan reuses `lazy-token.test.ts`'s regex shape,
  `/console\.\w+\s*\(|process\.(stdout|stderr)\.write\s*\(/`, and removes each allowlisted
  call site from the stripped source by its exact text before applying it. A string pattern in
  `String.prototype.replace` removes the first occurrence only, so a duplicated allowlisted
  line is still caught.
- `tests/idle-exit.test.ts`'s fake timer records `ms` on the handle (A2).
- `tests/token.test.ts` gains the export scan (A4), which also refuses
  `export { runOpRead }` as the trivially equivalent leak.

## Group B — the restored payload now paints

`withFallback` sets `primed = true` as the first statement of the returned function, before the
force check, and captures the prior value as `firstCall`. Ahead of the `fetching > 0` shortcut,
a non-forced first call with a retained payload starts `callLoad` unawaited and returns
`{ ...lastGood, stale: true, refreshing: true }`. `callLoad` is the old awaited body — the
`fetching += 1` / `try` / `catch` / `finally` block — extracted to a local function, so the
background fetch and the awaited path share one copy.

`fetching += 1` being `callLoad`'s first statement is load-bearing and verified by trace 1
below: an `async` function body runs synchronously to its first `await`, so the increment lands
before the prime path returns, and a request arriving behind it sees `fetching > 0`.

The four traces, each a test in `tests/refresh.test.ts`:

1. **Cold agent, restored payload, slow GitHub** — `the first request is answered from the
   restored payload while the fetch runs behind it`. The fetch's gate is still shut when the
   first call resolves, which is the assertion carrying the finding; `calls === 1` proves the
   fetch started. The second request takes the `fetching > 0` shortcut and returns the same
   payload with `calls` still 1. After the gate opens, a later request returns `stale: false`
   and the fresh rows.
2. **The background fetch fails** — `a failing background fetch does not start a second fetch
   on the next poll`. `lastGood` is unchanged (`fetchedAt` still `OLD`), the retained payload
   carries `error`, and `calls === 3` over three requests: one behind the prime, then exactly
   one per poll. Two per poll would be the 4xx retry storm this project has shipped once.
3. **First action is Refresh** — `a forced first call bypasses the prime path, and the next
   poll starts no extra fetch`. The forced call waits for GitHub (`stale: false`,
   `refreshing: undefined`), and the following poll leaves `calls === 2`, not 3.
4. **First-ever launch, nothing restored** — `a first-ever launch with nothing restored still
   waits for the fetch`. The call has not settled after a full microtask drain, and resolves
   only once the gate opens. Unchanged behaviour.

Five existing tests moved, because a response that deliberately does not wait for the fetch
cannot report that fetch's outcome:

- `a seeded payload is served, marked stale, when the first fetch fails` now asserts the prime
  response carries no `error`, then asserts the error on the next request.
- `a successful fetch replaces the seeded payload` reads `OLD` from the prime call and lets the
  fetch behind it land before the failing call that proves the replacement.
- `createLoadPrs forwards its opts`, `the shortcut closes once the fetch settles` and `the seed
  served mid-fetch is not recorded as a success` gained a `setTimeout(0)` drain so the
  background fetch settles before the assertion. Two of them passed without it by luck of
  scheduling; a drain makes them deterministic.
- `a request arriving during an in-flight fetch is served the seed at once` was rewritten as
  trace 1, which covers the same shortcut rather than duplicating it.

Both prose claims are corrected: `src/main.ts`'s pre-load comment and the spec's "The pre-load
becomes opt-in", each naming the prime path and its flag so a reader who removes it knows what
they are removing.

## Group C — the two bounds

**C1.** `FORCE_MIN_INTERVAL_MS = 10_000`, exported from `main-lib.ts`. `withFallback` takes an
injectable `now` (defaulting to `Date.now`) on `FallbackOpts`. A force inside the interval is
downgraded, not rejected: it is forwarded as `{ ...loadOpts, force: false }`, reads the cache
and answers promptly. An allowed force is forwarded unchanged, so an ordinary poll still
reaches `load` with exactly what it arrived with. The first force of a process is never
throttled — the bound is on the interval between them.

The three tests assert the effect rather than a stub: they wrap the real `createCache` and
count `invalidate` calls, which is what a forced fetch does before reaching GitHub. One force
invalidates; a second one second later does not; one eleven seconds later does.

**C2.** `TOKEN_FAILURE_TTL_MS = 5_000`. `createLazyToken` takes an injectable `now` and
retains `{ error, at }` on rejection. The check sits after `cached` and `pending`, so a
resolved token can never be shadowed by an earlier failure — which is why nothing clears
`failure` on the success path, and the comment says so rather than adding an unreachable
assignment.

The invariant still holds and its test still pins it: `a rejected resolution is not cached, so
the next call tries again` now advances an injected clock past the TTL, because a retry with
the real clock is inside the TTL by construction. Same for `two concurrent callers who both hit
a rejection see the same error, and both retry after`. Two tests were added: a retry inside the
TTL rethrows with `calls === 1`, and a success after a failure is what later calls see.

`src/token.ts` is untouched and the client's 4xx/5xx classification is unchanged.

## Group D — the agent's home and its lifecycle

**Why `scheduled/`.** `README.md:31-34` and
`scheduled/com.daniel.claude.changelog-watch.plist.tmpl`'s header record the convention:
launchd job definitions live in `scheduled/`, outside `home/`, are not deployed by
`chezmoi apply`, and document their own activate and deactivate commands. The README's stated
reason is the work overlay's `catch-up.sh`, which globs `~/Library/LaunchAgents` — and that
reason does not apply to `com.danielhunter.pr-dash`, which the script skips on two independent
counts. The decisive reason is a different one: **launchd reads a plist only at bootstrap.** An
auto-deployed plist means `chezmoi apply` rewrites the file while the loaded job keeps the old
definition, so a port or path change looks applied and is not. Keeping the file out of
`~/Library/LaunchAgents` makes re-activation an explicit step instead of a silently skipped
one.

Done:

- `git mv home/Library/LaunchAgents/com.danielhunter.pr-dash.plist.tmpl scheduled/`, and the
  now-empty `home/Library/` removed.
- `home/dot_local/state/private_pr-dash/.keep` deleted. The activate block creates the log
  directory instead. Runtime state is not config, and this removes chezmoi as the manager of a
  directory holding private PR titles.
- `home/.chezmoiignore` loses the `Library/LaunchAgents` line and its comment; the file is
  outside `home/` now, so there was nothing left to ignore. The systemd comment's claim that
  "the launchd equivalents live outside the source tree entirely" is left standing, and this
  move is what makes it true.
- `README.md` unchanged. Its `scheduled/` bullet already describes the convention correctly;
  the reason it gives is one of two valid reasons rather than a wrong one.
- The plist header follows the changelog-watch header's shape and voice, and carries: that it
  is a definition only and a template because launchd expands nothing in a plist; activate
  (`mkdir -p -m 700`, `chezmoi execute-template`, `launchctl bootstrap`) with why the `mkdir`
  is there; deactivate, naming what the operator loses; reload as its own block with the
  bootstrap-only reason; check (`launchctl print`, `tail -f`); and that a change to the
  `/api/prs` response shape needs the reload rather than a wait for the idle exit.
- `tests/launch-agent.test.ts` points at the new path, its `REPO_ROOT` comment now says "the
  root that contains both `home/` and `scheduled/`", and it gains four assertions: `plutil
  -lint` on the `.tmpl` source through `execFileSync` (guarded on `process.platform ===
  'darwin'`, skipped otherwise), `ThrottleInterval` is 10 with the reason in its comment,
  `RunAtLoad` is `<true/>`, and the activate block's `mkdir` path and mode derived from
  `DEFAULT_STATE_DIR` and `DIR_MODE` rather than written as literals.

**D4 — the launcher's probe.** `bin/pr-dash` gains a `serving()` function that probes
`/api/prs` and discriminates on the response shape rather than accepting any 2xx:

- **200** must contain `"partialErrors"`. The property relied on: `PrsResponseBody` in
  `src/server.ts` is `Omit<Required<Awaited<ReturnType<ServerOpts['loadPrs']>>>, 'error'> &
  {...}`, so `tsc` refuses a response literal that omits it.
- **500** must contain `"error"`, which is all `createServer`'s catch-all produces. This is
  why a failed token resolution still counts as proof that pr-dash holds the port — the probe
  depends on neither GitHub, nor `op`, nor a warm cache.
- Any other status is not pr-dash. `curl -f` is deliberately absent, since it would discard
  the 500 body.

No `/healthz` route was added. The function stays before the `trap`, for the reason the
existing comment gives. The readiness loop at what was line 42 now uses `$URL` rather than
spelling the URL a third time.

`bash -n` and `shellcheck -s bash` are both clean on the script. There is no shell test harness
in this package, so the probe was exercised by a scratch script in the session scratchpad
against four fake servers on a spare port — pr-dash's own 200 body and its 500 body both read
as pr-dash; an unrelated server's `{"ok":true,...}` 200, a 404, and nothing listening all read
as not pr-dash. That was a check while working, not a test promoted into the suite.

**D5.** `home/.chezmoiignore` gains `.local/state`, next to the `.claude/artifacts` entry and
in its voice, with a comment naming `last-payload.json` and `agent.log`, what they carry, and
why no secret scanner would object. Verified read-only afterwards: `chezmoi managed --source
home` lists neither `Library/LaunchAgents` nor `.local/state` (0 matching lines). No
`chezmoi apply` was run.

`payload-store.ts:15-17`'s claim — "Outside chezmoi's managed tree, so it can never reach the
source repository" — was re-read and is true as written now that the `.keep` is gone, so it is
left alone.

## Group E

- **E1:** `fs.chmod(dir, DIR_MODE)` after the `mkdir`, with `chmod` added to `FsSeam` and to
  `realFs` and the in-memory fake. Test pre-creates the directory at 0770 under `$TMPDIR` and
  asserts 0700 after a write; mutation recorded above.
- **E2:** `opts.exit ?? ((code: number) => process.exit(code))`.
- **E3:** `isPermanentFailure`'s doc comment corrected. It now says what a 4xx names with the
  per-launch credential gone (a caller that is not this page — the page's own origin is by
  construction the expected authority), and records that the 500 from a failed token
  resolution takes the transient branch deliberately, because a locked vault clears when the
  operator answers the next prompt. The classification is unchanged. Checked first that no test
  asserts that comment's prose: `render-guards.test.ts` asserts the function's return values,
  `app-source.test.ts` asserts the call site. `npm run check` re-run after the `public/` edit.

## Group F — the spec

Both gaps closed under a new "Two properties this argument has to name": version control as an
egress path, with D5's `.chezmoiignore` entry and the plist's location outside `home/` as the
mitigations; and the confused-deputy property, with `FORCE_MIN_INTERVAL_MS` recorded as the
bound and `TOKEN_FAILURE_TTL_MS` as the bound on the prompts.

"the port is effectively always held" is softened in "Why not socket activation" and points at
the respawn gap. Five bullets join **Deferred**: the respawn gap, the foreground run that
wedges the agent, the unrotated `agent.log`, the credential-failure poll with both rejected
alternatives, and the fnm node path on a machine without fnm. "The launchd agent" is amended to
match D1.

Finding 18's third gap — recording the 1Password item's token scopes — is deliberately not
written, since the brief does not ask for it and the scopes cannot be verified from here.

## Verification

In `home/dot_local/share/pr-dash`:

```
$ npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)|^not ok'
ℹ tests 477
ℹ pass 477
ℹ fail 0

$ npm run check
> tsc --noEmit
(exit 0)
```

The moved plist renders and lints:

```
$ chezmoi execute-template --source . \
      < scheduled/com.danielhunter.pr-dash.plist.tmpl > "$TMPDIR/rendered.plist"
$ plutil -lint "$TMPDIR/rendered.plist"
/tmp/claude-501/rendered.plist: OK
```

`{{ .chezmoi.homeDir }}` expands in the render — `ProgramArguments` reads
`/Users/daniel/.local/share/fnm/aliases/default/bin/node` and
`/Users/daniel/.local/share/pr-dash/src/main.ts`, and both log paths read
`/Users/daniel/.local/state/pr-dash/agent.log`. No `plutil -extract` was used, so nothing was
rewritten in place.

The repo-level suites that parse `home/.chezmoiignore` were run, because this round edits that
file: `tests/terminal/warp-tab-config-gate.test.js`,
`tests/terminal/warp-macos-paths.test.js`, `tests/terminal/ghostty-config.test.js`,
`tests/chezmoi/managed-test-drift.test.js`, `tests/sudo-shim.test.js`,
`tests/tmux/tmux-askpass.test.js` and `tests/install/workstation-defaults.test.js` — 57 tests,
40 pass, 0 fail (the rest skip off their host).

`tests/scheduled-launchd.test.js` enumerates `scheduled/*.plist.tmpl` and asserts properties of
every file it finds, so moving the plist into that directory put it under four checks this
round did not write: the render is well-formed XML, the body after the DOCTYPE contains no
`/Users/` literal, `Label` equals the filename stem, and every `ProgramArguments` path under
`$HOME` that resolves to `~/.local/bin/` has a source in this repo. It passes — 6 tests, 6
pass, 0 fail — with `com.danielhunter.pr-dash.plist.tmpl` in the enumerated set of four. The
Label check is the one that could have caught a rename: `com.danielhunter.pr-dash` matches its
stem, so finding 17's naming drift against the `com.daniel.claude.*` neighbours is a
convention question and not a test failure.

Not run, per the brief: `launchctl`, `chezmoi apply`, `bin/try`, `bin/land`, the network, `op`.
The whole repo suite was not re-run; the findings report measured 11 environmental failures
there before this round, none of them in pr-dash's tree, and the eight suites above are the
ones this round's edits could reach.

## Concerns

- **The prime path changes what the first `/api/prs` of a process returns**, whenever a payload
  was restored. It is `stale: true, refreshing: true` where it used to be a fresh fetch. The
  client already handles that response — it is the same shape the `fetching > 0` shortcut has
  always produced, and `refreshing` is what makes the page poll — but this is a behaviour
  change on the foreground `pr-dash` path too, not only under the agent. On that path the
  pre-load is the first call, so the pre-load now takes the prime path and its fetch runs
  behind a response nobody reads; `startPreload`'s `onError` consequently never fires when a
  payload was restored, which its own doc comment already describes as the intended behaviour
  for a seeded loader.
- **`FORCE_MIN_INTERVAL_MS` is a per-process bound, not a per-machine one.** A caller that can
  make the agent exit and respawn resets it. Nothing in this round addresses that, and an idle
  exit needs 30 minutes of quiet, so the practical bound holds.
- **The plist's activate block is now the only path to a running agent**, and nothing verifies
  it was run. A machine that applies this repo and never bootstraps the job gets
  ERR_CONNECTION_REFUSED on the bookmark with `pr-dash` in a terminal as the only fallback.
  That is the convention's deliberate trade, but it is worth stating that the reverse state
  (deactivate) is documented while the forward state is not automated.
- **Finding 21 — no operator-facing document** — is untouched, as is finding 17's label naming
  drift. Both are outside this brief.
- **`agent.log` rotation** is recorded as accepted in Deferred rather than fixed.
