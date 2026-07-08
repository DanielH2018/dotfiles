# Subagent evals

Regression tests for the custom Claude Code subagents. Each **case** feeds a fixed prompt to
one agent, grades the output with a deterministic assertion gate plus an LLM judge, and runs
the case `k` times to measure consistency.

Design spec: `docs/superpowers/specs/2026-07-08-subagent-evals-design.md`.
Plan: `docs/superpowers/plans/2026-07-08-subagent-evals.md`.

## Running

```bash
# from the repo root
node evals/run-evals.mjs                       # every case, using each case's own k
node evals/run-evals.mjs --smoke               # k=1 for every case (cheap iteration)
node evals/run-evals.mjs --agent planner       # only one agent's cases
node evals/run-evals.mjs --case migration-reviewer/001-drop-column-still-read
node evals/run-evals.mjs --k 3                 # override k for every case
node evals/run-evals.mjs --json report.json    # also write a machine-readable report
```

**`k` precedence:** `--smoke` (forces k=1) > `--k <n>` > the case's own `k` field.

Exit code is non-zero if any case is `FAIL` or `INCONCLUSIVE`, so this is CI-ready.

The deterministic library pieces have unit tests (no API calls):

```bash
node --test tests/evals-*.test.mjs
```

## How a run is graded

Per run, in order:

1. **Infra-health check** — a run is a valid sample only if the `claude` result has
   `is_error === false && subtype === "success"`. Anything else (API overload, budget hit,
   not-logged-in, timeout, unparseable judge output) is an **infra error**: it is excluded
   from the denominator, not counted as a pass or a fail. Timeouts and a bounded retry live
   here.
2. **Assertion gate** — `must_match` / `must_not_match` regexes (case-insensitive) against the
   agent's output. Failing the gate fails the run immediately, with no judge call spent.
3. **LLM judge** — only if the gate passes. A separate `claude -p` call (opus) scores the
   case `rubric` and returns `{pass, reason}`, its shape enforced with `--json-schema`.

A run **passes** iff it is infra-healthy AND the gate passes AND the judge returns `pass`.

## Consistency: `all` vs pass-rate

Let `n` = infra-healthy runs and `p̂` = passes / `n`. A case's `threshold` picks its bar:

- `"all"` — every healthy run must pass (the strict "pass^k" tripwire). Reserve this for
  cases whose rubric + assertions are effectively **deterministic**: an honest run should pass
  every time. (A ~90%-per-run agent clears an `"all"` bar at k=5 only ~59% of the time, so
  don't use `"all"` for cases with legitimate response variation.)
- `"rate>=X/Y"` — pass rate `p̂ ≥ X/Y`. The bar for cases with legitimate variation.

If too few healthy runs remain (`healthy < ceil(k/2)`), the case is **INCONCLUSIVE** — too much
infra noise to judge — and exits non-zero so it gets investigated rather than ignored.

## Invocation contract (why the flags are what they are)

Each agent is invoked as (verified against `claude` v2.1.204):

```
claude -p "<input>" --agents '{"<name>":{...,"model":"<m>"}}' --agent <name> \
  --output-format json --tools "" --max-budget-usd <cap> \
  --setting-sources project --strict-mcp-config
```

- **Model is pinned inside the `--agents` JSON**, never the top-level `--model` flag — that
  flag is unreliable in `-p` mode (lower-tier requests get silently upgraded).
- **`--tools ""` is the side-effect guard**, not `--permission-mode plan`. Plan mode injects
  plan-framing and a trailing "should I proceed?" question that corrupts behavioral grading
  (especially the "don't over-ask" cases). Empty tools removes all tools without that
  distortion.
- The judge pins **opus the same way** — inside its own `--agents` entry.

## Isolation & auth

- `--bare` (skips CLAUDE.md discovery, hooks, plugins) is added **only when
  `ANTHROPIC_API_KEY` is set** — it also skips keychain reads, so under interactive OAuth it
  produces "Not logged in". Set `ANTHROPIC_API_KEY` (typical in CI) for the fully-hermetic
  path; otherwise the fallback (`--setting-sources project --strict-mcp-config`, no `--bare`)
  minimizes but does not eliminate ambient global-CLAUDE.md context. Results are most
  reproducible on the `--bare` + API-key path.

## Fidelity boundary

`--agent <name>` in `-p` mode runs the **main loop as that agent** (single turn) — it applies
the agent's system prompt but does **not** exercise nested `Task`-dispatch subagent semantics
or the agent's own `tools:` allow-list (which `--tools ""` overrides). This harness grades the
agent's **prompt/behavior**, not subagent-dispatch plumbing or tool-scoping.

`lucid-diagrammer`'s Lucid MCP tools are removed by `--tools ""`, so its cases explicitly ask
for the diagram **specification as text** and grade that against the style rules — not a live
diagram.

## Cost

Measured in-sandbox: a small agent call with `--tools ""` (no plan mode) cost **~$0.004**; the
judge runs on opus (pricier, plus a small auxiliary haiku call). A full `k=5` run over all
cases is realistically single-digit-to-low-tens of dollars. Every `claude` call is capped with
`--max-budget-usd`; use `--smoke` and `--agent`/`--case` filters while iterating. Re-measure and
update this note if models or case sizes change.

## The agents

Cases exist for the four agents whose definitions live in this repo
(`home/private_dot_claude/agents/`): `implementer`, `planner`, `lucid-diagrammer`,
`migration-reviewer`.

The four work-overlay agents (`security-reviewer`, `ops-investigator`, `processing-engineer`,
`network-navigator`) live in `work-laptop-config` and have **stub directories** here — author
their cases on the host where their definitions are available, using `evals/_case.template.json`.
