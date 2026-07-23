---
name: skill-router
description: Ask which skill or flow fits your situation — a router over Daniel's installed skills. Invoke as /skill-router when you have a task and can't remember what to reach for.
disable-model-invocation: true
metadata:
    author: daniel
    version: 0.1.0
---

# Skill Router

You don't remember every skill, so ask. This names the skills worth reaching for and
*when* — organised by **lane**, a path through the skills rather than a single one.
It does no work itself; it orients, then hands off to the skill that does the job.

> Hand-curated. When it drifts from what's installed, reconcile against
> `ls ~/.claude/skills` + the plugin list (`/config-map` renders the full surface).

## Main flow: idea → ship

1. **Sharpen** — `superpowers:brainstorming` (no plan yet, generate one) or **`grilling`**
   (a plan exists, stress-test it). `/prep` is the intake gate for non-trivial work and
   delegates its questioning to `grilling`.
2. **Write it up** — **`to-spec`** turns the thread into a spec on Jira PROC;
   `superpowers:writing-plans` for a local plan not headed to the tracker.
3. **Slice it** — **`to-tickets`** breaks a spec into tracer-bullet tickets with blocking edges.
4. **Build** — the `implementer` agent, `superpowers:executing-plans`, or
   `superpowers:test-driven-development` for a single behaviour test-first.
5. **Check** — `/code-review` (working diff) or `/review` (a PR); `/security-review` +
   `security-sweep` before merging anything touching auth/crypto/data/PCI; `/simplify` for
   cleanup-only; `/verify` to drive the change end-to-end.

## On-ramps (work that arrives, then merges onto the main flow)

- **Raw bugs / requests piling up** → **`triage`** (PROC/IT). Only for issues you didn't
  create; `to-tickets` output is already agent-ready.
- **Feedback waiting on your PRs** → `/pr-feedback`. Stacked PRs → `gh-stack`.
- **On-call / incident** → `incident-response`, or the `ops-investigator` agent (Grafana /
  PagerDuty / Loki). ACH/DLQ runbooks → `privacy-eng-tools:*`.

## Vocabulary layer (runs underneath other skills)

- **`domain-modeling`** — pin down a term or record an ADR. Vault is the store of record
  (`Work/Glossary.md`, `Work/Decisions.md`).
- **`codebase-design`** — deep-module vocabulary (seam, depth, leverage) for interface design.

## Vault (LLM Wiki)

`vault-lookup` to pull team/service/ops/people context · `/ingest` raw material ·
`remember` before `/clear` · `/lint` `/rebuild` maintenance · `service-context`
maps a Processing service → repo/dashboards/runbooks.

## Config / meta

`/config-lint` (drift audit) · `/config-map` (render the whole config surface) ·
`/changelog-watch` (new CC releases → setup ideas) · `/reprime` (re-center on rules mid-session) ·
`/writing-great-skills` (authoring reference) · `/audit-permissions` · `/update-config`.

## Standalones

`/deep-understanding` (learn something deeply) · `/deep-research` (multi-source cited report) ·
`/artifact-design` (render a plan as HTML) · `/distill-scan` (turn review findings into a
pre-commit scan) · `dataviz` (any chart) · `/claude-api` (Anthropic SDK reference).

## How to use me

Describe the situation. I place you on the right lane at the right step and hand off — I
don't grill, spec, or fix. If you already know the skill, skip me and invoke it directly.
