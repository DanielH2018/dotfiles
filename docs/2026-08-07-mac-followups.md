# 2026-08-07 — follow-ups that can only be done on the Mac

Companion to [`2026-08-06-repo-audit-handoff.md`](2026-08-06-repo-audit-handoff.md), which is the
backward-looking record of what the audit found. This file is the forward-looking task list, and
it is separate for one reason: every item below is blocked on *being on the Mac*. That doc says
what happened; this one is a checklist for a different machine.

Written from the Fedora box. The session that wrote it could not run a single item here.

## How to read the stamps

| Stamp | Means |
|---|---|
| **VERIFIED-LINUX** | Ran green on Fedora. The Mac run is a portability check, not a re-test. |
| **UNVERIFIED-ANYWHERE** | Written on Linux, never executed on a BSD userland. The Mac is the first real test. |
| **MAC-ONLY** | The inputs exist only on the Mac. Linux cannot attempt it. |
| **DECLINED** | Deliberately not done. Do not re-open without asking — see the reason. |

## What landed on 2026-08-06

Two dotfiles PRs, both merged:

- **[#282](https://github.com/DanielH2018/dotfiles/pull/282)** — commits `fba12c7`, `1b0eec5`,
  `7a4a1a2`. Frozen clock in the dwell-log fixtures, the BSD-portability linter, and that
  linter's own scratch cleanup.
- **[#283](https://github.com/DanielH2018/dotfiles/pull/283)** — commits `976f354`, `dfb9a6c`,
  `117b105`. The audit record itself, plus a correction to its `31db88a` claim.

**Do not anchor to a tree description.** `main` was `117b105` when these landed and was already
`0e2f798` the next morning; other sessions land on it several times a day. Rebase and re-verify
rather than trusting anything here about the shape of the tree. The six SHAs above and the two PR
numbers are the stable references.

---

## 1. Run the gate on macOS — UNVERIFIED-ANYWHERE

```sh
cd ~/.local/share/chezmoi && git fetch origin && git merge --ff-only origin/main
bash .githooks/pre-push </dev/null; echo "GATE_EXIT=$?"
```

Linux baselines, both from 2026-08-06 at `117b105`:

| Checkout | Result | Skipped |
|---|---|---|
| primary | 1923/1948 | 25 |
| worktree | 1917/1948 | 31 |

The audit measured roughly **127** skips on macOS. **The comparison is the diagnostic, not the
absolute number** — a macOS run in the same ballpark as 127 is fine, one that suddenly matches
Linux's 25 means host detection broke and tests are running that should not be.

## 2. Self-test `bin/lint-bsd-portability` on a BSD — UNVERIFIED-ANYWHERE

The headline item, and the one with the most embarrassing failure mode: **a linter that exists
only to catch macOS bugs, written and verified exclusively on Linux.** If it is broken anywhere,
it is broken on the only platform it was built to protect.

Two separate risks. Check both.

**(a) Does the script itself run under macOS `/bin/bash` 3.2?** It was scanned on Linux for
bash-4-isms — `mapfile`, `readarray`, `declare -A`, `${v,,}` — and has none. That scan is not a
substitute for running it:

```sh
bin/lint-bsd-portability; echo "LINT_EXIT=$?"
```

**(b) Do its three EREs fire the same way under BSD awk as under GNU awk?** This is the real
risk — interval expressions and character classes differ between the two. The suite pins each
rule against the actual pre-fix blob from history (`979b240^`, `25cc7e8^`, `6ebdaa4^`), with the
current `block-dangerous-bash.sh` as a must-stay-clean discriminator, so one command answers it:

```sh
node --test tests/lint-bsd-portability.test.js
```

15 tests. All 15 pass on Linux. **If any fail on macOS, the linter is the bug** — fix the awk,
not the fixtures. The fixtures are historical fact.

## 3. Delete four unmanaged orphans — MAC-ONLY

`#282` added a `darwin` block to `home/.chezmoiignore`. Ignoring stops *future* applies; it does
not remove what is already deployed, and this repo has no `.chezmoiremove` (deliberately — an
untemplated one is unconditionally destructive on every machine). So the Mac has four orphans
that nothing will ever clean up.

**The path list in the comment above that block in `home/.chezmoiignore` is the source of
truth** — read it there rather than from a copy that can drift. All four were confirmed
`chezmoi managed` on Linux on 2026-08-07, so all four are real files on the Mac, not phantoms.

Note `.claude/hooks/agent-view-register.sh` is deliberately *not* ignored and must survive:
`claude-sandbox` sources it and mounts it into the container, and `.claude/sandbox` does deploy
on macOS. Delete only what the comment lists.

## 4. Confirm the darwin block actually fires — MAC-ONLY

```sh
chezmoi managed | grep -E 'agentview|agent-view-state\.sh|/av$'
```

On the Mac this should print **nothing**. On Linux the same command prints ten paths — that
contrast is the test. Run it *before* item 3, because a non-empty result there means the ignore
is not working and deleting the files by hand would just have them redeployed.

## 5. Prune the audit artifacts — MAC-ONLY

Audit item 11. `~/.claude/artifacts/repo-test-audit-2026-08-06.md` and `.html` exist only on the
Mac — this box's `~/.claude/artifacts/` holds 45 files and none match. They will be pruned there
on the normal schedule.

## 6. Verify and land work-laptop-config #6 — MAC-ONLY

[work-laptop-config#6](https://github.com/DanielH2018/work-laptop-config/pull/6), branch
`docs/correct-gnu-path-claim`, **still a draft.** It narrows a claim in `.claude/CLAUDE.local.md`
that GNU coreutils are on `PATH`: true only for interactive shells, and `sed` was never covered
at all, because GNU sed is a separate `gnu-sed` formula rather than part of coreutils.

Left as a draft on purpose. That repo is not installed on the Fedora box, so nothing there could
exercise the claim; the Mac is the only place it can be checked. Verify the narrowed wording
against the actual Mac `PATH`, then mark ready and land.

---

## Deliberately not done

| Item | Why |
|---|---|
| **3 — CI** | Excluded by request. Not a technical block. |
| **2 — unsigned commits** | Re-signing rewrites shared history. |
| **9** | Needs coordination or CI, not a lock. |

## Two observations, both unexplained

Recorded because they are real and numeric, not because they are diagnosed. Neither was chased.

1. **Skip-count delta.** The primary checkout skips 25 where a worktree skips 31, same 1948
   total — six tests are worktree-conditional. Cause not investigated.
2. **`sweep-test-tmp: prefix too short to sweep safely: x-`** prints on *every* gate run,
   including the pre-edit baseline from before any of this session's work. **Pre-existing, not
   introduced by #282 or #283.** It reads like a sweep declining to sweep something.
