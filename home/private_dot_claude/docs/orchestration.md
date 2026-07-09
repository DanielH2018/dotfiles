## Agents & parallelization

Conventions for spawning subagents (Agent tool) and orchestrating fan-out (Workflow tool).
Distilled from Anthropic's *Building Effective Agents* and the multi-agent research-system prompts.

**Orchestrator role.** Do the quick scoping, planning, and final synthesis yourself; delegate the
heavy reading/searching to subagents. Never delegate the synthesis or the final write-up — coordinate,
integrate, and write the answer yourself.

**Model tier.** Default the gather/read/search subagents to a cheaper tier (`model: 'sonnet'`) and keep
the top tier (Opus/Fable) for your own synthesis — bulk context-reading doesn't need the top model, and
delegating down conserves the All-Models quota. Bump a single subagent up only when its subtask genuinely
needs the stronger reasoning.

**How many subagents** — scale to complexity, don't reflex-fan-out:
- Simple / single-fact → 1 (always ≥1, so sourcing is delegated rather than skipped)
- Standard → 2–3 (default 3)
- Medium — distinct sub-topics or lenses → 3–5
- High — large gather across many segments → 5–10, hard cap 20

Prefer fewer capable agents over many narrow ones — more agents = more overhead. Add one only for
distinct value, and give each a non-overlapping scope.

**Ordering.** Deploy any blocking/prerequisite subagent first (others depend on its result), then fan
out the rest in parallel (batch the spawn calls in a single turn). Depth-first questions: sequence
agents to attack the same core from different angles. Breadth-first: one agent per sub-topic.

**Every subagent brief carries:** one core objective; background on how it fits the whole; which tools
to use (for internal questions, prefer internal MCP sources over the web); the expected output format;
and a budget — roughly <5 tool calls (simple) / 5 / ~10 (hard) / up to 15, hard stop ~20. If every
brief is followed, their union must fully answer the question.

**Verify, don't trust.** Integrating subagent/tool output, separate established fact from speculation,
prediction, or marketing spin; prefer original sources over aggregators; on conflicts favor recency +
consistency and flag the discrepancy rather than silently picking.

**Disagreement is signal.** When you fan out several reviewers or verifiers over the same artifact and
they *disagree*, don't average the verdicts or take a majority vote — the disagreement pinpoints the
exact spot nobody has actually pinned down. Resolve it by testing the contested claim against ground
truth (run the code, read the primary source, reproduce the case), then fold in only the settled
result. Treat a conflict as a prompt to gather one more piece of evidence, not to pick a side.

**Stop at diminishing returns.** Once the answer is good enough, stop spawning and write it — don't
chase marginal coverage.

**Tooling.** Deterministic multi-stage fan-out → Workflow tool (pipeline-by-default; scale width with
`budget`), which the user must opt into. One-off independent tasks → Agent tool, batched in a single
turn.
