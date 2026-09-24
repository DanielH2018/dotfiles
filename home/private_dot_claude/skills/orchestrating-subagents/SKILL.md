---
name: orchestrating-subagents
description: Use when about to spawn subagents or fan out parallel work — how many agents to spawn, what every brief must carry, which cost lever to pull, and when multi-agent vetting is worth it. Load before the first Agent or Workflow call, not after.
---

# Orchestrating subagents

Conventions for spawning subagents (Agent tool) and orchestrating fan-out (Workflow tool).
Distilled from Anthropic's *Building Effective Agents* and the multi-agent research-system prompts.

**Orchestrator role.** Do the quick scoping, planning, and final synthesis yourself; delegate the
heavy reading/searching to subagents. Never delegate the synthesis or the final write-up — coordinate,
integrate, and write the answer yourself.

**When to delegate at all.** The trigger is countable, because the judgment-call version of this rule
measurably did not fire — across five real sessions it ran 710 inline Bash calls to 19 delegations.
**If answering a question would take 3+ exploratory calls — searching for something whose location you
don't already know — dispatch a subagent and keep only its findings.** Exploratory search is precisely
the work whose tool output *and* reasoning should never have entered the main context; a subagent pays
both costs in its own window and returns a conclusion. The exception is the targeted read: when you
already know the file and the symbol, just read it, however many calls that takes.

Beyond that trigger, delegate work that is genuinely independent and sizeable — a wide multi-file
investigation, a broad gather across distinct sub-topics. Don't spawn a subagent to verify or
double-check your own work. If one subagent can do the job, use one rather than several, and keep
spawn counts low.

**Cost lever.** Inside a Workflow, reach for `effort` before dropping model tier: `low` and `medium` hold
quality at a fraction of the tokens, so a cheap gather stage is usually `effort: 'low'` on the inherited
model rather than a downgrade — keep `xhigh` for coding and for the hardest judge stages. The Agent tool
has no effort knob, so there tier is the only lever: `model: 'sonnet'` for bulk context-reading with no
judgment in it, top tier (Opus/Fable) reserved for your own synthesis. Bump a single subagent up only when
its subtask genuinely needs the stronger reasoning.

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

**Name the stop conditions, or the agent improvises past a wrong premise.** A brief that says
what to do but never what makes the work impossible gets a confident report built on an
assumption that stopped holding. Four conditions, stated in the brief, that mean stop and
report rather than continue:

- The live code does not match the assumption the brief is built on.
- A verification command fails twice after a reasonable fix or retry.
- The work turns out to need files outside the assigned scope.
- The agent cannot produce concrete evidence for the claim it is about to make.

Corollary for the dispatcher: **don't delegate the immediate blocker** if your own next step
depends on its answer. You will wait on it either way, and you lose the ability to react to
what it finds partway through. (Adapted from `efficient-frontier` on noriskillsets.dev.)

**Give the brief a time budget, not just a tool-call budget.** Opus 5.5 pays close attention to
elapsed time and paces its work against a stated budget. In Anthropic's evaluations of small
agent teams on research tasks, a budget made the team finish considerably sooner than a single
agent while keeping answer quality comparable. A budget is not the same lever as lower effort:
lowering effort reduces the work itself, where a budget mostly keeps more agents running in
parallel. So it stacks with the cost lever above rather than replacing it.

The measured mechanism is a harness appending `elapsed 340s / 1200s` to every message it returns
to the model, and the Agent tool has no per-message injection point for a running subagent. Use
the guide's own fallback instead — one sentence in the brief: *Time matters here: do not spend
time that can be avoided, and the earlier a correct result is obtained, the better.* Set a named
budget when you can estimate one, somewhat above the time you actually want spent, because the
model usually finishes well before it. Two caveats the guide states: the budget is advisory and
nothing stops the model at the limit, and under time pressure the model may search and verify a
little less — so leave it out of a brief whose whole job is verification.

**Bound the return, not just the work.** Everything a subagent returns lands in your own
context, and every later turn of your session carries it. So name the shape in the brief: a
table with stated columns, a list of `file:line` findings, a JSON object with fixed keys. A
brief ending "report what you find" buys a narrative you then carry for the rest of the
session; one ending "return a table with columns X, Y, Z" does not.

**Subagents carry a second cost line, `agent_summary`.** Measured 2026-09-23 over 7 days
(`otelq savings subagents` reports the rows, and `tests/fixtures/subagent-cost.json` holds
this snapshot of them): subagents cost $688 of list-price tokens and `agent_summary`
requests cost a further $136. That is $0.92 per
`subagent_completed` event across 149 of them, and 17% of the all-in cost of delegating. Every
one of those events came from a background subagent. The line is not one pass over the
returned report. There were 12.9 `agent_summary` requests per completed subagent, and each
request re-read a mean of 164k cached tokens to write 44. So the cost follows how long a
background subagent runs and how large its context gets.

**Don't pay for the same document N times.** Subagents share no context, so a large file named in
several briefs is re-read in full by each one. Measured 2026-07-25: the Claude Code docs bundle was
read whole by seven separate agents (61–87 KB each, ~485 KB / ~230k tokens for one document), and a
53 KB plan four times. Every one of the fifteen largest tool results in the corpus was a whole-file
`Read`. Either read it once yourself and pass the extracted finding, or give each brief the specific
question plus a grep/offset to reach for — never the bare path and a hope they'll bound it.

**Verify, don't trust.** When integrating subagent/tool output, apply the **Source quality & epistemic
honesty** rules from CLAUDE.md (fact vs. speculation; prefer primary sources; on conflicts favor
recency + consistency and flag it).

**Multi-agent vetting is opt-in, not the default finish.** The judge-panel and adversarial-verify patterns
below earn their cost on high-stakes artifacts — a security sweep, a migration, a spec I'm about to build
from, or anything I've explicitly asked you to audit or be thorough about. They are not how ordinary work
ends. On a routine change you catch your own mistakes already, and a verification fan-out just multiplies
spend for the same answer. Reach for them when I ask, or when being wrong is expensive.

**Disagreement is signal.** When you fan out several reviewers or verifiers over the same artifact and
they *disagree*, don't average the verdicts or take a majority vote — the disagreement pinpoints the
exact spot nobody has actually pinned down. Resolve it by testing the contested claim against ground
truth (run the code, read the primary source, reproduce the case), then fold in only the settled
result. Treat a conflict as a prompt to gather one more piece of evidence, not to pick a side.

**Depth vs. breadth — pick the right loop.** Fanning out N judges over one artifact is a *breadth*
move: it surveys many failure modes at once, best for *vetting* something you won't change. To *improve*
a single artifact, use the *depth* move instead — an evaluator-optimizer loop: one agent generates, a
second evaluates against explicit criteria and returns PASS / NEEDS_IMPROVEMENT / FAIL plus concrete
feedback, and the generator regenerates with the full history of prior attempts + the latest critique
appended, until PASS or a hard iteration cap. Keep the evaluator strictly critiquing, never solving, and
give it a rubric — a vague evaluator loops forever. Reach for this when the criteria are objective and
the first pass is fixable (code correctness/style, a spec's completeness); skip it when "good" is
subjective or the output is already good enough.

**Stop at diminishing returns.** Once the answer is good enough, stop spawning and write it — don't
chase marginal coverage.

**Tooling.** Deterministic multi-stage fan-out → Workflow tool (pipeline-by-default; scale width with
`budget`), which the user must opt into. One-off independent tasks → Agent tool, batched in a single
turn.

**Worktree isolation needs a git repo.** `isolation: "worktree"` (Agent tool) and `opts.isolation`
(Workflow) fail instantly with `WorktreeIsolationError` when the session's cwd is not a git repository
and no `WorktreeCreate`/`WorktreeRemove` hooks are configured. The primary working directory
`~/dev` is *not* a repo — it's a parent holding many repos — so isolation requested from there always
fails. Check `git rev-parse --is-inside-work-tree` before asking for it, or spawn the agent with its
cwd inside the specific repo. Only reach for isolation when agents actually mutate files in parallel
and would otherwise conflict; it costs ~200-500ms plus disk per agent.
