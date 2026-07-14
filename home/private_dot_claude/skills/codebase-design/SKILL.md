---
name: codebase-design
description: Use when designing or improving a module's interface, hunting for deepening opportunities, deciding where a seam goes, or making code more testable and AI-navigable. Provides the shared vocabulary — module, interface, depth, seam, adapter, leverage, locality — that keeps every design conversation precise. Another skill needing the deep-module vocabulary reaches for this.
metadata:
    author: daniel
    version: 0.1.0
---

# Codebase Design

Design **deep modules**: a lot of behaviour hidden behind a small interface, placed at
a clean seam, testable through that interface. This is a **language, not a procedure** —
it doesn't hand you a refactor plan, it fixes the words so every design conversation and
every skill that touches design speaks the same way.

## Glossary (use these exact terms)

Don't substitute "component," "service," "API," or "boundary" — they blur the
distinctions that matter.

- **Module** — anything with an interface and an implementation (function, class,
  package, tier-spanning slice). Scale-agnostic on purpose.
- **Interface** — *everything* a caller must know to use the module correctly: signature,
  yes, but also invariants, ordering, error modes, required config, performance. Not just
  the type surface.
- **Implementation** — what's inside. Distinct from the adapter that fills a seam.
- **Depth** — leverage at the interface: how much behaviour a caller (or test) exercises
  per unit of interface they must learn. **Deep** = small interface, large implementation;
  **shallow** = interface nearly as complex as the implementation.
- **Seam** (Feathers) — a place you can change behaviour *without editing there*. Where the
  seam goes is its own decision, separate from what sits behind it.
- **Adapter** — a concrete thing satisfying an interface at a seam. Names a *role*.
- **Leverage** — what callers get from depth: one implementation pays back across N call
  sites and M tests.
- **Locality** — what maintainers get: change, bugs, and verification concentrate in one
  place. Fix once, fixed everywhere.

## Two checks do most of the work

- **Deletion test** — imagine deleting the module. If complexity *vanishes*, it was a
  pass-through. If it *reappears across N callers*, it was earning its keep.
- **One adapter, two adapters** — one adapter means a *hypothetical* seam; two means a
  *real* one. Don't cut a seam until something actually varies across it.

The interface is the test surface: callers and tests cross the *same* seam, so a
well-placed interface gives tests something durable to aim at while the code underneath
moves freely. Prefer the highest seam possible; the fewer seams across a codebase, the better.

## Vault-wired

Read `~/Documents/My_Vault/Work/Codebase.md` for a service's existing architecture and
seams before designing. A durable seam map or design note you produce goes back there,
following the vault's conventions (see its `CLAUDE.md`). The vocabulary itself stays here —
this is a reference, not a workflow.

## Where it fits

The shared vocabulary layer under the engineering skills; its neighbour is
[[domain-modeling]] (the parallel vocabulary for the *problem domain* rather than *module
structure*). [[to-spec]] speaks it when sketching seams before a spec. When unsure which
skill fits, `/skill-router`.
