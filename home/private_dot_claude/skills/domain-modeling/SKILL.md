---
name: domain-modeling
description: Use when pinning down domain terminology / ubiquitous language, resolving an overloaded term, or recording a hard-to-reverse architectural decision. Trigger when two people mean different things by a word, a term is doing several jobs, or a design keeps snagging on an unnamed concept. The vault is the store of record — read the Glossary before coining, source-verify before writing. Another skill needing to record a term or decision reaches for this.
metadata:
    author: daniel
    version: 0.1.0
---

# Domain Modeling

Actively build and sharpen the project's domain model *as you design* — challenge
fuzzy terms, stress-test relationships with concrete scenarios, and write the
resolved term or decision down the moment it crystallises. This is the **active**
discipline. Merely reading the Glossary for vocabulary is a one-line habit any skill
does; reach for *this* skill when you are **changing** the model — coining a canonical
term, catching a contradiction between the code and what was just said, recording a
consequential decision.

## The vault is the store of record

Durable, cross-repo knowledge lives in the vault (`~/Documents/My_Vault`), not in a
fresh repo file. Follow the shared write conventions in
`~/Documents/My_Vault/docs/wiki-write.md` (frontmatter schema, `updated:` bump,
`[[wikilinks]]`, newest-first `log.md` prepend).

- **Terms → `Work/Glossary.md`.** This is the canonical ubiquitous-language store and
  it already grows as terms come up. **Read it first** before coining anything — the
  term may already exist. The repo-local exception: a term meaningful only inside one
  code repo's implementation stays in that repo's `CONTEXT.md`.
- **Decisions (ADRs) → `Work/Decisions.md`** (create it lazily on the first ADR). A
  code repo *may* carry a lightweight pointer back to the vault decision (a stub
  `docs/adr/NNNN.md` or a code comment) when it helps a repo reader — a **pointer, not
  a copy**.

## Provenance guard

The Glossary is built from **source-verified** lookups (code, Notion, Lithic API docs,
Slack), *not* from model memory or other vault pages. Before adding a term, verify it
against a primary source and cite it. Never write a definition you can't source. The
move that makes it click: when the user states how something works, cross-reference the
code and surface any contradiction — "your code cancels the whole authorization, but you
said partial reversal is possible — which is right?"

## Write mode: small direct, large staged

- **Small** (a term, one ADR): write the vault page directly per `docs/wiki-write.md`
  (frontmatter, `updated:` bump, `[[wikilinks]]`, `log.md` prepend). State that you're
  writing directly.
- **Large** (a whole service write-up, a multi-term batch): stage a note to
  `~/Documents/My_Vault/raw/` and flag that `/ingest` should integrate it on the wiki's
  own terms. State that you're staging.

## The ADR bar

Offer an ADR only when the choice is **hard to reverse**, **surprising without context**,
*and* **the result of a real trade-off**. Miss any one and there's no ADR — that's what
keeps `Work/Decisions.md` a record of consequential forks, not a diary.

## Where it fits

The vocabulary layer that runs *underneath* other skills. [[to-spec]] and [[to-tickets]]
write in the Glossary's terms; [[codebase-design]] is its neighbour for *module* shape
(seams, depth) rather than *domain* language. When unsure which skill fits, `/skill-router`.
