# Trigger eval results

Re-record after any edit to the skill's `description`, which is the only field this
eval measures. A result is valid only for the model that produced it.

## 2026-09-25 (pr-review-prep folded in) · opus · 3 runs/case · 8/8

Peers in the isolated config: `gh-stack`, `receiving-code-review`.

| Case | Expect | Fired | Verdict |
|---|---|---|---|
| write-pr-description | fires | 3/3 | pass |
| what-should-it-say | fires | 3/3 | pass |
| empty-body | fires | 3/3 | pass |
| gh-pr-create | fires | 3/3 | pass |
| commit-message | silent | 0/3 | pass |
| review-diff | silent | 0/3 | pass |
| split-branch | silent | 0/3 | pass |
| rebase-howto | silent | 0/3 | pass |

Two things changed since the 2026-08-29 run. The description dropped the clause
`` `pr-review-prep` covers whether the diff is shaped to be reviewed``, because that skill was
deleted and its size-and-history check moved into this one. The eval's peer list dropped
`pr-review-prep` for the same reason.

The case to watch was `split-branch`. With the clause gone, the description names only
`gh-stack` as the owner of splitting, and this skill now owns the size check that sits next to
splitting. It stayed at 0/3.

## 2026-08-29 (after the description fix) · opus · 8/8

| Case | Expect | Fired | Verdict |
|---|---|---|---|
| write-pr-description | fires | 3/3, and **10/10** on a pinning re-run | pass |
| what-should-it-say | fires | 3/3 | pass |
| empty-body | fires | 3/3 | pass |
| gh-pr-create | fires | 3/3 | pass |
| commit-message | silent | 0/3 | pass |
| review-diff | silent | 0/3 | pass |
| split-branch | silent | 0/3 | pass |
| rebase-howto | silent | 0/3 | pass |

`write-pr-description` went from 11/16 (~70%) to 13/13. The negative arm held at zero fires
across all four cases, which is the half that mattered: the fix raises the description's
insistence, and the failure mode of that is a skill that starts firing on everything.

### The fix, and why it was not "add more trigger phrases"

The description already contained "write the PR description" verbatim, so the miss was never a
vocabulary gap. The signal was in which cases passed: the three positives at 3/3 are all wordier,
and `empty-body` fires every run without naming a PR description at all. Only the terse
imperative missed — a short request reads as small enough to answer directly.

So the edit targets brevity rather than wording: `— however short the request` in the opening
clause, plus `A one-line ask still loads it: the title becomes the squash-merge commit subject,
so writing one freehand is how the convention drifts.` The guard against the new over-firing risk
went in at the same time: `and a commit message on its own is neither`.

## 2026-08-29 (before the fix) · opus · 3 runs/case · 7/8

Peers in the isolated config: `pr-review-prep`, `gh-stack`, `receiving-code-review`.

| Case | Expect | Fired | Verdict |
|---|---|---|---|
| write-pr-description | fires | 2/3 | **FAIL** |
| what-should-it-say | fires | 3/3 | pass |
| empty-body | fires | 3/3 | pass |
| gh-pr-create | fires | 3/3 | pass |
| commit-message | silent | 0/3 | pass |
| review-diff | silent | 0/3 | pass |
| split-branch | silent | 0/3 | pass |
| rebase-howto | silent | 0/3 | pass |

### What the numbers say

**The negative arm is clean.** Four cases, twelve runs, zero spurious fires. That includes
`commit-message`, the case built to over-fire: the skill states that a squash merge makes the
PR title the commit subject, so a request for a commit message is the nearest miss available.
It stayed quiet every run.

**The failure is the shortest prompt in the set.** `Write the PR description for this branch.`
fires 2 of 3, while three wordier positives fire 3 of 3 — including `empty-body`, which never
names a PR description at all. So this is not a description that lacks the trigger phrase: it
contains "write the PR description" verbatim. A terse imperative appears to read as a request
small enough to answer directly.

An independent hand-run probe measured the same 2/3 on the same prompt before the eval was
finished, which is corroboration from a separate run rather than the same number twice.

### How the rate was established

Pinned before the `description` was touched, because at n=3 a 2/3 does not distinguish a genuine
~66% trigger from an ~85% one that got unlucky. A 10-run re-run returned 7/10, giving 11/16
(~70%) across three independent measurements. Fixed above.

## Runner defects found while building this

Recorded because each one produced a plausible, clean, wrong number — the failure mode an eval
is least able to report on itself.

- **`pipefail` + `grep -q` scored every hit as a miss.** `printf '%s' "$out" | grep -q` has grep
  exit the moment it matches; `printf` then takes SIGPIPE and the pipeline returns non-zero on a
  *successful* match. Reported 0/3 on a case that was firing. Fixed with a herestring.
- **`claude -p` consumed the case loop's stdin**, swallowing every case after the first. The run
  reported `0/1 cases passed` while appearing to have tested the set. Fixed with `</dev/null`.
- **The working directory leaked into the measurement.** Claude Code loads the cwd's project
  `CLAUDE.md`, so a run launched from inside this repo measured that context. Each run now
  happens in an empty directory.
- **Credentials do not follow `CLAUDE_CONFIG_DIR`.** Without the symlink every run returns
  `Not logged in` and scores as "did not fire" — a passing negative arm and a failing positive
  one, with no error anywhere.
