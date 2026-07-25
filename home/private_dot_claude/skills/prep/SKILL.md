---
name: prep
description: Use as the intake gate for a task that is vague, multi-file, or hard to reverse — gather context, surface unknowns, delegate the questioning to grilling, then confirm the approach before any edit. Precedes work; does not perform it. Invoked as /prep only.
disable-model-invocation: true
---

# Prep — intake before execution

Use this skill when a prompt is non-trivial — new feature, unfamiliar area,
multi-file change, or ambiguous scope. Reach for it before you touch code;
don't dive in. First understand the ask, pull the context yourself, surface
assumptions and gaps, confirm — then route to execution.

## Gate: pick a gear
- Trivial — one-sentence diff, or the prompt already names file + change + check. Skip intake; do the work.
- Large — multi-file, unfamiliar area, or a feature/design. Interview, write SPEC.md, suggest a fresh session.
- Medium — everything else. Produce the inline intake block, wait for `go`.
If the message says `go`, `just do it`, or `no intake`, skip to execution.

## Enrich (before asking anything)
- Repo/local: git log/blame on touched files, read referenced files, grep for patterns/similar code.
- Vault: invoke vault-lookup for team/service/ops/people/incident context.
- service-context: in a processing repo, map service → repo/dashboards/runbooks/pipeline.
- Live MCP (Jira/Slack-read/PagerDuty/Grafana): ONLY when the prompt references a ticket/incident/channel/dashboard. Never blanket.
Grounding: never claim anything about code/files you haven't opened; say so if undetermined.
Limitation: Enrich only surfaces what's already committed or already in the
vault — it won't catch context still in someone's head or an unlinked doc;
treat silence as "not found," not "doesn't exist."

## Medium gear — the intake block (then stop and wait)
- Understanding — one paragraph restating the task.
- Assumptions — the interpretation chosen where the ask was ambiguous; flag each.
- Context pulled — what enrich found, with file:line.
- Questions — at most 3, batched via AskUserQuestion; only blocking ones.
- Verification — the check you'll gate completion on.
- Prompt gaps — one line: what was thin in the ask.

Example shape:
```
Understanding: <one paragraph>
Assumptions: <interpretation chosen, flagged>
Context pulled: <file:line>
Questions: <at most 3>
Verification: <the gating check>
Prompt gaps: <what was thin>
```

Proceed only on `go` or after questions are answered.

## Large gear — spec
Interview to completion using the `grilling` primitive — one question at a
time, in decision-tree order, each carrying your recommended answer, facts
looked up rather than asked. Then write a self-contained SPEC.md
(files/interfaces, out-of-scope, end-to-end verification step). Suggest a fresh
session. Per user global rule, also render an HTML artifact to
~/.claude/artifacts/.

## Hand off
Intake produces understanding + a verification check; it does not implement.
When a design decision is still open, hand off to the brainstorming skill or
the writing-plans skill (or the built-in `Plan` agent); once there's a plan,
route to the implementer agent or superpowers:executing-plans to build.
Before any hand-off fans out to subagents, size it per the
`orchestrating-subagents` skill — scale count to
complexity, keep synthesis on the orchestrator, and brief each agent with
objective + tools + budget.
