---
name: handoff
description: Compact the current session into a handoff doc a fresh agent can resume from — session-only state, verbatim corrections and error strings, dead ends, and a paste-ready prime line. Invoked as /handoff only; the argument is what the next session will focus on.
argument-hint: "what the next session will focus on"
disable-model-invocation: true
---

# Handoff — compact a session for its successor

**Carry only what dies with this context.** Everything else is reachable by path
or URL and gets referenced, not restated — a copy goes stale the moment the
original moves. That single rule decides what goes in the doc and what stays out.

## When to reach for this

Work is in flight and this session is ending: before `/clear`, before the context
window fills, or when splitting a large task onto a fresh session. Skip it when the work is landed — a PR body and commit message
already carry it.

Not the neighbouring tools: `remember` writes *durable* facts to history/vault;
auto-compaction is intra-session and hook-driven. A handoff is one-shot, for one
successor, scoped to one task.

## What only exists in the conversation

Write these down, because nothing else holds them:

- **User corrections and constraints** — verbatim. Never a summary of them.
- **Error strings** — verbatim. A paraphrased error is unsearchable.
- **Dead ends** — what was tried, why it failed, don't retry. Least recoverable,
  highest value; the successor will otherwise burn the same hour.
- **Verified vs. assumed** — which claims were actually run *this session*, with
  the command and its result. Everything else is marked unverified.
- **The reason** behind a decision, where the code only shows the outcome.

Reference, don't restate: specs, plans, ADRs, issues, PR bodies, commits, diffs,
test files. Same priority ladder as the compaction policy in `~/.claude/CLAUDE.md`
— when space forces cuts, drop completed work first and corrections last.

## Gather ground truth first

Pull it, don't recall it:

- `git status -sb` · `git log --oneline -5` · branch, push state, worktree path if
  not the primary checkout
- `gh pr view --json url,state,statusCheckRollup` when a PR exists
- The exact test/build commands run this session and their pass/fail

If a check wasn't run in this session, say "unverified" rather than inheriting an
earlier run's result.

## Write it

Path: `~/.claude/handoffs/<YYYY-MM-DD>-<slug>.md` (`mkdir -p` first). Outside every
repo, so it can never be committed — this repo is public.

Fixed section order. Omit a section only when it is genuinely empty; never omit
*Corrections* or *Dead ends* when there is anything to put in them.

```markdown
# Handoff: <objective, one line>
<date> · <branch> @ <repo or worktree path>

## Objective
<what the successor should accomplish>

## State
Branch/push state · PR + CI status · dirty files

## Done & verified
<what, and the command that proved it, with its result>

## In flight
<the exact next step — file and change, not "continue the feature">

## Corrections & constraints (verbatim)
> <the user's own words>

## Errors seen (verbatim)
<error string, in a fenced block>

## Dead ends
<tried X → failed because Y. Don't retry.>

## Pointers
<spec / plan / issue / file:line>

## Suggested skills
<skill> — <when to reach for it>

## Open questions
<unresolved, and what would resolve it>
```

**Suggested skills** names what the successor should invoke for the *immediate next
step*, and when — not an inventory. Check `ls ~/.claude/skills` and the plugin list
if unsure what's installed.

## Argument = focus

Treat the argument as the successor's brief and tailor the doc to it. Threads that
fall outside it still get one line each under **Not carried over**, so nothing
disappears silently.

## Redact

Strip before writing: API keys, tokens, passwords, connection strings, PII, and —
for work sessions — customer names and internal hostnames. Leave
`<redacted: what it was>` so the successor knows something was there, and name
where to fetch it (1Password item, env var), never the value itself.

## Close out

End the reply with the path as a clickable link plus a paste-ready prime line:

```
Read file:///home/daniel/.claude/handoffs/<file>.md and continue from "In flight".
```

Done means: a reader who never saw this session can name the next command to run
without asking a question. If any section would make them ask "what did you mean",
it isn't done.
