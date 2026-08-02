# docs

Design and implementation records for this repo. **Not deployed** — chezmoi's source root is
`home/`, so everything here is a plain repo file.

## Layout

| Directory | Holds |
|---|---|
| `specs/` | Designs and specs, `YYYY-MM-DD-kebab-title.md` |
| `plans/` | Implementation plans, same naming |
| `decisions/` | ADRs (`NNNN-kebab-title.md`) and `rejected-ideas.md` |
| `RESTORE.md` | Bare-metal bootstrap — living document, not dated |

A spec and its plan share a date prefix and stem, so they sort next to each other:
`specs/2026-07-08-subagent-evals-design.md` ↔ `plans/2026-07-08-subagent-evals.md`.

## Retirement policy

A spec or plan is a record of *why*, so landing the work does not retire the doc — it stays
as the rationale a future reader needs. Delete one only when it describes something that no
longer exists, or when it was never executed and the idea has been dropped.

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
