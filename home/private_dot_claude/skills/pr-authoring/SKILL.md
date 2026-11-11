---
name: pr-authoring
description: Use when writing the text of a pull request — its title, its body, or the summary passed to `gh pr create` — however short the request. Triggers on "write the PR description", "open a PR", "what should this PR say", "the PR body", "summarize this branch for review", a PR left with an empty or template-only body, or a title that names the files touched instead of the outcome. A one-line ask still loads it: the title becomes the squash-merge commit subject, so writing one freehand is how the convention drifts. Covers what the PR SAYS. `gh-stack` covers splitting the diff, and a commit message on its own is neither.
---

# pr-authoring

A PR body exists to stop a reviewer re-deriving what you already worked out. Every
rule below serves that one job.

## Precedence

1. **A repo's own `.github/pull_request_template.md` wins.** When one exists, fill its
   sections rather than replacing them; the rules here govern *how you write inside*
   those sections. Check for it before drafting: `ls .github/pull_request_template.md
   .github/PULL_REQUEST_TEMPLATE.md`.
2. **This skill owns the prose, and the size and history check.** Splitting and
   stacking belong to `gh-stack` (work machines only); dispatching review agents belongs
   to the `## Code review` rule in `~/.claude/CLAUDE.md`. Do not restate their rules
   here or in the PR — a second source of truth on "how big is too big" is how this
   goes wrong.
3. **A template checkbox is a task, not a claim.** Where a template asks you to tick
   something, do the thing and then tick it. An unticked box is an honest report; a ticked
   box next to work you did not do is a false one.

## The title

**The title is the commit subject.** A squash merge makes the PR title the subject line
on the default branch, so the `## Git conventions` commit rules apply to it unchanged.

- Imperative mood, sentence case. `Stop node-exporter's probes flooding Loki with reset errors`.
- **No type prefix, no ticket, no scope tag.** Not `fix:`, not `feat(probes):`, not `[INFRA-12]`.
- **Name the outcome, not the mechanism.** `Stop the probes flooding Loki` beats
  `Change probe paths in the node-exporter daemonset` — the second one is the diff, which
  the reviewer can already read.
- A `X, not Y` contrast is idiomatic where the change replaces a choice:
  `Sweep for bad mkv attachment names every 15 minutes, not daily`.
- The first ~60 characters carry the outcome. Length past that is fine; a title whose
  point arrives at character 80 is not.
- **The title is a search key.** Someone looking for this change in a year searches on the
  description, often from a faint memory of what it did. A title that stands alone is what
  makes the change findable at all.

### Descriptions that say nothing

`Fix build`, `Add patch`, `Moving code from A to B`, `Add convenience functions`. Each names
an activity rather than an outcome, so it is unsearchable and tells a reviewer nothing.
Google lists a bare `Phase 1` alongside them; the objection is to a phase marker *as the
whole description*, so `Phase C slice 2: check that staging services answer, not just start`
carries the outcome after the marker and is fine.

## The body

### Lead with the symptom, measured

No preamble. `This PR ...` and `In this change we ...` are banned openings — the reader
knows what they are looking at. Open on the fact that made the change necessary, with the
number attached:

> node-exporter emitted **21–24 lines/sec/pod** ... which was **97% of all k8s-namespace
> Loki ingest**. The client was our own kubelet.

**Numbers, not adjectives.** "A lot of log noise" gives a reviewer nothing to check.

### The opener stays visible; the write-up folds

An agent-written body is accurate and long, and a long body reads as slop even when it is
not. So split it. The opener sits in plain view, and the rest of the write-up goes inside a
`<details>` block that the reader expands on demand.

You write the opener too. Select it carefully to act as a high-level explanation of what is
going on: the shortest text a human can read that gets them up to speed. In practice that is
the measured symptom above plus the outcome, in one to three sentences. Choose it for what a
reader needs, not to tease the folded part. Add a screenshot under it when the change is
visual.

Everything under the reviewer-question headings goes inside the block, unchanged. Folding
cuts nothing: the rejected alternatives and the verification output still have to be there.

```markdown
<opener: measured symptom and outcome>

<details>
<summary>Claude Opus 5.5 (high effort): full write-up</summary>

## Why the cheaper fix fails
...
</details>

Closes #123
```

- **Leave a blank line after `</summary>`.** Without it, GitHub renders the headings,
  tables and code fences inside the block as raw text.
- **Name the model and effort in the summary line**, so the reader knows what the block
  holds before opening it.
- **Three things stay outside the block.** The `Closes #N` line stays visible because
  GitHub acts on it wherever it sits. The post-merge action stays visible because it is a
  task, not context. The attribution footer stays at the end.
- **Skip the block when the write-up fits on one screen.** Folding a short body adds a
  click and hides nothing worth hiding.
- **Under a repo template, keep its section headings visible.** Fold only long content
  inside a section.

### Headings are the reviewer's question, not a template slot

Write the heading a reviewer would ask out loud: `## Why FINALDELAY is not parameterised`,
`## Why this is free`, `## Why the second hit is the interesting one`. A generic
`## Changes` heading tells the reader nothing the diff didn't.

The questions worth a heading, in rough order of how often they earn one:

| Question | When it earns a section |
|---|---|
| What is actually wrong | Any bug fix. Put the evidence here, not the theory. |
| What did you rule out, and why | Whenever an obvious cheaper fix exists. See below. |
| What changed | Whenever the diff is not self-evident. A before/after table beats prose for a swap of values. A `diff` of the call tree or file tree beats prose for a structural change, and GitHub renders Mermaid when a sequence needs it. |
| What proves it can fail | Any new check, guard, probe or validator. |
| What did you run | Always — see *Verification*. |
| What must happen after merge | Whenever merging is not shipping. |

### Name what you rejected

This is the section reviewers most often need and authors most often skip. A reviewer
who cannot see that you already considered the cheap fix will propose it, and you will
spend a round trip refuting it in a comment thread instead of once in the body.

State the alternative, then the specific reason it fails — a measurement, a constraint,
or a failure it would reintroduce. "Not fixable by shrinking the response ... `collect[]=loadavg`
= 10,030 bytes against a prober read limit of ~10KB" ends the discussion. "We decided
against that" does not.

### Context goes inline, not behind a link

A link is not context. Dashboards get rebuilt, internal hosts get renamed, and access
expires, so a later reader following your link finds nothing. Quote the number, paste the
four relevant log lines, name the constraint — then link for the reader who wants more.

### The *why* is what makes the change safe to remove

Source code shows what the software does; only the description shows why it exists. A
reader who cannot see the reason cannot tell whether the thing is still load-bearing, so
they either leave dead code standing or take out a fence that was holding something up.
Write the reason you had at the time, including the decisions that left no trace in the
diff.

### Verification is literal output, never a claim

Paste what the command printed. `uv run pytest`: 5309 passed, 37 skipped; `prek run
--all-files` exit 0. A checkbox next to an unrun command is worse than no checkbox — it
reads as evidence and is not. Where you did not run something, say so.

This is the `## Verification & self-checking` rule applied to the PR body: if the body
says the tests pass, you ran them in this session and read the output.

### Say what the reviewer must do next

Where merging does not deploy, close with the command that does, and the thing to look at
afterwards. Where nothing is needed, say "nothing to deploy" rather than leaving it blank —
a blank section reads as forgotten.

### Only a fixed issue gets a closing keyword

The body's own `Closes #N` line is the only closing keyword it carries, and it names only
the issues this PR fixes. GitHub closes an issue on merge whenever `close`, `closes`,
`closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` or `resolved` precedes `#N`,
whatever the rest of the sentence says. PR #2510's body said "Filed and not fixed: #2509",
and GitHub closed #2509 two seconds after the merge. List a follow-up you did not fix
with no keyword before its number: `Filed for later: #N`.

In the server repo, `land.sh --arm-merge` refuses a body that carries such a stray closing
reference (`stray_closing_refs` in `scripts/deploy_tools/land_lib/merge.py`).

## What belongs in one PR

Composition, not size. *Measure the diff* below handles a diff you already have; these two rules
decide what goes into it in the first place, and neither one is a line count.

- **A refactor travels alone.** A pure refactor mixed with a behaviour change makes both
  harder to review — the reviewer cannot tell which hunks are supposed to be inert — and
  harder to roll back, because reverting the bug takes the cleanup with it. Land the
  refactor first, then the change.
- **Tests for the change ride along with it.** The tests covering new behaviour belong in
  the same PR as the behaviour. Test work that stands on its own goes separately:
  validating already-merged code, refactoring helpers, introducing a framework.

## Measure the diff

Before drafting the body of a feature-branch PR, measure the branch. The deterministic
git math lives in `references/triage.sh` beside this file. It runs every git call in the
working directory, so invoke it by absolute path from the target repo's root.

1. `triage.sh guard-branch` exits non-zero on the default branch. Stop there.
2. Run `git fetch origin`, then count the changed files' independent groups yourself:
   group by top-level module, and map each test to the module it covers. Pass that count
   to `triage.sh metrics <groups>`.
3. Report the readout as one line, for example
   `Review cost: 14 files · +320/−40 · 5 commits (+1 merge, +2 fixup) · 2 separable concerns`.
   Add the recommendation that `needs_history_cleanup` and `split_worthy` imply.

Both flags are advisory, and the user confirms before any rewrite.

- **`split_worthy`** hands the split to `gh-stack`. Where that skill is not installed,
  propose the branches and what each one carries, and let the user split them.
- **`needs_history_cleanup`** means merge commits, fixup-style commits, or more than six
  commits. Once the user confirms, read `references/history-cleanup.md` and follow it step
  by step: a restore point, a rebase, a checkpoint the regroup must preserve, and a tree
  check before the push. The push is `git push --force-with-lease` after the user
  confirms. Never plain `--force`, never `--no-verify`.

Don't run the `lpt-pr-curator` plugin on a PR you open. Its "Add Code Comments" step
commits comments that summarise each block for the reviewer, which `rules/comments.md`
forbids, so the work overlay disables the plugin. Anything a reviewer needs to follow the
diff goes in the PR body or in a review comment on the line, never in a code comment.

## Handing the body to `gh`

To pass the body, write it with the Write tool to a file under `$CLAUDE_JOB_DIR/tmp` or
the scratch directory, then run `gh pr create --body-file <path>` (or `gh pr edit`).
Never use `--body "$(cat <<'EOF' ...)"`. `claude_guard` declines to auto-approve any
command substitution, so that form costs a prompt or a classifier round. The same file
works for `gh issue create --body-file` and for a multi-line `git commit -F <path>`.

## Before you open it

- [ ] The title reads as a commit subject and names the outcome.
- [ ] The body opens on a fact, not on `This PR`.
- [ ] The opener stands alone, and a long write-up sits inside `<details>` with the
      `Closes` line outside it.
- [ ] Every alternative a reviewer would propose is named and refuted with evidence.
- [ ] Every verification claim quotes output you read this session.
- [ ] A closing keyword precedes only the issues this PR fixes.
- [ ] The repo's PR template sections are filled, not deleted.
- [ ] Draft (`gh pr create --draft`) if CI has not run or the branch is still moving.

## Failure modes

**Restating the diff.** A body that walks the files in order adds nothing; GitHub already
shows them. Write only what the diff cannot say.

**Bulleted noise.** Six bullets each naming a file is not a summary. One paragraph naming
the behaviour change is.

**Template theatre.** Checked boxes for work not done. Uncheck them, or do the work.

**Selling.** No "comprehensive", "robust", "significantly improved". State what it does and
what it costs; the cost sentence is what makes the rest credible.

## Sources

The title and heading conventions are measured from this operator's own merged PRs. The
search-key argument, the link-rot rule, the *why* framing, the bad-description list, and
both composition rules are adapted from Google's CL author's guide —
<https://google.github.io/eng-practices/review/developer/> (CC-BY 3.0). The visible
opener and the folded write-up come from Simon Willison,
[Hide your slop PR descriptions behind `<details><summary>`](https://simonwillison.net/2026/Nov/9/details-summary/).
