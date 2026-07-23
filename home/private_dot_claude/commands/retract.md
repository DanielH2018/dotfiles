---
description: "Retract: remove a discredited source from the LLM Wiki — map its blast radius, flag dependent claims, archive the raw source (reversibly), and optionally recompile."
argument-hint: "<source-url-or-raw-filename> [--recompile]"
---

Retract a source that turned out to be wrong or discredited from the LLM Wiki: find
everywhere it is cited, flag the claims that depended on it (so they read as untrusted
rather than silently wrong), archive the raw source reversibly, and log the retraction.
Optionally recompile the affected sections from the surviving sources.

STEP 0 — Resolve the vault

Resolve the vault directory: `${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}`. If that
directory does not exist, report "no vault present — skipping /retract" and stop; do not
create it or touch any other path. Call the resolved path `$VAULT` for the rest of this
command.

STEP 1 — Identify the source and parse flags

Read `$ARGUMENTS`. Extract the source identifier (either a URL, or a filename under
`$VAULT/raw/`) and whether `--recompile` was passed. If no identifier is given, ask which
source to retract and stop. Resolve the identifier to both forms it may appear as:

- the **raw file** under `$VAULT/raw/` (if the source was ingested), and
- the **citation string** used in pages — the URL, and any `[[raw/...]]` wikilink or
  relative markdown link to the raw file.

Get today's date:
```
python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%d'))"
```
Call this value `today`.

STEP 2 — Map the blast radius

Grep the whole vault (exclude `.obsidian/`, `.claude/`, and `raw/` itself) for every
occurrence of the source — search for BOTH the URL and the raw filename/wikilink, since a
page may cite either. Classify each hit:

- **frontmatter** — the source appears in a page's frontmatter (e.g. a `sources` list)
- **body-inline** — cited in prose, a footnote, or as the basis for a specific claim
- **see-also / index** — referenced from `index.md` or a page's see-also list

Build a table: file · line · hit-type · the one-line claim that depends on it.

STEP 3 — Present the plan and get approval (gate)

Show the blast-radius table and the exact actions you will take (claims to flag, the raw
file to archive, and — if `--recompile` — the sections to rewrite). **Do not proceed to
any destructive or irreversible step (STEP 4–6) without explicit user approval**, exactly
as `/rebuild` STEP 5 does.

STEP 4 — Flag dependent claims

For each frontmatter and body-inline hit, make the dependency visible rather than deleting
anything:

- Insert an HTML comment marker on the line immediately above the claim:
  `<!-- RETRACTED-SOURCE: <identifier> (retracted YYYY-MM-DD) -->`
- Remove the source from any `sources` frontmatter list on the page.
- Do **not** delete the claim text — a human decides whether it survives on other
  evidence. Update the page's `updated` field to `today`.

STEP 5 — Archive the raw source (reversible)

If a raw file exists, move it to `$VAULT/raw/.retracted/<filename>` (create the directory
if needed) rather than hard-deleting it — retraction must be reversible and auditable.
If the source is an external URL with no raw file, skip this step.

STEP 6 — Recompile (only with `--recompile`)

For each page carrying flagged claims, re-derive the affected sections from the remaining
(non-retracted) sources only. If a claim has no surviving source, leave it flagged for
human review — do not delete it. Update each changed page's `updated` field to `today`.

STEP 7 — Prepend to log

Prepend a new entry to `$VAULT/log.md` (insert below the `---` separator, above the
previous top entry — newest first):
## YYYY-MM-DD — retract (<identifier>)
- Source: <identifier>
- Occurrences: <n> (frontmatter <a> / inline <b> / see-also <c>)
- Claims flagged: <list of file — claim, or "none">
- Raw source archived to: raw/.retracted/<filename> (or "external URL — no raw file")
- Recompiled: <list of pages, or "no (re-run with --recompile)">
- Needs human review: <claims left with no surviving source, or "none">
