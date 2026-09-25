---
name: writing-great-skills
description: Use when authoring, editing, or debugging a SKILL.md — the vocabulary and principles that make a skill behave the same way every run. Trigger on writing a new skill, rewriting a description, or a skill that fires inconsistently.
metadata:
    author: daniel
    version: 0.1.0
---

# Writing Great Skills

A skill exists to wrangle **determinism** out of a stochastic system. The goal is not
the same *output* every run — it's the same *process*. **Predictability** is the root
virtue; judge every choice against it, not against how clever or exhaustive the skill
reads. (This is the principles reference; `superpowers:writing-skills` is the procedural
how-to for authoring one step by step. Reach for whichever the moment needs.)

## The two loads

Every skill spends one of two budgets — and most authoring decisions are the same trade
made in different places:

- **Model-invoked** — keeps a `description` in the window every turn, so the agent can
  fire it autonomously and other skills can reach it. Costs **context load**. Mechanics:
  omit `disable-model-invocation`; write a rich, trigger-heavy description.
- **User-invoked** — strips the description from the agent's reach; only you, typing its
  name, invoke it. Zero context load, but spends **cognitive load** — *you* are the index
  that must remember it exists. Mechanics: `disable-model-invocation: true`; the
  description becomes a one-line human-facing summary.

Pick model-invocation only when the agent (or another skill) must reach it on its own.
When user-invoked skills pile past what you can hold in your head, the cure is a **router**:
one skill that names the others and when to reach for each.

## Model-invoked descriptions fire on symptoms

Where a user-invoked description is a summary, a model-invoked one is the **entire invocation
mechanism** — so it has to match how the problem *presents*, not the deliberate action someone
would take if they already knew the skill existed. Anyone who can think "I'm about to land, load
the land skill" did not need the skill. The real moment is a bare error string, or a fix that
silently came back.

Before shipping one, list the two or three incidents that motivated it and write down how each
*first appeared* — the operator's actual words, the literal error text — then check the
description against those phrasings. Prospective triggers ("after X", "when Y fails") can stay,
but after the symptoms, not instead of them. The tell that you got this wrong is a skill whose
own author hits its exact failure and doesn't get it loaded.

## The other levers

- **Leading words** — a compact concept already in the model's pretraining (*tight*,
  *tracer bullet*, *seam*) that anchors execution and invocation in the fewest tokens.
  Front-load the skill's leading word in the description; retire restatements a single
  word can carry.
- **Information hierarchy** — the ladder: (1) in-skill step, (2) in-skill reference,
  (3) external reference behind a **context pointer**. **Progressive disclosure** is moving
  material down the ladder so the top stays legible. Push too little down and the top
  bloats; push too much and you hide what the agent needs.
- **Completion criteria** — end each step on a *checkable* condition ("every modified model
  accounted for", not "produce a list"). A vague criterion invites premature completion.
- **Pruning** — single source of truth, relevance, the no-op test, sentence by sentence.

## Failure modes to diagnose against

**Premature completion** (vague criterion lets the agent stop early) · **duplication**
(one branch written twice) · **sediment** (stale instructions never removed) · **sprawl**
(too many near-duplicate skills) · **no-op** (a sentence that changes nothing if deleted) ·
**dead trigger** (a model-invoked description keyed on an action only someone who already
knows the skill would take).

## Where it fits

The meta-skill you consult while building the rest of the set — not a step in a chain. Its
natural neighbour is any router, the direct cure for the cognitive load user-invoked skills
pile up.
