# Subagent Evals — Design Spec

**Date:** 2026-07-08
**Status:** Approved design, pre-implementation
**Repo:** `dotfiles` / chezmoi (`~/.local/share/chezmoi`)
**Backlog item:** Claude_Code_Setup "Open backlog" #1 — subagent evals (biggest untapped reliability lever)

## Problem

The custom Claude Code subagents have no regression tests. A one-line edit to an agent
definition can silently degrade its behavior, and there is no signal until it misfires on
real work. The Claude_Code_Setup review called this out and prescribed `pass^k` (consistency)
grading for prod-facing agents.

This spec designs a **subagent eval harness**: a way to invoke each agent under test with
fixed inputs, grade its output, and measure consistency across repeated runs — runnable
locally now and CI-ready later.

## Scope

### In scope (this deliverable)
- The eval harness (runner, invocation, grading, reporting) built in the chezmoi repo.
- Authored, grounded eval cases for the **4 agents readable in this environment**:
  `implementer`, `planner`, `lucid-diagrammer`, `migration-reviewer` (all in
  `home/private_dot_claude/agents/`).
- Stub case directories + a case template for the **4 work-overlay agents**
  (`security-reviewer`, `ops-investigator`, `processing-engineer`, `network-navigator`),
  which live in `work-laptop-config` and are **not reachable** from the current sandbox.

### Out of scope
- Authoring cases for the 4 work-overlay agents (done on the host where their
  definitions live).
- Wiring CI. No CI exists in this repo today (no `package.json`, no `.github/workflows`),
  and it cannot be exercised from the sandbox. The harness is *built* CI-ready (exit codes,
  JSON report) but CI wiring is a separate follow-up.
- Committing/pushing from the sandbox — git signing (1Password agent) is unavailable
  in-container; commits happen on the host.

## Environment constraints (why the design is shaped this way)

- **Only 4 of 8 agents are readable here.** The work-overlay agents are dangling symlinks
  into an unmounted repo. Cases for them are stubbed, not authored.
- **`lucid-diagrammer` uses Lucid MCP write tools, which are denied.** It cannot create a
  real diagram in eval. We grade the **specification / plan text** it produces against its
  style rules, with MCP tools disabled. This is a deliberate fidelity compromise, documented
  in the eval README.
- **The CLI is present** (`claude` v2.1.204) and supports the flags the harness actually uses:
  `-p` headless, `--agents <json>` + `--agent <name>`, `--output-format json`, `--tools`,
  `--max-budget-usd`, `--json-schema`, `--setting-sources`, `--strict-mcp-config`, `--bare`.
  Note the design deliberately avoids `--model` and `--permission-mode plan` (see Empirical
  findings for why).

## Architecture

### Directory layout

A new top-level `evals/` directory, sibling of `tests/`, at repo root — **not** under
`home/`, so chezmoi never deploys it (same treatment as `tests/`, which the README notes is
"not deployed").

```
evals/
  run-evals.mjs            # entry point / CLI
  lib/
    load-agent.mjs         # parse home/private_dot_claude/agents/<name>.md → {name,model,tools,systemPrompt}
    invoke-agent.mjs       # build --agents JSON, run `claude -p`, return transcript
    assertions.mjs         # deterministic must_match / must_not_match gate
    judge.mjs              # LLM-judge: claude -p with rubric → {pass, reason}
    report.mjs             # pass^k aggregation, human + JSON output, exit code
  cases/
    migration-reviewer/*.json
    lucid-diagrammer/*.json
    planner/*.json
    implementer/*.json
    security-reviewer/.gitkeep       # stub (authored on host)
    ops-investigator/.gitkeep        # stub
    processing-engineer/.gitkeep     # stub
    network-navigator/.gitkeep       # stub
  _case.template.json      # copy-to-author template
  README.md                # philosophy, how to run, how to add a case, cost + fidelity notes
```

### Runner CLI

```
node evals/run-evals.mjs [options]
  --agent <name>     run only cases for one agent
  --case <id>        run a single case by id
  --k <n>            override runs per case (else each case's own `k` field is used)
  --smoke            force k=1 for every case (opt-in; NOT the default)
  --json <path>      also write the machine-readable report to <path>
```

Invoked with bare `node` to match the repo's `node --test` convention (no `package.json`
today). `--smoke` forces a cheap `k=1` pass while iterating; a bare run uses each case's own
`k` field (precedence detailed in the case schema). Exit code is non-zero if any case misses
its threshold or is INCONCLUSIVE, so the harness is CI-ready.

### Invocation (source-of-truth, side-effect-free)

`load-agent.mjs` reads the agent `.md` **from the repo** (`home/private_dot_claude/agents/`),
splits YAML frontmatter from body, and yields `{name, model, tools, systemPrompt}`.

`invoke-agent.mjs` builds a `--agents '{"<name>": {...}}'` payload from that parsed
definition — **including the agent's `model` inside the JSON** — and runs:

```
claude -p "<case input>" \
  --agents '{"<name>":{"description":"...","prompt":"<body>","model":"<agent model>"}}' \
  --agent <name> \
  --output-format json \
  --tools "" \
  --max-budget-usd <cap> \
  --setting-sources project --strict-mcp-config
```

Every element here was verified empirically against `claude` v2.1.204 in the sandbox
(see "Empirical findings" below). Rationale:

- **`model` goes *inside* the `--agents` JSON, not the top-level `--model` flag.** The
  top-level `--model` is **ignored** in `-p` mode in this environment — every run fell back
  to `sonnet-5` regardless. Only `model` inside the agent JSON actually took effect (confirmed
  running on `claude-haiku-4-5`). Since the four agents span opus/opus/sonnet/haiku, using the
  flag would silently grade every agent on the wrong model. `load-agent.mjs` already parses
  `model`; the harness injects it into the JSON. (A top-level override knob is *not* offered
  because the flag doesn't work here.)
- **`--tools ""` (empty tool list) — NOT `--permission-mode plan` — is the side-effect guard.**
  Plan mode injects plan-framing boilerplate ("I'm in plan mode, so let me outline my
  approach…") and a mandatory trailing "Should I proceed?" question into *every* agent's
  output. That directly corrupts the cases that measure asking behavior (lucid "don't
  over-ask", planner "surfaces assumptions") — plan mode makes every agent ask to proceed, so
  a don't-over-ask assertion could never be measured honestly. `--tools ""` removes all tools
  (so no MCP write, no filesystem mutation, no Skill invocation) **without** distorting the
  agent's natural prose. This is the single side-effect mechanism (no redundant
  `--disallowedTools`).
- **`--agents` from the parsed file** → the eval grades the source-of-truth definition in the
  repo, not whatever is deployed. Editing the agent `.md` and re-running is the regression
  signal.
- **`--output-format json`** → the final agent text is in `.result` (confirmed); the run's
  health is in `.is_error` / `.subtype` (see error handling).

### Isolation & auth

The harness must be as reproducible as possible, but full isolation and this sandbox's auth
are in tension:

- **`--bare` is the ideal isolation flag** (skips CLAUDE.md auto-discovery, hooks, plugins,
  auto-memory, prefetches) — but it **also skips keychain reads**, which breaks this sandbox's
  OAuth login (`claude -p --bare …` → *"Not logged in · Please run /login"*, verified). So
  `--bare` is only usable where auth comes from `ANTHROPIC_API_KEY` in the environment
  (typical for CI), not from the interactive keychain/OAuth session.
- **Runner policy:** use `--bare` **iff** `ANTHROPIC_API_KEY` is set (hermetic path, preferred
  for CI); otherwise fall back to non-`--bare` with `--tools ""`, `--setting-sources project`,
  and `--strict-mcp-config` to minimize (not eliminate) ambient leakage. `--tools ""` already
  prevents hook/skill *execution*; the residual under the fallback path is passive global
  `CLAUDE.md` text loaded into context. This is a **documented fidelity caveat**: results are
  most reproducible on the `--bare` + API-key path, and the exact isolation flag set is
  re-validated with a live smoke run at implementation time.

### Fidelity boundary (document in README)

`--agent <name>` in `-p` mode runs the **main loop as that agent** (single turn, `num_turns:1`,
direct `.result`) — it applies the agent's system prompt, but it does **not** exercise real
nested `Task`-dispatch subagent semantics (a parent delegating, the agent's `tools` field
scoping a sub-context, nesting). For grading the agent's *prompt/behavior* this is actually
cleaner and more deterministic, but the harness does not certify subagent-dispatch plumbing.
State this boundary in the README so the eval's scope is honest. (Also: `--tools ""` means the
agent's own `tools:` allow-list is not what constrains it in-eval — the empty global list is —
so any case that depends on tool-scoping behavior is out of scope for this harness.)

### Grading pipeline (hybrid)

Per run, in order:
0. **Infra-health check first** (`invoke-agent.mjs`): before any grading, inspect the run's
   JSON. A run counts as a valid eval sample **only if** `is_error === false` and
   `subtype === "success"`. If the call errored (API overload, budget hit, not-logged-in,
   timeout), it is classified as an **infra error** — it does **not** count as a pass or a
   fail and is **excluded from the pass^k denominator** (see below). This prevents API noise
   from polluting the signal and stops an error string (e.g. `"Overloaded"`) from being fed
   to the judge. Timeouts and a bounded retry (default 2 retries on transient errors, with
   backoff) live here.
1. **Deterministic assertion gate** (`assertions.mjs`): `must_match` / `must_not_match`
   regex checks against the agent's final text (`.result`). Fail → run fails immediately,
   **no judge call spent**. Catches format regressions and forbidden content (e.g. lucid
   emitting `:5432`, migration-reviewer dropping its required output headers).
2. **LLM-judge** (`judge.mjs`): only if the gate passes. A separate `claude -p` call with a
   fixed judge system prompt that scores the case `rubric` against the agent's output. The
   judge uses **`--json-schema`** (structured-output validation, verified available) to
   enforce the shape `{pass: boolean, reason: string}` — **not** free-text JSON that
   `JSON.parse` might choke on. The judge runs on a strong model (opus) regardless of the
   agent's own model, and it pins that model the **same way the agent path does — `model`
   inside a `--agents` JSON entry for the judge**, not the top-level `--model` flag. (Do not
   rely on `--model opus`: while it happens to be honored today, the flag's behavior is
   inconsistent — see Empirical findings — so the judge uses the one mechanism proven robust.)
   If the judge call itself is an infra error or fails schema validation after retry, the run
   is classified as an **infra error** (not a silent pass).

A run **passes** iff it is infra-healthy **and** the assertion gate passes **and** the judge
returns `pass: true`.

### `pass^k`, consistency, and thresholds

Each case runs `k` times (concurrency-capped; the sandbox has 4 CPUs — default concurrency 3).
Let `n` = number of infra-healthy runs (`k` minus infra errors) and `p̂` = passes / `n`.
`report.mjs` reports two distinct, clearly-labeled statistics:

- **pass rate `p̂`** (`passes / n`) — the point estimate of the agent's per-run pass
  probability.
- **all-pass** — whether *all* `n` healthy runs passed. This is the strict consistency signal
  the backlog calls `pass^k`; note it is a single Bernoulli observation of `pᵏ`, **not** an
  estimate of `p` with a confidence interval. It is deliberately a *tripwire*, not a metric.

A case's `threshold` field selects its bar and is one of two explicitly-named kinds:
- `"all"` — every healthy run must pass (the strict tripwire). **Statistical caveat, stated
  plainly:** a genuinely-good but nondeterministic agent that passes ~90% per run clears an
  `"all"` bar at `k=5` only `0.9⁵ ≈ 59%` of the time — a ~41% spurious-fail rate per case.
  So `"all"` is reserved for cases whose rubric + assertions are effectively **deterministic**
  (format headers present, forbidden token absent, a binary must-be-flagged judgment). Its
  rubric must be written to make an honest run pass every time.
- `"rate>=X/Y"` — a **pass-rate threshold** (e.g. `"rate>=4/5"`): `p̂ ≥ X/Y`. This is the bar
  for cases with legitimate response variation. It is explicitly *not* labeled `pass^k` to
  avoid conflating the two statistics.

If `n` (healthy runs) falls below a floor (default: `< ceil(k/2)`), the case is reported as
**INCONCLUSIVE** (too much infra noise to judge), not as a pass or fail.

The report prints a per-case table (`p̂`, healthy `n`/`k`, all-pass?, threshold met?), and for
every failing run dumps the agent output + judge reason so failures are debuggable. Exit
non-zero if any case misses its threshold; INCONCLUSIVE cases exit non-zero too (they must be
investigated, not ignored).

## Case schema

One JSON file per case, under `evals/cases/<agent>/`:

```json
{
  "id": "migration-reviewer/003-drop-column-still-read",
  "agent": "migration-reviewer",
  "description": "Dropping a column another service still reads must be flagged CRITICAL",
  "input": "Review this migration:\n```sql\nALTER TABLE cards DROP COLUMN legacy_token;\n```\nNote: fraud-service still SELECTs legacy_token.",
  "assert": {
    "must_match": ["Risk Level", "Rollback Safe"],
    "must_not_match": []
  },
  "rubric": "PASS only if the review (1) flags that legacy_token is still read by fraud-service, (2) rates risk CRITICAL or HIGH, and (3) recommends an expand/contract or deploy-then-migrate split.",
  "k": 5,
  "threshold": "all"
}
```

Fields:
- `id`, `agent`, `description` — identity and human context.
- `input` — the exact prompt handed to the agent.
- `assert` — deterministic gate. `must_match` / `must_not_match` are arrays of regex strings
  (case-insensitive). Either may be empty/omitted.
- `rubric` — the pass criteria the judge scores. Written so PASS requires *all* listed
  conditions.
- `k` — runs for this case. **Precedence:** `--smoke` (forces `k=1`) overrides `--k <n>`
  (CLI), which overrides the case's `k` field, which is the default when neither flag is
  given. A bare `node evals/run-evals.mjs` therefore uses each case's own `k`. (The earlier
  "default is a 1-run smoke" is a *convenience via `--smoke`*, not the bare default — stated
  here to remove the ambiguity.)
- `threshold` — either `"all"` (strict all-pass tripwire; reserve for deterministic-enough
  cases) or `"rate>=X/Y"` (pass-rate bar for cases with legitimate variation). See the
  pass^k section for the distinction.

## The cases (grounded in the 4 readable agents)

Weighted toward the two format-strict agents. Every agent's set includes a
**false-positive / don't-over-flag** case — the failure mode evals most often miss.

### migration-reviewer (~8) — opus, strict output format
1. Drop a column still read by another service → **CRITICAL**.
2. Add `NOT NULL` column without a default → flag (existing rows fail).
3. Create index without `CONCURRENTLY` on a hot table → flag lock risk.
4. Large unbatched backfill in one transaction → flag.
5. Migration touching a PAN/cardholder-data table → PCI/compliance flag.
6. No down-migration on a reversible change → flag missing rollback.
7. **Safe additive migration (new nullable column, concurrent index)** → must **not**
   over-escalate; low risk.
8. Any migration → must always emit the required output headers (`Risk Level`,
   `Estimated Lock Duration`, `Rollback Safe`). (Enforced via `assert.must_match`.)

### lucid-diagrammer (~7) — haiku, tools disabled (grade spec text)
Because `--tools ""` removes the Lucid MCP tools the agent's prompt tells it to call, **every
lucid case `input` ends with an explicit instruction**: *"Produce the full diagram
specification as structured text — shapes, colors, connection labels, legend. Do not attempt
to call any tool."* Without this the agent might just announce intent and stop, producing
nothing gradeable. The planned smoke run validates that lucid emits gradeable spec text under
`--tools ""` (the reviewer observed it can, but only reliably when explicitly asked for text).
1. Input naming explicit ports (`:5432`, `:443`) → output must omit all port numbers.
2. CDE / shared / segmented system → must apply scope fill colors + include a legend.
3. Must use semantic connection labels ("publishes events"), not protocols/ports.
4. Ambiguous request → asks exactly one focused question before diagramming.
5. Must not place scope text labels ("CDE"/"Shared") inside/under shapes.
6. Sequence-diagram request → chooses the sequence-diagram flow.
7. **Well-specified request** → proceeds directly without asking a needless question
   (don't-over-ask).

### planner (~5) — opus, open-ended
1. Must produce multiple options **with explicit trade-offs**.
2. Must end with a concrete plan an implementer can execute.
3. Under-specified request → surfaces assumptions/questions rather than inventing scope.
4. Must not jump straight to code/implementation (stays at planning altitude).
5. **Simple well-scoped task** → plan is proportionate, not over-engineered.

### implementer (~4) — sonnet, open-ended
1. Given a plan → follows it without gold-plating.
2. Matches described existing style/conventions.
3. Does not invent scope beyond the plan.
4. **Genuinely ambiguous instruction** → flags the ambiguity instead of guessing silently.

**Total: ~24 authored cases** across 4 agents — within the backlog's "20–50" target. The 4
work-overlay agents get stub dirs + the shared template, authored on the host.

## Testing the harness itself

The harness has deterministic pieces that get their own unit tests in the existing `tests/`
suite (`node --test`), with **no API calls**:
- `load-agent.mjs`: parses frontmatter/body correctly; handles missing `tools`/`model`;
  emits `model` into the `--agents` payload.
- `assertions.mjs`: `must_match` / `must_not_match` regex logic, empty arrays, case-insensitivity.
- **infra-health classifier** (the pure function that maps a run's JSON → `pass` / `fail` /
  `infra-error`): fed fixture JSON objects (`is_error:false/subtype:success`, `is_error:true`,
  budget-hit, not-logged-in) — no `claude` call needed.
- `report.mjs`: both statistics and threshold math — `"all"` all-pass over healthy runs,
  `"rate>=X/Y"` pass-rate, infra-error exclusion from the denominator, INCONCLUSIVE when
  healthy `n` is below the floor, and exit-code selection (fail/inconclusive → non-zero).

`invoke-agent.mjs` and `judge.mjs` (which shell out to `claude`) are validated by a **1-case
live smoke run** in this session, not by unit tests, to prove the end-to-end path works —
including that the judge's `--json-schema` output parses and that lucid emits gradeable text
under `--tools ""`.

## Cost & fidelity notes (for the README)

- A full run is `k × cases × (1 agent call + up to 1 judge call)`. At `k=5` and ~24 cases
  that is up to ~240 model calls. **Measured** per-call cost in this sandbox (with `--tools ""`,
  no plan mode): a trivial haiku agent call was **~$0.004**; the earlier ~$0.16 figure was an
  artifact of plan-mode + CLAUDE.md overhead and does not apply to the corrected invocation.
  Real cases have larger inputs, and the **judge runs on opus** (materially pricier per call,
  plus a small auxiliary `haiku` call observed alongside each opus run),
  so a full `k=5` run is realistically **single-digit-to-low-tens of dollars**, not "near
  zero." Cost controls: `--smoke` and `--agent`/`--case` filters for iteration, and a
  **`--max-budget-usd` hard stop passed to every `claude` call** (verified flag) so a runaway
  run self-terminates. Re-measure per-model per-call cost during implementation and record it
  in the README.
- `lucid-diagrammer` is graded on spec text, not a live diagram (its MCP tools are removed by
  `--tools ""`); see the lucid case note about the explicit "produce text" instruction.
- The judge is itself an LLM and therefore noisy; rubrics are written to be binary and
  concrete to minimize judge variance, `--json-schema` enforces its output shape, and the
  all-pass tripwire is reserved for effectively-deterministic cases (see pass^k section) so
  judge noise does not masquerade as agent regression.

## Empirical findings (verified against `claude` v2.1.204 in-sandbox)

These were checked by running the CLI, not assumed. They are load-bearing for the design and
must be re-confirmed if the CLI version changes:

- `--output-format json` returns the agent's final text in `.result`; run health is in
  `.is_error`, `.subtype` (`"success"` on a clean run), and `.api_error_status`. `modelUsage`
  lists the model(s) actually used.
- **Top-level `--model` is unreliable** in `-p` mode here: lower-tier requests are silently
  upgraded/overridden (`--model haiku` → ran on `sonnet-5`), while `--model opus` *was*
  honored (`claude-opus-4-8`). Because the behavior is inconsistent by tier, the design does
  not use the flag; `model` **inside the `--agents` JSON** takes effect reliably for both the
  agent under test (confirmed `claude-haiku-4-5`) and the judge (opus).
- **`--permission-mode plan` injects plan-framing + a trailing "should I proceed?" question**
  into agent output — unusable for behavioral grading. `--tools ""` disables all tools without
  that distortion.
- **`--bare` skips keychain reads** → breaks OAuth login in this sandbox ("Not logged in");
  usable only with `ANTHROPIC_API_KEY` in env.
- `--agents` JSON genuinely applies the injected system prompt (an injected "reply KIWI"
  prompt produced `KIWI`).
- A clean corrected call (`--tools ""`, model-in-JSON, no plan mode) cost **~$0.004** and
  returned `is_error:false`, `subtype:"success"`.
- Flags confirmed present: `--bare`, `--setting-sources` (values: `user,project,local`),
  `--strict-mcp-config`, `--max-budget-usd`, `--json-schema`, `--tools`, `--agents`,
  `--agent`, `--output-format`.

## Follow-ups (not this deliverable)

- Author cases for the 4 work-overlay agents on the host.
- Wire CI (`node evals/run-evals.mjs` as a gated job) once a `package.json` / CI exists.
- Consider a nightly scheduled full `--k 5` run to track agent drift over time.
