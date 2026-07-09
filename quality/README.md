# Instruction-file quality scorer

`instruction_quality.py` — a deterministic, zero-dependency quality scorer for agent
instruction files (`CLAUDE.md`, `SKILL.md`, `AGENTS.md`). It reproduces the scoring
**rubric** published by [Schliff](https://github.com/Zandereins/schliff) (MIT) as an
**owned reimplementation** — we intentionally do *not* vendor upstream Schliff, which is a
multi-module tool with cross-session state (`episodic_store`) and a network badge feature.
This single file is the whole thing: stdlib-only, Python ≥ 3.10, no network, no subprocess,
no writes. Read it in one sitting; that's the point.

It complements the two backlog tools (`Claude_Code_Setup` → open backlog): **agnix**
answers "is this file *valid*", **SkillSpector** answers "is it *safe/malicious*", and this
answers "is it *good*" (structured, triggered, actionable, edge-aware, concise).

## Usage

```bash
python3 quality/instruction_quality.py score  <file>...            # per-dimension report
python3 quality/instruction_quality.py verify <file>... [--min-score 75]   # CI gate, exits 0/1
python3 quality/instruction_quality.py selftest                    # no-API sanity check
```

`--format {auto,skill,claude,agents}` overrides format detection (default `auto`).

## Scoring

Weighted composite (0–100) over Schliff's headline dimensions, plus a **security gate**:

| Dimension | Weight | Checks (heuristic) |
|-----------|:-----:|--------|
| structure | 0.15 | headings, lists, SKILL.md frontmatter (`name`/`description`) |
| triggers | 0.20 | "use when" / "when to use" language; SKILL.md description quality |
| quality | 0.20 | concrete directives (must/should/never), code examples; penalizes vague filler |
| edges | 0.15 | limitations, "don't/never/avoid", failure handling |
| efficiency | 0.10 | length budget (peaks ≤200 lines; penalizes bloat and thinness) |
| composability | 0.10 | cross-refs: links, `[[wikilinks]]`, "the X skill/agent" |
| clarity | 0.05 | line length, long-paragraph penalty |
| security | 0.05 | **gate**: hardcoded secrets, pipe-to-shell, disable-safety, injection phrasing |

Grades: **S** ≥90 · **A** ≥80 · **B** ≥70 · **C** ≥60 · **D** ≥50 · **F** <50.
`verify` fails if composite `< --min-score` **or** security `< 70` (the elevated gate).

## Baselines (measured 2026-07-09)

| File | Composite | Grade | Notable |
|------|:--:|:--:|--------|
| `skills/gh-stack/SKILL.md` | 90 | S | efficiency 43 — 617 lines, long |
| `skills/deep-understanding/SKILL.md` | 68 | C | triggers 35 — no explicit "use when" |
| `agents/migration-reviewer.md` | 68 | C | no cross-refs; thin edge coverage |
| `agents/planner.md` | 52 | D | terse agent prompt (see caveat) |

## Caveats / tuning

- **Agent definitions read as "skills."** A terse agent system prompt (`planner.md`) is
  *intentionally* short and headingless, but detection sees its `name`/`description`
  frontmatter and scores it as a SKILL.md — so it's dinged on structure/efficiency. Treat
  agent-def scores as advisory, or pass `--format claude`, or exclude them from the gate.
- The heuristics are transparent and **tunable** — adjust `WEIGHTS`, the cue regexes, or the
  length budget in the source. It's a signal, not an oracle.

## Wiring the gate (not auto-installed — opt in on host)

Start the bar where current files clear it so it catches **regressions + security** now, then
ratchet up. Given the baselines, `--min-score 50` fails nothing today; raise over time.

**pre-commit** (`.pre-commit-config.yaml`):
```yaml
- repo: local
  hooks:
    - id: instruction-quality
      name: instruction-quality
      entry: python3 quality/instruction_quality.py verify --min-score 50
      language: system
      files: '(CLAUDE\.md|SKILL\.md|AGENTS\.md)$'
```

**CI** (GitHub Action step):
```yaml
- run: |
    python3 quality/instruction_quality.py verify --min-score 50 \
      home/private_dot_claude/skills/*/SKILL.md \
      $(git ls-files '*CLAUDE.md*')
```

Run `python3 quality/instruction_quality.py selftest` in CI too — it's the tool's own test.
