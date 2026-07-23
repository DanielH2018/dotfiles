---
description: "Rebuild: reorganize the LLM Wiki — merge stubs, split broad pages, regenerate index.md."
---

Rebuild: Reorganize the LLM Wiki vault — merge stub pages, split over-broad pages, regenerate index.md.

STEP 0 — Resolve the vault

Resolve the vault directory: `${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}`. If that
directory does not exist, report "no vault present — skipping /rebuild" and stop; do
not create it or touch any other path. Call the resolved path `$VAULT` for the rest
of this command.

STEP 1 — Run lint

Execute the full lint check (/lint STEP 1–6) to get a baseline health report before restructuring. Fix all safe issues now so the rebuild starts from a clean state.

STEP 2 — Read all wiki pages

Read every page in the vault (all .md files except index.md, log.md, CLAUDE.md, raw/).

STEP 3 — Identify stub pages (candidates for merging)

Flag any page that:
- Has fewer than 100 words of content (excluding frontmatter and headings)
- Covers a single narrow concept that logically belongs inside another page

For each stub: identify the target page it should merge into.

STEP 4 — Identify over-broad pages (candidates for splitting)

Flag any page that:
- Covers 2+ clearly distinct topics that would each merit their own page
- Has major sections with no meaningful relationship to each other

For each over-broad page: identify the two (or more) pages it should split into.

STEP 5 — Present plan for approval

Present all proposed merges and splits to the user. Include:
- For merges: stub page → target page, rationale
- For splits: source page → new page A + new page B, rationale

**Do not proceed to STEP 6 without explicit user approval.**

STEP 6 — Execute approved changes

Get today's date:
```
python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%d'))"
```

For each approved **merge**:
- Read both source pages (if not already read)
- Integrate merged-away content into the target page
- Update target page's `updated` frontmatter field to today
- Remove the merged-away page's entry from index.md
- Delete the merged-away file
- Find and update all wikilinks pointing to the deleted page

For each approved **split**:
- Create two new pages with proper frontmatter (created + updated = today)
- Add both to index.md with one-line summaries
- Add backlinks from related pages
- Delete or stub-out the original file

**Source discipline (only if enabled** — a `§ Source discipline` section with
`require_sources: true` in `$VAULT/.claude/wiki-context.local.md`; skip otherwise):
- On **merge**: union the source pages' `sources` into the target and set the target's
  `confidence` to the lowest of the merged pages (a merge is no more confident than its
  weakest input).
- On **split**: give each child the subset of the parent's `sources` it actually uses,
  and set each child's `confidence` no higher than the parent's.

STEP 7 — Regenerate index.md

Rewrite index.md from scratch based on actual vault contents after all changes. Preserve the existing format, folder groupings, and the Folders table at the bottom. Update summary lines for any pages that changed significantly.

STEP 8 — Prepend to log

Prepend a new entry to `$VAULT/log.md` (insert below the `---` separator, above the previous top entry — newest first):
## YYYY-MM-DD — rebuild
- Pages merged: <list or "none">
- Pages split: <list or "none">
- Pages created: <list or "none">
- Pages deleted: <list or "none">
- index.md regenerated: yes/no
- Key changes: <one-line summary>
