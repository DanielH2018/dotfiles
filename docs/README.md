# docs

Design and implementation records for this repo. **Not deployed** — chezmoi's source root is
`home/`, so everything here is a plain repo file.

## Layout

| Directory | Holds |
|---|---|
| `specs/` | Designs and specs, `YYYY-MM-DD-kebab-title.md` |
| `plans/` | Implementation plans whose work has not landed yet, same naming |
| `decisions/` | ADRs (`NNNN-kebab-title.md`) and `rejected-ideas.md` |
| `RESTORE.md` | Bare-metal bootstrap — living document, not dated |

A spec and its plan share a date prefix and stem, so they sort next to each other:
`specs/2026-09-06-claude-guard-design.md` ↔ `plans/2026-09-06-claude-guard-slice-…md`.

## Retirement policy

A spec is a record of *why*, so landing the work does not retire it — it stays as the
rationale a future reader needs. Delete a spec only when it describes something that no longer
exists, or when it was never executed and the idea has been dropped.

A plan is a record of *how*, step by step, and once its work lands the code and the spec say
the same thing better. Delete a plan when its work lands, and point any inbound reference at a
sha-pinned copy (`git show <sha>:docs/plans/<file>`). In #694 this removed 12 plans (18,362
lines). A plan that is still cited from code stays until the citation moves.

If a doc is superseded rather than obsolete, say so in a line at the top of the old one and
link the replacement, rather than deleting it.

## The bar for an ADR

Record a decision only when the choice is **hard to reverse**, **surprising without
context**, *and* the result of a **real trade-off**. Miss any one and it is not an ADR — it
is a commit message.

Rejected ideas go in `decisions/rejected-ideas.md`, one section each. Writing the "no" down
stops it being re-litigated every time the idea resurfaces.

## Scope

These are decisions about *this repo's* config. Work and domain decisions live in the vault
(`Work/Decisions.md`), not here.
