# 2026-08-06 — config audit: what landed, and what is still open

Session record for a state-and-test audit of this repo and `~/work-laptop-config`. Filed at
`docs/` root rather than under `specs/`, `plans/` or `decisions/`: it is none of those three —
not a design, not an implementation plan, and the individual decisions inside it are all
cheaply reversible, so they miss the ADR bar in `docs/README.md`.

This is **not** the `/handoff` skill's artifact. That skill is reserved for explicit
invocation; this is a plain record written on request.

## What the audit was asked to do

Check both repos for uncommitted work, run their test suites, and take a deliberate pass for
*silent* failures — things that read as green without being green. The silent-failure half is
where everything interesting came from.

## Landed

| PR | Repo | What |
|---|---|---|
| [#271](https://github.com/DanielH2018/dotfiles/pull/271) | dotfiles | Test-gate honesty: agentview host gate, `TQ_OFF` leak, flock skip reason, gh sandbox carve-out, reparse-veto word boundaries, mx-ergo `sed -i` |
| [#275](https://github.com/DanielH2018/dotfiles/pull/275) | dotfiles | ssh client config sandbox carve-out |
| [#277](https://github.com/DanielH2018/dotfiles/pull/277) | dotfiles | Recover 24 tool-gated skips; fix the 5 failures they hid |
| [#4](https://github.com/DanielH2018/work-laptop-config/pull/4) | work-laptop-config | Pre-push signature gate; stop the smoke test clobbering a live PCI control |
| [#5](https://github.com/DanielH2018/work-laptop-config/pull/5) | work-laptop-config | Unit tests for the sandbox Snowflake auth script; `mktemp` portability fix |

Both repos are level with `origin/main` and `chezmoi status --exclude=scripts` is empty.

## The one finding worth carrying forward

**Four separate bugs this session came from assuming GNU behaviour on a BSD userland.** All four
were invisible on the Linux hosts where the code was authored, and all four surfaced only on
macOS:

| Where | Symptom |
|---|---|
| `executable_block-dangerous-bash.sh` — `BDB_REPARSE` | `\b` is not an ERE word boundary in Darwin's libc, so the whole interpreter-name alternation never matched. The re-parse veto was dead and `bash -c "echo a; terraform apply"` stopped denying. A live bypass in a security control. |
| `tests/mx-ergo-resync.test.js` — stub solaar | Bare `sed -i "script"` is GNU-only; BSD reads the next argument as the backup suffix, errors, and changes nothing. Writes appeared not to take, so the script correctly reported six unapplied settings and the test blamed the script. |
| `configure-snowflake-auth.sh` — browser shim | `mktemp` template with `.sh` after the X's. BSD requires them trailing, so the file was never created and the SSO login broke rather than degraded. Worked only because gnubin puts GNU `mktemp` first. |
| new test harnesses | `stat`'s mode flag and `date`'s relative-time flag differ. Handled defensively (try one, fall back). |

Two consequences worth acting on:

1. `~/.claude/CLAUDE.local.md` states that GNU coreutils are first on PATH so GNU flag syntax
   works. **That does not hold inside a test's own PATH**, and `sed` is not coreutils anyway.
   The claim is load-bearing — it is why these forms keep getting written — and should be
   narrowed to say it applies to interactive shells only.
2. A cheap lint rule would catch the next one: flag bare `sed -i "` (needs `-i.bak`), `\b`
   inside a bash `[[ =~ ]]` (grep is fine, the two engines differ), and `mktemp` templates with
   anything after the X's.

## Silent-failure patterns found

Recorded because each one reads as passing:

- **Skips hiding failures.** Installing `gawk`/`flock` recovered 24 tests and immediately exposed
  **5 that had been failing all along** — fixture repos committing without disabling signing, so
  each commit waited on a 1Password approval no test can give (28–60s, then error). The totals
  looked identical either way.
- **A gate step degrading to a no-op.** `.githooks/pre-push` prints
  `lint … prek not installed, skipped` and still passes. Same shape as `tq` falling back when
  python3 is absent. Confirm the tools are present before trusting a green gate.
- **A guard silently inert.** `executable_chezmoi-apply-guard.sh` runs
  `chezmoi status 2>/dev/null || exit 0`. Inside the sandbox, `chezmoi` aborted on a managed file
  it could not read, so the guard stopped guarding — and an empty parse of an aborted command is
  indistinguishable from "no drift". Fixed by the two `allowRead` carve-outs, verified by
  `chezmoi status` returning 0 with no error under the sandbox.
- **A non-executable hook.** Git skips a hook that is not executable with only a hint on stderr,
  and the push succeeds. The signature gate shipped that way for its first few minutes;
  `test-install.sh` now asserts the bit.
- **`--no-verify` was never used.** Every land went through the full gate.

Also worth knowing for anyone reproducing a run: the Bash sandbox turned 36 failures into noise
(denied `mktemp`, denied tmux sockets) where the real count was 4 — the gate runs unsandboxed, so
sandboxed numbers are not the gate's numbers. And in zsh an unquoted `$TEST_FILES` does not
word-split, so `node --test $TEST_FILES` passes all 158 paths as one argument; use `bash -c`.

## Still open

1. **19 pty skips are permanent on macOS.** brew's `util-linux` omits `script(1)` because the
   base system ships BSD `script`. No install fixes it. Decide whether to build it from source
   or gate those tests to Linux outright, so the number stops reading as a recoverable gap.
2. **Two unsigned commits are published** on work-laptop-config `main` (`ea6fa1f`, `81a75ec`).
   Left alone deliberately — re-signing means rewriting shared history. The new gate stops the
   next one *from this machine* — see the CI item below.
3. **Neither repo has CI.** No `.github/workflows` in either. Every gate above — signatures,
   soak, quality, lint, the unit suite — is a *local* pre-push hook. Two consequences: a fresh
   clone that never runs `install.sh` or never sets `core.hooksPath` has **no gate at all**, and
   nothing server-side notices. Given that commits during this session arrived from a second
   machine, the signature gate's real coverage is "whichever machines happen to have it
   installed". Branch protection, or a CI job that reruns `check-push-signatures`, would close
   that; a local hook cannot.
4. **Tool-absent gate steps degrade to a skip, not a failure.** `.githooks/pre-push` prints
   `lint (ruff + shellcheck) - prek not installed, skipped` and still exits 0, and `tq` falls
   back to the raw runner when `python3` or `tq` is missing. Both are deliberate — a missing local
   tool should not block a push on a machine that never installed it — but the effect is a green
   gate that checked less than it appears to. Worth folding the degradation into the final verdict
   line, so it reads "passed, 1 step skipped" rather than "passed".
5. **Converge the fixture-isolation convention.** Two coexist. Five files
   (`tests/sandbox/*.test.js`, `tests/tmux/ctw.test.js`) set
   `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_SYSTEM=/dev/null`, cutting fixtures off from the
   machine's config entirely — signing, hooks, templates, identity, aliases. The five fixed in
   [#277](https://github.com/DanielH2018/dotfiles/pull/277) use per-repo `commit.gpgsign false`,
   following `tests/bin/try.test.js`. **The env-var form is the stronger one** and would have made
   this whole class impossible; the fix that landed removes the symptom only. Evidence for
   preferring it: those five isolated files run 108 tests in 6.7s with no signing stalls.
6. **Of the 127 skips, only ~11 are addressable.** The rest are structural here — Linux-only
   scripts, WSL-only paths, Windows-only config, darwin-branch-renders-empty, host-conditional
   config that renders empty, and the 19 `script(1)` tests above. The skip count is not a
   to-do list and treating it as one wastes time. The addressable set:
   - **10 tests behind `UI_TIER_B=1`** — an opt-in env gate, never exercised this session, so
     nobody has confirmed they still pass.
   - **1 live integration test** needing `daniel-box` and `daniel-server` — never runs locally.
7. **`agentview-dwell-log.test.js` is still flaky** — one-second boundary (`'43' !== '42'`). It
   blocked one land attempt and passed on retry, *after* `31db88a` had already landed a fix for
   it. Passes 3/3 in isolation, fails only under parallel load. It will block a land again.
8. **agentview is deployed but inert on macOS.** `~/.claude/hooks/agent-view-state.sh` and
   `~/.local/bin/agentview` are both deployed and executable here, yet a rendered `settings.json`
   wires **zero** `agent-view-state` hooks on darwin and `~/.claude/agent-view` has never held
   state. `executable_agentview:190` says a Darwin branch there would be dead code — the right
   call, but the binary ships to macOS anyway. Consider `.chezmoiignore`-ing it for darwin so dead
   code is not deployed. This is why `settings-base-shape.test.js:205` needed a host gate rather
   than a config fix.
9. **Landing can still race another machine.** `bin/land` reported
    `flock unavailable — landing without the cross-worktree lock` and `origin/main` moved under it
    mid-attempt, three times. `flock` is now installed, restoring the lock *locally* — but the
    commits came from a second machine, which no file lock can serialize. If it recurs the fix is
    coordination, or the CI item above, not the lock.
10. **Correct the `CLAUDE.local.md` PATH claim** — see the GNU-on-BSD section above. It is the
    reason these forms keep being written.
11. **This doc is the durable record.** The audit's working artifacts are in
    `~/.claude/artifacts/` (`repo-test-audit-2026-08-06.md` and `.html`), which is **not**
    chezmoi-managed and is pruned after 7 days without an update. Anything there worth keeping
    should move here.

## Re-establishing state

```sh
# both repos clean and level with origin
git -C ~/.local/share/chezmoi status -sb
git -C ~/work-laptop-config status -sb

# deployed state matches source (empty output = no drift)
chezmoi status --exclude=scripts

# the gate's steps 2-5. Step 1 (signatures) self-skips here: it reads git's pre-push protocol
# from stdin, so only a real push exercises it. Run from bash — in zsh an unquoted $TEST_FILES
# does not word-split and node sees one giant argument.
cd ~/.local/share/chezmoi && .githooks/pre-push </dev/null

# work-laptop-config's two suites
cd ~/work-laptop-config && ./test-install.sh && ./test-snowflake-auth.sh
```

Baseline at the end of this session: **1917 tests, 0 failing.** Skips are 127 with `gawk` and
`flock` on PATH (a fresh interactive shell), or ~144 without — the difference is the flock-gated
set, and it is the reason the number moves between runs.
