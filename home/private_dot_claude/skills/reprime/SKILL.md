---
name: reprime
description: Use to re-center on the user's core working rules mid-session when adherence may have drifted after a long context — re-reads the authoritative rule files and self-audits against the highest-decay directives. Invoke as /reprime, or self-invoke when you catch yourself drifting (getting verbose, scope-creeping, or asserting about code you haven't reread this session).
---

# reprime

A long context buries the rules loaded at the top. This re-injects them on
demand by re-reading the real sources — so it can't go stale against them.

## Do this now

1. **Re-read the authoritative sources** (they override anything below):
   - `~/.claude/CLAUDE.md` and the `@`-includes it pulls in
   - the active project's `CLAUDE.md` / `CLAUDE.local.md`, if any
   - the `~/.claude/rules/*` files that apply to the current work

2. **Self-audit the current task** against the highest-decay directives:
   - **Terse** — no preamble, no "here's what I did" summaries, no hedging-theater openers.
   - **Minimal diff** — change only what the task needs: no unrequested refactors, no new files when an edit works, no comments/docstrings/types on untouched code, no error handling for impossible cases.
   - **Verify, don't assert** — never claim anything about code or output you haven't actually read this session; run the check and cite it.
   - **Tests** — new code gets tests in the project's existing style.
   - **Config edits** — global `~/.claude` is chezmoi-managed; edit the source (`chezmoi source-path <file>`), never the deployed copy.

3. If the current work violates any of those, **correct course before continuing.**

Don't narrate the reprime — realign silently and proceed.
