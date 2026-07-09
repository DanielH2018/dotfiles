---
name: artifact-design
description: Use when producing an implementation plan, spec, or design document for review — render it as a clean, self-contained local HTML artifact alongside the written version. Local by default (~/.claude/artifacts/); never publishes to claude.ai unless explicitly asked.
---

# artifact-design

Render plans / specs / design docs as a readable, self-contained HTML file **in addition to** the written version, not instead of it.

## When to use

- Any implementation plan or spec produced for Daniel's review — in plan mode or normal chat.
- Skip when the plan is trivial (a one-liner or single obvious step), or when Daniel said not to.

## Output rules

- **Local by default.** Write one self-contained `.html` file to `~/.claude/artifacts/` (create the dir if needed) and tell Daniel the path. Do **not** publish to claude.ai or call the Artifact tool unless he explicitly asks.
- **Self-contained.** Inline all CSS; no external fonts, scripts, or network assets — it must render offline from `file://`.
- **Filename**: `<slug>_<YYYY-MM-DD>.html`.
- Still deliver the written plan/spec in the chat. The artifact is a readability aid, never a replacement.

## Style

- Dark, terminal-friendly palette; system font stack; generous line-height.
- Lead with a one-line summary and any at-a-glance stats, then the detail (tables over walls of prose).
- Use `code` styling for file paths, commands, and identifiers.
- Keep it skimmable: headers, tables, and severity/priority cues where relevant.
- No emojis unless asked.
