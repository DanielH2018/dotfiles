---
description: "Lint: read-only health check of the LLM Wiki (index, frontmatter, wikilinks, contradictions). Proposes repairs; applies none without approval."
---

Lint: Health check the LLM Wiki vault and report what is wrong.

**Lint observes; it does not repair.** Every step below is read-only — no page
edits, no log entry, no new files. Steps that can identify a mechanical fix
record it as a *proposal* and move on. STEP 9 presents the proposals; nothing is
written until the caller approves them. This split exists so "safe fix" cannot
quietly widen into "fix I did not ask for", and so a lint run is always safe to
execute against a vault you have not looked at yet.

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

For every wiki page (all .md files, same exclusion set as STEP 2):
Required fields: `title`, `summary`, `tags`, `created`, `updated`

Flag any missing fields. If `created` or `updated` are missing and can be inferred, fill them in. Otherwise flag for human review.

**Optional — source discipline (off by default).** Only if `$VAULT/.claude/wiki-context.local.md` contains a `§ Source discipline` section with `require_sources: true`, additionally check, for every factual page:
- Missing or empty `sources` field → flag (every factual page should cite ≥1 source).
- Missing `confidence` field (expected `high` | `medium` | `low`) → flag.
- `confidence: high` with fewer than two `sources` → flag (claimed confidence contradicts the evidence).

Flag only — never auto-fill `sources` or `confidence`; a human sets them. When the `§ Source discipline` section is absent, skip these checks entirely (zero output).

STEP 4 — Link integrity (broken links, single-match repair proposal, orphans)

**4a. Find broken links.** Scan all pages for `[[wikilink]]` / `[[wikilink|alias]]` patterns (and any markdown relative-path links). For each, verify the target resolves to an existing page.

**4b. Propose a fix — only on an unambiguous single match.** When a link does not resolve, look for the intended target:
- Wikilink `[[X]]`: normalize (spaces↔underscores, case-insensitive) and match against existing page names.
- Markdown path link: search the vault for a file with that basename.

If **exactly one** page matches → record a proposed rewrite of the link to that canonical name/path (this heals renames and spacing/case drift). Do not apply it here. If **zero or multiple** match → do NOT guess; report source file + broken link text for human review (may need a new page created).

**4c. Orphan pages (report only).** Build the wikilink graph and flag any wiki page with **zero inbound `[[wikilinks]]`** from other pages (exclude index.md, log.md, log_archive_*, and self-links). Note: being listed in index.md does **not** count as an inbound link — an indexed page can still be a graph orphan. Report orphans as candidates to cross-link or retire; do not auto-fix.

STEP 5 — Flag contradictions

Cross-check key facts across pages:
- Same person with different roles across pages
- Same repo or service described differently
- Statuses or dates that conflict

Report contradictions. Do not auto-fix — flag for human review.

STEP 6 — Flag future-dated `updated` fields

Flag any page with `updated:` set to a date after `today`. Record a proposed reset to `today`. Do not apply it here.

STEP 7 — Flag stale / superseded notes (temporal validity)

For every wiki page, check the optional temporal-validity frontmatter (see CLAUDE.md → Note Format):
- `valid_until` set and earlier than `today` → flag as **stale** (facts presumed out of date).
- `superseded_by` present → flag as **superseded** (should be read as history, not current truth).

Report both lists for human review. Do not auto-fix — deciding whether a fact is still true, or a supersession is complete, needs human judgment.

STEP 8 — Writing-style check (flag only)

Scan wiki-page prose (skip frontmatter, code blocks, tables, and wikilinks) for "AI-writing" tells, so Claude-authored pages read like notes, not boilerplate. Read `~/.claude/rules/anti-slop.md` and apply it to the prose — its `paths:` frontmatter scopes it to code file extensions, so it does NOT auto-load for wiki Markdown; this step must read it explicitly. Flag — do **not** auto-rewrite; rewriting prose can change meaning. Report per file the offending snippet + which pattern it matched.

Keep this a lightweight signal, not a witch-hunt — flag clear cases, and a short count ("3 style flags across 2 pages") is enough.

STEP 9 — Present the repair proposal

Report every finding, grouped by impact: broken navigation, ambiguous
resolution, metadata quality, then maintainability. Preserve exact paths, line
numbers, and counts — do not summarize them away, and do not claim a check ran
that did not.

Then list the proposed repairs from STEP 4b and STEP 6 as a numbered set, each
showing file, line, current text, and replacement. Only these two classes are
ever proposable; contradictions (STEP 5), stale/superseded notes (STEP 7), and
style flags (STEP 8) need human judgment and are report-only.

**Stop here.** Do not apply anything, and do not write the log entry. If the
caller has already authorized specific repair classes — `/healthcheck` does this
for its unattended run — apply exactly those and continue to STEP 10. Otherwise
wait for the user to choose, then apply only what they selected.

If nothing was applied, say so and end the run: an observation leaves no trace
in the vault.

STEP 10 — Prepend to log (only if repairs were applied)

Skip this step entirely when STEP 9 applied nothing — a read-only run does not
write history.

Prepend a new entry to `$VAULT/log.md` (insert below the `---` separator, above the previous top entry — newest first):
## YYYY-MM-DD — lint (health check)
- Index completeness: <result>
- Frontmatter compliance: <result>
- Link integrity (broken / repaired): <result>
- Orphan pages: <result>
- Contradictions: <result>
- Future-dated fields: <result>
- Stale / superseded notes: <result>
- Writing-style flags: <result>
- Source discipline (only if enabled): <result>
- Repaired (approved): <list or "none">
- Needs human review: <list or "none">
