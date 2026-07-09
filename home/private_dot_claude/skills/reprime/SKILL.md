---
name: reprime
description: Use to re-center on the user's core working rules mid-session when adherence may have drifted after a long context — re-reads the authoritative rule files and self-audits against the highest-decay directives. Invoke as /reprime, or self-invoke when you catch yourself drifting (getting verbose, scope-creeping, or asserting about code you haven't reread this session).
---

# reprime

A long context buries the rules loaded at the top. This re-injects them on
demand by re-reading the real sources — so it can't go stale against them.

## When to reach for this

Use when you notice drift mid-session: responses running longer than the ask,
scope creeping past what was requested, or a claim about code/output you
haven't actually reread this session. Also reach for it before you resume
work after a long tool-heavy stretch — many file reads, agent runs, or search
results — where the rules loaded at context start have scrolled out of view.
Skip it when there's no drift signal; don't run it as ceremony on every turn.

## Do this now

1. **Re-read the authoritative sources** (they override anything below):

   ```
   ~/.claude/CLAUDE.md            (and its @-includes)
   <project>/CLAUDE.md            (and CLAUDE.local.md, if present)
   ~/.claude/rules/*.md           (only the ones relevant to the current work)
   ```

2. **Self-audit the current task** against the highest-decay directives:
   - **Terse** — cut preamble and "here's what I did" summaries; never open with hedging filler.
   - **Minimal diff** — touch only what the task needs: don't add unrequested refactors, don't create new files when an edit works, don't add comments/docstrings/types on code you didn't change, and don't add error handling for cases that can't happen.
   - **Verify, don't assert** — never claim anything about code or output you haven't actually read this session; run the check and cite it before you say it passes. See also the verification-before-completion skill for the full gate before claiming a task done.
   - **Tests** — write tests for new code in the project's existing style and framework.
   - **Config edits** — global `~/.claude` is chezmoi-managed; check the source with `chezmoi source-path <file>` and edit that, never the deployed copy. If the drift looks systemic rather than one-off, that's a job for the config-lint skill, not a one-time fix.

3. If the current work violates any of those, **correct course before continuing** — fix it in the response you're already writing, not just going forward.

## Limitation

This only catches drift against *stated* rules. It won't fix a wrong
understanding of the code itself — pair it with actually rereading the files
in question, not just the rule sources, if the mistake is about what the code
does rather than how you're expected to work.

Don't narrate the reprime — realign silently and proceed.
