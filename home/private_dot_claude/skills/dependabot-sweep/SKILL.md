---
name: dependabot-sweep
description: Fan out one agent per repository to remediate open Dependabot alerts, then verify every lockfile before anything is pushed. Use on "fan out over the Processing repos for the open vulnerabilities", "remediate the Dependabot alerts", "clear the vulns", a link to the PR dashboard's vulns.html or /api/vulns, or a pile of single-package Dependabot security PRs to replace with one PR per repo.
---

# Dependabot sweep

A **sweep** turns the dashboard's open alerts into one remediation PR per repository. One
agent works in each repository. The dispatcher, which is you, plans the sweep, verifies each
agent's lockfiles, and asks Daniel before anything leaves the machine. This procedure ran on
2026-11-03 across eight Processing repos and cleared 206 of 260 alerts. The rules below are
the ones that run needed.

## 1. Split the alerts

Save the per-repo files in the scratchpad. Pass `--exclude` for every repo Daniel left out.

```bash
python3 ~/.claude/skills/dependabot-sweep/split_alerts.py --out <scratchpad> --exclude airflow
```

The script prints a table of counts by severity, ecosystem and manifest. It refuses a stale or
partial payload, and that refusal stops the sweep: re-fetch with the dashboard's Refresh, or
tell Daniel. Done when every in-scope repo has an `alerts-<repo>.json` file.

## 2. Prepare one worktree per repo

- **Isolate first.** The sandbox lets a session write a repo's `.git` but not its working
  tree. So cut each branch into the scratchpad from the default branch:
  `git -C ~/Repositories/<repo> worktree add <scratchpad>/wt-<repo> -b <branch> origin/<default>`.
  This also leaves Daniel's checkouts untouched, whatever branch they are on.
- **Clone a repo that has no local checkout** into the scratchpad. That needs the sandbox off,
  because the sandbox denies github.com.
- **List the open PRs per repo** with `ghread pr list`. A human-authored PR that touches the
  same packages goes into that repo's brief as an overlap to check, not to duplicate.

Done when every repo has a worktree on the remediation branch and its open PRs are noted.

## 3. Fan out

- **Load `orchestrating-subagents`** before spawning.
- **Write the common brief once** from `references/repo-brief.md` into the scratchpad. Give each
  agent a short prompt with four literal paths (worktree, alerts file, PR-draft file, the brief)
  plus its repo-specific notes.
- **Send all the Agent calls in one message**, one `implementer` per repo.

The brief carries the rules that matter most: the major-version rule, removal before bump,
the duplo traps, and the stop conditions. Done when every agent has returned its alert table.

## 4. Verify each repo

Run the checker on every branch. Do this whatever the agent reported: an agent's
"fixed" is a claim, and the lockfile is the evidence.

```bash
python3 ~/.claude/skills/dependabot-sweep/verify_locks.py --alerts <scratchpad>/alerts-<repo>.json --checkout <scratchpad>/wt-<repo>
```

- **Compare** the cleared count with the agent's table. A mismatch means one of them is wrong.
  Read the lockfile to find out which.
- **Read every `MAJOR` line against the major-version rule.** A major bump of a dev-scope or
  build tool is allowed. A runtime major is not, unless Daniel approved it. An alert's `scope`
  field says which applies.
- **Check every `ADDED` line.** A new package should come from a co-bump the agent explained,
  such as an opentelemetry sibling or a provider duplo requires.
- **Check signatures:** `git -C <worktree> verify-commit HEAD`. The global identity is
  correct. GitHub's squash merge rewrites the author to the noreply address, so `main` shows
  a different email.

Done when every repo's cleared count matches and every `MAJOR` and `ADDED` line is explained.

## 5. Ask, then push

- **Ask Daniel once for all repos** before any push or `gh pr create`. Report per repo: cleared
  and open counts, why each open alert stays open, and anything a reviewer must see.
- **A PR title and body describe only what the PR changes.** Leave out open alerts,
  `major-needed` lists, "N of M" counts and deferred decisions: those go to Daniel in chat.
  List a superseded Dependabot PR only when someone read its diff.
- **After pushing, report CI per PR**, including any Pulumi previews still running.

## Traps this sweep hit

| Symptom | Cause | What to do |
|---|---|---|
| Most `setuptools` copies won't leave the lock | `duplo` declared setuptools until v0.19.181 (duplo#457) | Bump duplo when the gap is small and the repo's pin comment allows it in this PR. Otherwise keep the setuptools bump. |
| `import pkg_resources` fails after a setuptools bump | setuptools 82+ no longer ships `pkg_resources`, and pulumi-aws 5.x, pulumi-docker 3.x and lbrlabs-pulumi-grafana import it | Leave setuptools below 82 there. The real fix is pulumi-aws 6. |
| A comment above the duplo pin says it "moves live resources" | That repo wants each duplo bump in its own PR, with the previews read | Keep the duplo bump out of the remediation PR, or make it the PR's only change |
| `uv lock` fails to fetch duplo | duplo is a private git+ssh source, and the sandbox denies github.com | Re-run that one command with the sandbox off |
| A lockfile header jumps from `revision = 3` to `revision = 5` | The local uv is newer than the one that wrote the file | Harmless: CI's older uv still reads it. Name it in the PR body as format noise. |
| A Gemfile.lock can't be re-locked | The system Ruby can't load the lockfile's bundler | Hand-edit a leaf gem's version. The first CI Ruby job is the real check. |
