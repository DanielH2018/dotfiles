---
name: prep
description: Use before starting non-trivial work — understand, enrich context, clarify, and confirm before executing. Invoked as /prep or self-triggered on non-trivial prompts.
---

# Prep — intake before execution

Don't dive in. First understand the ask, pull the context yourself, surface
assumptions and gaps, confirm — then hand off to execution.

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

## Medium gear — the intake block (then stop and wait)
- Understanding — one paragraph restating the task.
- Assumptions — the interpretation chosen where the ask was ambiguous; flag each.
- Context pulled — what enrich found, with file:line.
- Questions — at most 3, batched via AskUserQuestion; only blocking ones.
- Verification — the check you'll gate completion on.
- Prompt gaps — one line: what was thin in the ask.
Proceed only on `go` or after questions are answered.

## Large gear — spec
Interview to completion, then write a self-contained SPEC.md (files/interfaces,
out-of-scope, end-to-end verification step). Suggest a fresh session. Per user
global rule, also render an HTML artifact to ~/.claude/artifacts/.

## Hand off
Intake produces understanding + a verification check; it does not implement.
Route to the normal flow: superpowers brainstorming/writing-plans (or the built-in `Plan` agent) for design, then `implementer`/superpowers:executing-plans to build.
When the hand-off fans out to subagents, size it per `~/.claude/docs/orchestration.md` — scale count to
complexity, keep synthesis on the orchestrator, and brief each agent with objective + tools + budget.
