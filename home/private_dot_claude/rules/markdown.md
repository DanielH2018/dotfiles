---
paths:
  - "**/*.md"
---
Markdown, adapted from Google's Markdown style guide
(<https://google.github.io/styleguide/docguide/style.md>) and documentation best practices
(<https://google.github.io/styleguide/docguide/best_practices.md>). The prose rules in the
user-level `CLAUDE.md` govern the sentences; this file governs the structure.

- **Minimum viable documentation.** A small set of fresh, accurate pages beats a sprawl in
  varying states of repair. Delete a page you know is wrong rather than leave it; link to an
  existing guide rather than duplicate it.
- **Layout:** one H1 as the title (matching the filename where possible), a one-to-three
  sentence introduction, then H2+ sections. Add a table of contents only when the page runs
  below the fold. A "See also" section goes last.
- **Headings are ATX (`#`), unique, and spaced.** Never underline with `=`/`-`. A blank line
  above and below every heading. Name a heading so it stands alone: "Foo example", not a
  second "Example".
- **Lists:** lazy numbering (`1.` on every item) for a list that changes often. Nest with
  4-space indents so wrapped text and nested lists line up under the item text.
- **Code:** backticks for any inline identifier, filename, command or example URL. Fenced
  blocks, never indented ones, and always declare the language. A code block inside a list
  item is indented to the item's text. Long copy-paste commands break lines with a trailing
  `\`.
- **Links carry their meaning in the text.** Wrap the phrase that names the target, never
  "here" or "link". Prefer a reference link when the URL is long or reused, and define it just
  before the next heading rather than at the foot of the page, unless several sections share
  it. Use an explicit path from the repo root for an internal link; avoid `../../` chains.
- **Prefer a list to a table.** A table is for uniform, scannable, tabular data. Sparse
  cells, few rows against many columns, or prose in a cell mean it should have been a list
  with subheadings.
- **Prefer Markdown to HTML.** HTML costs readability and portability, and some renderers
  drop it.
- **80-character lines,** except links, tables, headings and code blocks. No trailing
  whitespace; a hard line break is a trailing `\`.
- **Images sparingly,** each with alt text that says what a reader who cannot see it needs.
- **Keep product and tool capitalisation** as the product spells it: `Markdown`, not
  `markdown`.
