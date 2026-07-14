---
name: grilling
description: Use to stress-test a plan, design, or decision before building — a relentless one-question-at-a-time interview that walks the decision tree until you and the user share the same understanding. Trigger on "grill me", "poke holes in this", "stress-test this plan", "what am I missing", "interrogate this design", or whenever a plan feels roughly right but has unresolved decisions hiding in it. Other skills (prep, to-spec, to-tickets) reach for this as their interview primitive.
metadata:
    author: daniel
    version: 0.1.0
---

# Grilling

Interview the user relentlessly about a plan, design, or decision until you both
reach a **shared understanding**. This is the interview *primitive* — a technique
other skills borrow, not a workflow of its own.

## The rules

1. **One question at a time.** Ask, then wait for the answer before the next.
   A batch of questions is bewildering and loses the thread.
2. **Walk the decision tree in dependency order.** A plan branches into decisions,
   and decisions depend on each other. Settle a parent before the choices that hang
   off it — an early answer reshapes which questions come next.
3. **Carry your own recommended answer.** Every question comes with the answer you'd
   pick and why, so the user is reacting to a proposal, not staring at a blank prompt.
4. **Look up facts; ask only decisions.** If the environment can settle it — read the
   file, run the tool, grep the code — do that instead of asking. The *decisions* are
   the user's; put each one to them and wait.
5. **Don't act until confirmed.** No code, no tickets, no edits until the user says the
   shared understanding is reached. Grilling produces understanding, not deliverables.

## It's working if

- Questions arrive singly and in an order where each builds on the last.
- Anything checkable in the repo was checked, not asked.
- The user is confirming or overriding your recommendations, not generating answers cold.
- The session ends on an explicit "we agree" before anything gets built.

## Where it fits

The stateless stress-test under the build flow. `prep` delegates its questioning
here; [[to-spec]] and [[to-tickets]] grill the breakdown before publishing. For
open-ended ideation (no plan yet) reach for `superpowers:brainstorming` instead —
grilling hardens an existing plan, brainstorming generates one. When unsure which
skill fits, `/skill-router`.
