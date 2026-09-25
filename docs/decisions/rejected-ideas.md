# mattpocock/skills — ideas considered and rejected

Recorded 2026-07-14 during the adaptation project (see chezmoi ADR 0001).

- **Install Matt's plugin marketplace as-is** — rejected. TS/product-oriented, unwired to
  Jira/vault, duplicates superpowers. Hand-authored adapted versions instead.
- **`.changeset/` release tooling** — rejected. npm-release machinery for Matt's plugin
  distribution; irrelevant to chezmoi/symlink deploys. Existing commit discipline covers it.
- **`wayfinder`** — deferred, not adopted this round. Decision-mapping onto the tracker for
  foggy multi-session efforts; revisit if a build gets too big to spec in one sitting.
- **Inventing triage-role Jira labels** (`ready-for-agent`, etc.) — rejected. Would pollute
  shared team label taxonomy; PROC's native status workflow is used instead (see work-repo ADR 0001).
- **Replacing superpowers skills** (brainstorming/writing-plans/tdd) — rejected. Kept in
  parallel.
