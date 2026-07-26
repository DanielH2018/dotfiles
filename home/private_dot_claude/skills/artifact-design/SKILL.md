---
name: artifact-design
description: Use when producing an implementation plan, spec, or design document for review — render it as a clean, self-contained local HTML artifact alongside the written version. Local by default (~/.claude/artifacts/); never publishes to claude.ai unless explicitly asked.
---

# artifact-design

Render plans / specs / design docs as a readable, self-contained HTML file **in addition to** the written version, not instead of it.

## When to use

- Use when a plan/spec/design doc is about to go to Daniel for review, in plan mode or normal chat. See also the writing-plans and brainstorming skills, which usually produce the plan this renders.
- Load it before you write the plan, not after — the artifact and the chat message go out together. (Loading early, emitting the link last: see Output rules.)
- Only render when the deliverable is a plan or spec for review. A status update, a quick answer, or a single-file diff isn't a plan and doesn't need one.
- Skip when the plan is trivial (a one-liner or single obvious step), or when Daniel said not to.

## Output rules

- **Local by default.** Write one self-contained `.html` file to `~/.claude/artifacts/` and tell Daniel the path.
  - If that directory doesn't exist yet, create it first — don't skip the artifact because the directory is missing.
- **The link goes last.** Write the plan out in the chat first, then write the HTML file, then close the reply with the path — a bare link line, nothing after it. If the link lands above the written plan, Daniel has to scroll back up through the plan to open the file.
- **Never publish to claude.ai** or call the Artifact tool unless Daniel explicitly asks for it.
- **Self-contained.** Inline all CSS; no external fonts, scripts, or network assets — it must render offline from `file://`. A minimal skeleton:
  ```html
  <!doctype html><html><head><meta charset="utf-8"><style>/* all CSS inline here */</style></head>
  <body><!-- content --></body></html>
  ```
- **Filename**: `<slug>_<YYYY-MM-DD>.html`.
- Always still deliver the written plan/spec in the chat. The artifact is a readability aid, never a replacement — if you only render the HTML and skip the chat version, you've failed the task.

## Palette

Use **Catppuccin Mocha** — the terminal's own theme, so an artifact and the terminal it was
generated from look like one system. "A dark palette" used to be the only guidance here, and
the result was drift: artifacts landed in GitHub Dark, Tokyo Night, and several one-off
schemes. Don't pick a palette per artifact; use these values.

| role | hex | | role | hex |
|---|---|---|---|---|
| page background | `#1e1e2e` base | | body text | `#cdd6f4` text |
| recessed panel | `#181825` mantle | | secondary text | `#a6adc8` subtext0 |
| deepest well | `#11111b` crust | | muted / captions | `#6c7086` overlay0 |
| card / raised | `#313244` surface0 | | links, info | `#89b4fa` blue |
| borders, rules | `#45475a` surface1 | | success, added | `#a6e3a1` green |
| subtle border | `#585b70` surface2 | | warning | `#f9e2af` yellow |
| | | | danger, removed | `#f38ba8` red |
| | | | emphasis, accent | `#cba6f7` mauve |

Also available when a chart or a set of categories needs more distinct hues: peach `#fab387`,
teal `#94e2d5`, sky `#89dceb`, lavender `#b4befe`, pink `#f5c2e7`, rosewater `#f5e0dc`.

**Text on an accent background must be `#11111b` (crust), never white.** Mocha's accents are
pastel, so light text on a filled badge, pill, or button disappears. This is the single most
common way an otherwise-correct artifact comes out unreadable.

Define these once as CSS custom properties on `:root` and reference them — don't scatter raw
hexes through the stylesheet. If the artifact needs a light mode, use Catppuccin **Latte**
(base `#eff1f5`, text `#4c4f69`, subtext0 `#6c6f85`, surface0 `#ccd0da`, blue `#1e66f5`,
green `#40a02b`, yellow `#df8e1d`, red `#d20f39`, mauve `#8839ef`) rather than inventing one.

## Style

- System font stack; generous line-height.
- Lead with a one-line summary and any at-a-glance stats, then the detail — prefer tables over walls of prose.
- Use `code` styling for file paths, commands, and identifiers.
- Keep it skimmable: headers, tables, and severity/priority cues where relevant.
- Avoid emojis unless Daniel asks for them.
- Set an intentional type scale — deliberate sizes and weights for headers vs. body vs. captions — even within the system font stack. The font is fixed; the hierarchy still has to be designed.
- Let structure encode information, not decorate it. Don't add `01 / 02 / 03` numbering or step markers unless the content is genuinely a sequence where order carries meaning.

## CSS gotcha

- Watch selector specificity when hand-authoring inline CSS. A type-based selector (`.section`) and an element-based one (`.cta`) can silently cancel each other's padding/margins, most often on spacing between sections. Keep spacing rules on one consistent selector layer.

## Writing

The prose in the artifact is design material, not filler — apply the same care as the layout:
- Active voice; name things by what the reader controls or recognizes, not by how the system is built.
- Sentence case, plain verbs, no filler; each element does one job (a label labels, a caption demonstrates).
- Be specific over clever — a precise summary line beats a punchy one.
