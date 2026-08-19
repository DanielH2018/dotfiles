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

## Slice status — required whenever the doc has phases

An artifact that plans work in slices gets refreshed automatically as those slices land
(a Stop hook watches for commits on the default branch and asks for an update), so the
status has to live somewhere a later session can find and edit surgically. Freehand
prose can't be updated without rewriting the doc and losing content.

Mark every slice on its container element:

```html
<section data-slice="2" data-status="done">
  <h2>Slice 2 — wire the service layer <span class="chip chip-done">done</span></h2>
  <p class="meta">PR #245 · <code>5b00c01</code></p>
```

- `data-status` is one of `planned`, `active`, `done`. The visible chip must agree with it.
- A `done` slice carries its PR number and short SHA — that's the evidence it shipped.
- Chip colors from the palette below: `planned` overlay0, `active` yellow, `done` green.
  Chip text is crust `#11111b`, never white.
- Put `data-updated="<YYYY-MM-DD HH:MM>"` on `<body>` and show it in the footer, so a
  stale artifact is obvious on sight.

When refreshing: change only the slices whose state actually changed, plus the summary
line and `data-updated`. Leave everything else byte-identical. If the landed commits
have nothing to do with the artifact, say so and change nothing — never invent status.

This is the general rule for any edit to an already-published artifact, not just slice
refreshes: touch only what the request or the new status requires and leave the rest of
the file byte-identical. A small requested change (a number, a line, one section) isn't
license to also rewrite phrasing, resize headers, or "improve" parts nobody asked about.

Artifacts are pruned after 7 days without an update, so a doc that keeps getting
refreshed as work lands stays put and an abandoned one clears itself out. Executable
files in the artifacts directory are never pruned — a generated script is a tool, not
a report. If you write one there, `chmod +x` it or it will age out with the docs.

## Output rules

- **Local by default.** Write one self-contained `.html` file to `~/.claude/artifacts/` and tell Daniel the path.
  - If that directory doesn't exist yet, create it first — don't skip the artifact because the directory is missing.
- **The link goes last.** Write the plan out in the chat first, then write the HTML file, then close the reply with the path — a bare link line, nothing after it. If the link lands above the written plan, Daniel has to scroll back up through the plan to open the file.
- **Never publish to claude.ai** or call the Artifact tool unless Daniel explicitly asks for it. Serving an artifact inside the homelab is not publishing — see *Where the link points* below; the rule is about claude.ai, not about the LAN.
- **Self-contained.** Inline all CSS; no external fonts, scripts, or network assets — it must render offline from `file://`. A minimal skeleton:
  ```html
  <!doctype html><html><head><meta charset="utf-8"><title>Short Descriptive Title</title>
  <style>/* all CSS inline here */</style></head>
  <body><!-- content --></body></html>
  ```
- **Give every artifact a `<title>`.** It is the name the artifacts browser lists and searches on, and the only field it cannot derive from anything else — without one the entry degrades to a slug of the filename. Write the same words as the `<h1>`.
- **Declare the metadata block.** Four `<meta>` tags in the `<head>`, described under *Searchable metadata* below.
- **Filename**: `<slug>_<YYYY-MM-DD>.html`.
- Always still deliver the written plan/spec in the chat. The artifact is a readability aid, never a replacement — if you only render the HTML and skip the chat version, you've failed the task.

## Searchable metadata

The browser filters and searches on four fields. Declare them in the `<head>`:

```html
<meta name="artifact:category" content="backup">
<meta name="artifact:status"   content="active">
<meta name="artifact:services" content="longhorn, traefik">
<meta name="artifact:tags"     content="b2, retention, cost-cap">
```

A Markdown artifact declares the same four as YAML frontmatter (`category: backup`) at the
top of the file.

| field | values | notes |
|---|---|---|
| `category` | `infra` `security` `backup` `network` `monitoring` `cost` `home-automation` `tooling` `ci` | one only; pick the subject, not the surface it touches |
| `status` | `planned` `active` `done` | the same three tokens the slice chips use — deliberately not a second vocabulary |
| `services` | the names this repo uses — `longhorn`, `sonarr`, `wg-easy` | what the document is *about*, not every service it mentions in passing |
| `tags` | free-form | the only field with no derivation, so it is the one that carries what nothing else can — an incident, a PR, a decision |

**Why declare what the indexer can guess.** It guesses so the several dozen artifacts written
before this existed are still findable, and derived values are marked as derived in the UI. A
guess is not as good as a statement: it reads the words you happened to use, so a document
that mentions Longhorn while being about B2 spend lands under `backup` rather than `cost`.
Declaring costs four lines and ends the ambiguity.

**Don't tag every service you name.** A review touching a dozen services is *about* two or
three. The indexer caps derived services at five, most-mentioned first; a declared list is
taken as written, so keep it to the subject.

## Where the link points

Writing the file is the same everywhere; only the closing link differs, and `link-artifact.sh`
picks it — you never construct the URL yourself. Take the link that hook hands you.

| Where the session runs | The link | Served by |
|---|---|---|
| daniel-box / daniel-server | `https://artifacts.local.daniel-hunter.com/a/<host>/<file>` | the cluster, behind Authelia |
| Any other Linux host | `http://127.0.0.1:8181/<file>` | `serve-artifacts.sh`, a loopback server |
| macOS | `file://<abs path>` | the filesystem |

The cluster route is an addition, not a replacement. The loopback server stays installed on
every Linux host and is the fallback whenever the cluster route or its pod is down — so
nothing about a local, non-server session changes.

Two things worth knowing when you serve one:

- **Search reads the metadata this skill already requires.** `<title>`, `data-updated` and the
  `data-status` chips are indexed and are what the browser filters on, so the slice markers
  above earn their keep twice.
- **A daniel-server artifact takes up to 5 minutes to appear.** Only daniel-box mounts its own
  tree directly; daniel-server's copy is rsynced across by a cron there. The file is written
  and the local link works immediately either way.

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
- Let structure encode information, not decorate it. Don't add `01 / 02 / 03` numbering or step markers unless the content is genuinely a sequence where order carries meaning. Every element earns its place — don't pad with filler sections or restate the summary as a sidebar just to fill space.
- Avoid AI-slop tropes: no gradient backgrounds, no rounded-corner cards with a left-border accent stripe (the single most recognizable LLM-report tic), no decorative icon-in-a-circle bullets.

## CSS gotcha

- Watch selector specificity when hand-authoring inline CSS. A type-based selector (`.section`) and an element-based one (`.cta`) can silently cancel each other's padding/margins, most often on spacing between sections. Keep spacing rules on one consistent selector layer.

## Writing

The prose in the artifact is design material, not filler — apply the same care as the layout:
- Active voice; name things by what the reader controls or recognizes, not by how the system is built.
- Sentence case, plain verbs, no filler; each element does one job (a label labels, a caption demonstrates).
- Be specific over clever — a precise summary line beats a punchy one.
