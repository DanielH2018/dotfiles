---
description: "Lint: health-check the LLM Wiki (index, frontmatter, wikilinks, contradictions) and fix safe issues."
---

Lint: Health check the LLM Wiki vault and fix safe issues automatically.

STEP 0 — Resolve the vault

Resolve the vault directory: `${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}`. If that
directory does not exist, report "no vault present — skipping /lint" and stop; do not
create it or touch any other path. Call the resolved path `$VAULT` for the rest of
this command.

STEP 1 — Get today's date

```
python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%d'))"
```

Call this value `today`.

STEP 2 — Verify index completeness (both directions)

Read `$VAULT/index.md`.

- List all pages referenced in index.md (the [[wikilink]] entries)
- List all .md files in the vault, applying the vault's **exclusion set**. Use the
  set defined in `$VAULT/.claude/wiki-context.local.md` (§ "Lint exclusions") if that
  file exists; otherwise fall back to the generic defaults: `index.md`, `log.md`,
  `log_archive_*.md`, `CLAUDE.md`, and the directories `raw/`, `.claude/`,
  `.obsidian/`, `docs/`.
- Flag pages listed in index.md with no corresponding file → needs human review
- Flag .md files not listed in index.md → auto-add to index.md

STEP 3 — Check frontmatter compliance

For every wiki page (all .md files, using the same exclusion set as STEP 2 — from `$VAULT/.claude/wiki-context.local.md` if present, else the generic defaults above):
Required fields: `title`, `summary`, `tags`, `created`, `updated`

Flag any missing fields. If `created` or `updated` are missing and can be inferred, fill them in. Otherwise flag for human review.

STEP 4 — Link integrity (broken links, single-match auto-fix, orphans)

**4a. Find broken links.** Scan all pages for `[[wikilink]]` / `[[wikilink|alias]]` patterns (and any markdown relative-path links). For each, verify the target resolves to an existing page.

**4b. Auto-fix — only on an unambiguous single match.** When a link does not resolve, look for the intended target:
- Wikilink `[[X]]`: normalize (spaces↔underscores, case-insensitive) and match against existing page names.
- Markdown path link: search the vault for a file with that basename.

If **exactly one** page matches → auto-fix the link to the canonical name/path (this heals renames and spacing/case drift). If **zero or multiple** match → do NOT guess; report source file + broken link text for human review (may need a new page created).

**4c. Orphan pages (report only).** Build the wikilink graph and flag any wiki page with **zero inbound `[[wikilinks]]`** from other pages (exclude index.md, log.md, log_archive_*, and self-links). Note: being listed in index.md does **not** count as an inbound link — an indexed page can still be a graph orphan. Report orphans as candidates to cross-link or retire; do not auto-fix.

STEP 5 — Flag contradictions

Cross-check key facts across pages:
- Same person with different roles across pages
- Same repo or service described differently
- Statuses or dates that conflict

Report contradictions. Do not auto-fix — flag for human review.

STEP 6 — Fix future-dated `updated` fields

Flag any page with `updated:` set to a date after `today`. Auto-fix: reset to `today`.

STEP 7 — Flag stale / superseded notes (temporal validity)

For every wiki page, check the optional temporal-validity frontmatter (see CLAUDE.md → Note Format):
- `valid_until` set and earlier than `today` → flag as **stale** (facts presumed out of date).
- `superseded_by` present → flag as **superseded** (should be read as history, not current truth).

Report both lists for human review. Do not auto-fix — deciding whether a fact is still true, or a supersession is complete, needs human judgment.

STEP 8 — Writing-style check (flag only)

Scan wiki-page prose (skip frontmatter, code blocks, tables, and wikilinks) for "AI-writing" tells, so Claude-authored pages read like notes, not boilerplate. Flag — do **not** auto-rewrite; rewriting prose can change meaning. Report per file the offending snippet + which pattern it matched. Patterns (case-insensitive), adapted from `avoid-ai-writing`:

- **Significance inflation** — "plays a vital/crucial/pivotal role", "stands as a testament", "is a game-changer", "in today's fast-paced world".
- **Vague attribution** — "experts say", "it is widely regarded", "studies show" with no source (vault facts should cite `[[Page]]` or an MCP source).
- **Promotional filler** — "seamless", "robust", "cutting-edge", "leverage the power of", "unlock", "elevate", "delve into", "navigate the complexities".
- **Hedged nothing-statements** — "it's important to note that", "it's worth mentioning that", "when it comes to".
- **Rule-of-three padding & rhetorical questions** — reflexive tricolons and "But what does this mean?"-style questions.
- **Formatting tells** — em-dash pile-ups used for drama, emoji as section markers, "Certainly!/Great question!"-style openers, closing "In summary/In conclusion" recaps on a short note.
- **Unfilled placeholders** — literal "[TODO]", "[insert …]", "lorem ipsum", "XXX".

Keep this a lightweight signal, not a witch-hunt — flag clear cases, and a short count ("3 style flags across 2 pages") is enough.

STEP 9 — Auto-fix safe issues

Execute all auto-fixes identified above:
- Reset future-dated `updated` fields to `today`
- Add unlisted .md files to index.md with an appropriate one-line summary
- Fill in inferable missing frontmatter fields
- Repair broken links that resolve to exactly one page (renamed/normalized target); leave zero- or multiple-match links for human review

STEP 10 — Prepend to log

Prepend a new entry to `$VAULT/log.md` (insert below the `---` separator, above the previous top entry — newest first):
## YYYY-MM-DD — lint (health check)
- Index completeness: <result>
- Frontmatter compliance: <result>
- Link integrity (broken / auto-fixed): <result>
- Orphan pages: <result>
- Contradictions: <result>
- Future-dated fields: <result>
- Stale / superseded notes: <result>
- Writing-style flags: <result>
- Auto-fixed: <list or "none">
- Needs human review: <list or "none">
