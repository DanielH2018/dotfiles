---
name: pr-feedback
description: Summarize the feedback waiting on the user's open GitHub PRs in the Lithic org (privacy-com). Use when the user asks about their open PRs, PR feedback, review comments waiting on them, unresolved review threads, or "what's blocking my PRs".
metadata:
  author: daniel
  version: 0.1.0
---

# PR Feedback

Survey the user's open PRs authored in `privacy-com`, collect the feedback
waiting on them, and summarize it — grouped by PR in the terminal, plus a
self-contained HTML artifact. Stateless: every run reports current state.

## When to use

Reach for this skill before you dig through GitHub notifications by hand,
or whenever the user asks "what's blocking my PRs" and wants review status
without opening GitHub. Use it for read-only status only — don't reach for
it to draft a PR description or add review-guide comments; that's the
pr-curator skill's job, not this one.

## Steps

1. **Fetch.** Write the data layer's JSON to a scratch file (each Bash call is
   a fresh shell, so persist to a file, not a shell variable):

   ```bash
   mkdir -p /tmp/claude/pr-feedback
   bash ~/.claude/skills/pr-feedback/scripts/fetch.sh > /tmp/claude/pr-feedback/data.json
   ```

   [`fetch.sh`](scripts/fetch.sh) calls `gh`, which cannot read `~/.config/gh`
   under the OS sandbox. Run this step with the sandbox disabled, or the
   call fails with a permission error. Override the org with
   `PR_FEEDBACK_ORG=<org>` if asked.

2. **Empty check.** Read `/tmp/claude/pr-feedback/data.json`. If
   `.counts.total == 0`, tell the user "No open PRs in `<org>`." and stop —
   don't render an HTML artifact for zero PRs.

3. **Terminal summary.** Print PRs grouped and ordered as returned (already
   ranked T1→T3, then most-recently-updated). No emoji. Markers: `[!]`
   changes-requested, `[x]` failing check, `[~]` unresolved thread. Per PR:

   ```
   [<marker>] <repo-short>#<number>  <title>      <one-line status>
       <url> · <branch> · updated <age>
       Reviews:  <author> <state> · ...            (omit line if none)
       Checks:   [x] <name> ... · ...              (omit line if none)
       Threads:  [~] <path>:<line>  <author>: "<snippet>" -> <url>
       Comments: <author>: "<snippet>" -> <url>    (omit line if none)
   ```

   Lead with a header: `Open PRs awaiting you — <org> (<total> total, <attention> need attention)`.

4. **HTML artifact.** Render from the scratch file and print the path (no `gh`,
   so the sandbox stays on). Redirect the file into the script — never pipe
   into `bash` (blocked by the dangerous-bash hook):

   ```bash
   mkdir -p "$HOME/.claude/artifacts"
   out="$HOME/.claude/artifacts/pr-feedback-$(date +%Y-%m-%d-%H%M).html"
   bash ~/.claude/skills/pr-feedback/scripts/render.sh \
     ~/.claude/skills/pr-feedback/templates/report.html \
     "$out" < /tmp/claude/pr-feedback/data.json
   ```

   Only render this when the user wants a shareable artifact; skip it for
   a quick terminal-only check. Tell the user the printed path and that in
   the TUI it opens with **Shift+Cmd+click** (or Ctrl+click) — plain
   Cmd+click does not work.

5. **Close.** State the counts: `N PRs, M need attention`.

## Notes

- Never write to GitHub (no replying/resolving) — this skill is read-only;
  delegate to the pr-curator skill for anything that posts back to GitHub.
- Org default is `privacy-com`; author is always the authenticated user (`@me`).
- Always run step 1's fetch with the sandbox off and step 4's render with
  it on — swapping those either breaks `gh` or trips the dangerous-bash hook.
- Caveat: the T1→T3 ranking is the data layer's own heuristic, not a
  GitHub-native priority field — treat it as a hint, not ground truth.
  See also the pr-curator skill, which writes PR descriptions and review
  comments instead of reading feedback.
