# Slice 3 report: the launchd agent, the opt-in pre-load, and a launcher that defers to it

Worktree: `/Users/daniel/.local/share/chezmoi/.claude/worktrees/pr-dash-always-on`
Package: `home/dot_local/share/pr-dash`

## Baseline

I did not run the suite before making any edits, so I cannot independently confirm the
brief's stated 446-passing baseline. The first count I actually measured was 453 passing,
0 failing, taken right after Task 1's tests were added and its fix applied (7 new tests
over whatever the pre-slice-3 count was). `npm run check` was clean (exit 0) at every point
I ran it, including that first measurement.

## Task 1 — `preloadEnabled(env)`, and gate `startPreload` with it

Added `preloadEnabled(env: NodeJS.ProcessEnv): boolean` to `src/main-lib.ts`, returning
`env['PR_DASH_PRELOAD'] === '1'` with a doc comment on the strict, exactly-`'1'` contract.
`src/main.ts` now imports it and wraps the existing `startPreload(...)` call:

```ts
if (preloadEnabled(process.env)) {
  startPreload(loadPrs, (message) => {
    console.error(`pr-dash could not pre-load PRs (the page will retry): ${message}`);
  });
}
```

The comment above the call is rewritten to explain why the pre-load is opt-in (nothing left
to overlap under launchd, and an unconditional pre-load would prompt for Touch ID at every
respawn), naming `bin/pr-dash` as the one caller that sets the variable.

**Pre-fix failure, as required by the brief.** The structural test
(`tests/startup-order.test.ts`, `'startPreload is called only inside a block guarded by
preloadEnabled'`) was written and run against the unguarded `main.ts` before the fix landed:

```
✖ startPreload is called only inside a block guarded by preloadEnabled (0.234708ms)
  AssertionError [ERR_ASSERTION]: expected `if (preloadEnabled(` in main.ts
```

It uses `strip-comments.ts` and `brace-block.ts` the way the neighbouring tests in that file
do: it finds the `if (preloadEnabled(` line, takes its balanced brace block, and asserts
`startPreload(` is inside that block — not merely that both identifiers appear somewhere in
the file.

Unit tests for `preloadEnabled` itself went into `tests/startup.test.ts`, alongside the
other main-lib.ts startup decisions it already covers: one test for `'1'` returning `true`,
and a looped test over `undefined`, `''`, `'0'`, `'true'`, `'yes'` all returning `false`.

Commit: `dc61383`.

## Task 2 — `bin/pr-dash` sets the variable and defers to a running agent

`home/dot_local/bin/executable_pr-dash`:

- Sets `export PR_DASH_PRELOAD=1` alongside the existing `PR_DASH_PORT` export, with the
  comment from the brief explaining why this path still benefits from the overlap.
- Hoisted the single `URL="http://127.0.0.1:${PORT}/"` assignment to before the new probe,
  and removed the old second assignment near the end — `URL` is now assigned exactly once
  and reused at the `open` call.
- Added the port probe *before* the `trap` and the `node ... &` invocation: if `curl -fs`
  already gets an answer, it prints a message, opens the browser, and exits 0 without ever
  starting a server or setting the trap. This ordering is required under
  `set -euo pipefail` — a trap referencing `SERVER_PID` would itself error if it ran before
  `SERVER_PID` is assigned.
- Corrected the stale comment about the server resolving its token through 1Password before
  listening (true before slice 2, not since); it now attributes the 60-second deadline to
  process start plus the payload-store read.
- Left `listenErrorMessage`'s `EADDRINUSE` branch and its tests in `src/main-lib.ts` alone,
  per the brief — that message is still reachable in the race where a foreground run wins
  the probe and then loses the bind to the agent restarting.

No test, per the brief: this repo has no shell test harness, and building one wasn't asked
for. Verified with `bash -n` (syntax OK) and `shellcheck` (clean, exit 0), plus a full
read-through of the resulting script.

Commit: `224035a`.

## Task 3 — the launchd agent

- **`home/Library/LaunchAgents/com.danielhunter.pr-dash.plist.tmpl`** — a chezmoi template
  using `{{ .chezmoi.homeDir }}` for every absolute path, matching the brief's structure
  exactly (tab-indented, same key order). The four load-bearing values each carry an XML
  comment: `KeepAlive` staying bare `<true/>` (never a `SuccessfulExit` dict), `PATH`
  naming `/opt/homebrew/bin` for `op`, `node` reached through fnm's `aliases/default`
  symlink, and `ThrottleInterval: 10` naming launchd's own default explicitly.

  Rendered and linted:

  ```
  $ chezmoi execute-template < home/Library/LaunchAgents/com.danielhunter.pr-dash.plist.tmpl > $TMPDIR/pr-dash-agent-final.plist
  $ plutil -lint $TMPDIR/pr-dash-agent-final.plist
  /tmp/claude-501/pr-dash-agent-final.plist: OK
  ```

  The rendered output substitutes `/Users/daniel` for `{{ .chezmoi.homeDir }}` and is
  otherwise byte-identical between the pre- and post-mutation-check renders.

- **`home/dot_local/state/private_pr-dash/.keep`** — an empty file (0 bytes), so chezmoi
  creates `~/.local/state/pr-dash/` at mode 0700 (matching `payload-store.ts`'s
  `DIR_MODE`) ahead of the agent's first launch on a fresh machine.

- **`home/.chezmoiignore`** — added `Library/LaunchAgents` to the existing
  `{{ if ne .chezmoi.os "darwin" }}` block, with a one-line comment that launchd is
  macOS-only. Confirmed the block is skipped on this (darwin) host by rendering the file
  with `chezmoi execute-template` and seeing neither `Brewfile` nor `LaunchAgents` in the
  output.

- **`home/dot_local/share/pr-dash/tests/launch-agent.test.ts`** — reads the plist *source*
  template and `bin/pr-dash`'s source as plain text; never calls `launchctl`, `chezmoi`, or
  `op`, and never spawns a process. `REPO_ROOT` is derived once from `import.meta.dirname`
  with a comment stating it is four levels above the package root. Six tests:
  1. The plist's entry point (`.local/share/pr-dash/src/main.ts`) matches the same
     `src/main.ts` suffix `bin/pr-dash` runs, both derived from one `ENTRY_POINT` constant.
  2. `PR_DASH_PORT` is extracted from both files by regex and compared to each other — no
     literal `8770` is written twice in the test.
  3. `KeepAlive` is followed by `<true/>`, and there is no `<key>SuccessfulExit</key>` node.
     (Not a bare `!includes('SuccessfulExit')` — the plist's own explanatory comment
     legitimately contains that word, so the check matches the real XML key tag only. This
     was caught by running the test before restoring the comment-only check: see mutation
     notes below.)
  4. `PATH` contains `/opt/homebrew/bin`.
  5. `Label` is `com.danielhunter.pr-dash`.
  6. `StandardOutPath`/`StandardErrorPath` match `DEFAULT_STATE_DIR` (imported from
     `src/payload-store.ts`, not repeated as a literal) plus `/agent.log`.

Commit: `a823901`.

## Mutation checks

Each mutation was applied by hand, run, confirmed red, then reverted — confirmed identical
to the pre-mutation file with `diff` after each restore.

| Mutation | Result |
| --- | --- |
| Task 1: removed the `if (preloadEnabled(...))` guard, called `startPreload` unconditionally | `startPreload is called only inside a block guarded by preloadEnabled` → red |
| Task 3 #1: pointed the plist's `ProgramArguments` at `src/server.ts` instead of `src/main.ts` | `the plist runs the same entry point bin/pr-dash runs` → red |
| Task 3 #2: changed the plist's `PR_DASH_PORT` to `9999` | `the plist and bin/pr-dash agree on the default port` → red |
| Task 3 #3: replaced `KeepAlive`'s bare `<true/>` with a `<dict><key>SuccessfulExit</key><false/></dict>` | `KeepAlive is bare <true/>, with no SuccessfulExit override` → red |

One extra defect surfaced and fixed during this pass, not one of the four required
mutations: the first draft of the `KeepAlive`/`SuccessfulExit` test used
`!plistText.includes('SuccessfulExit')`, which also fires on the plist's own required
explanatory comment (which has to name `SuccessfulExit` to say why it isn't used) and on
this test file's own comment describing the check. Tightened to match the literal
`<key>SuccessfulExit</key>` tag instead.

## Verification

```
$ npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'
ℹ tests 459
ℹ pass 459
ℹ fail 0

$ npm run check
> check
> tsc --noEmit
```

No `not ok` lines in the `npm test` output. 459 passing / 0 failing: 453 after Task 1's 7
new tests (the first count I measured, per the note above), 459 after Task 3's 6 more —
Task 2 added no tests, per the brief.

## Concerns and remaining steps

- **Not run, per the brief's explicit instruction:** `launchctl bootstrap`/`load`,
  `chezmoi apply`, `bin/try`, `bin/land`. Installing the agent in the operator's live
  session, and applying this branch, are left for the operator to do by hand.
- **Deferred build/restart gap, already named in the spec, not addressed here:**
  `chezmoi apply` while the agent is running serves new static assets immediately but old
  server code until the next idle exit (up to 30 minutes). Acceptable per the spec's
  "Deferred" section; flagged here only so it isn't mistaken for an oversight.
- The plist's `StandardOutPath`/`StandardErrorPath` point at
  `~/.local/state/pr-dash/agent.log`, a single shared file for both stdout and stderr — this
  matches the brief's exact literal instruction and is not something I changed, but it means
  the log interleaves normal listen messages with error output. Worth knowing if the log is
  ever parsed rather than just read.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
