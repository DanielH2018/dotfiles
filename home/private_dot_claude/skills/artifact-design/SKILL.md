---
name: artifact-design
description: Use when producing an implementation plan, spec, or design document for review — render it as a clean, self-contained local HTML artifact alongside the written version. Local by default (~/.claude/artifacts/); never publishes to claude.ai unless explicitly asked.
---

# artifact-design

Render plans / specs / design docs as a readable, self-contained HTML file **in addition to** the written version, not instead of it.

## When to use

- Use when a plan/spec/design doc is about to go to Daniel for review, in plan mode or normal chat. See also the writing-plans and brainstorming skills, which usually produce the plan this renders.
- Reach for it before you send the written plan, not after — the artifact and the chat message go out together.
- Only render when the deliverable is a plan or spec for review. A status update, a quick answer, or a single-file diff isn't a plan and doesn't need one.
- Skip when the plan is trivial (a one-liner or single obvious step), or when Daniel said not to.

## Output rules

- **Local by default.** Write one self-contained `.html` file to `~/.claude/artifacts/` and tell Daniel the path.
  - If that directory doesn't exist yet, create it first — don't skip the artifact because the directory is missing.
- **Never publish to claude.ai** or call the Artifact tool unless Daniel explicitly asks for it.
- **Self-contained.** Inline all CSS; no external fonts, scripts, or network assets — it must render offline from `file://`. A minimal skeleton:
  ```html
  <!doctype html><html><head><meta charset="utf-8"><style>/* all CSS inline here */</style></head>
  <body><!-- content --></body></html>
  ```
- **Filename**: `<slug>_<YYYY-MM-DD>.html`.
- Always still deliver the written plan/spec in the chat. The artifact is a readability aid, never a replacement — if you only render the HTML and skip the chat version, you've failed the task.

## Style

- Use a dark, terminal-friendly palette; system font stack; generous line-height.
- Lead with a one-line summary and any at-a-glance stats, then the detail — prefer tables over walls of prose.
- Use `code` styling for file paths, commands, and identifiers.
- Keep it skimmable: headers, tables, and severity/priority cues where relevant.
- Avoid emojis unless Daniel asks for them.
