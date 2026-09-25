# 0001 — Skills adapted from mattpocock/skills are hand-authored, not installed

**Status:** accepted (2026-07-14). #622 (2026-09-25) deleted `skill-router`, `grilling`,
`domain-modeling` and `codebase-design`, which had no recorded invocation; the hand-authoring
decision still governs `writing-great-skills`.

## Context

`mattpocock/skills` ships as a Claude plugin marketplace, so installing it directly was
an option. But those skills are TS/product-oriented, unwired to Jira PROC or the vault,
and several duplicate skills already installed via superpowers.

## Decision

Hand-author adapted versions rather than install the plugin. Personal (stack-agnostic)
skills live in this repo under `home/private_dot_claude/skills/`; Jira-wired skills live
in `~/work-laptop-config`.

Invocation modes (per the `writing-great-skills` lens — context load vs cognitive load):
- **User-invoked** (`disable-model-invocation: true`): `skill-router`, `writing-great-skills`.
  A router pays no context load and cures the cognitive-load sprawl of many user-invoked skills.
- **Model-invoked**: `grilling` (interview primitive other skills reach), `domain-modeling`,
  `codebase-design` (vocabulary layers reached by name or by other skills).

Durable domain knowledge these skills produce is written to the **vault** as the store of
record (`Work/Glossary.md` for terms, `Work/Decisions.md` for domain ADRs), not to fresh
repo files.

## Consequences

- Skills match this setup's conventions and stay in sync with the vault, at the cost of
  manual authoring + maintenance (no `npx skills update`).
- The router is a hand-curated index; it drifts as skills are added/removed — reconcile
  against `ls ~/.claude/skills` + the plugin list periodically.
