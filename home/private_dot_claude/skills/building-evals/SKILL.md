---
name: building-evals
description: Use when you want to measure or regression-test a skill, prompt, agent brief, or any non-deterministic instruction — not code. Turns "does this prompt work?" into a repeatable, cheaply-graded score. Invoked as /building-evals or when iterating on a prompt/skill.
---

# Building evals — score prompts and skills, not just code

Your project rule already covers tests for *code*. This covers the other half:
skills, prompts, agent briefs, and orchestration instructions, where output is
non-deterministic and "did my edit help or hurt?" has no compiler to answer it.
An eval is the regression test for a prompt.

Reach for this when: you're editing a skill/prompt and want to know the change
is an improvement not a vibe; a prompt fails intermittently and you want to pin
the rate; or you're choosing between two phrasings and need a number.

## The unit

Every eval case is four things:

```
{ input: "<the prompt/task fed to the thing under test>",
  golden: "<expected output, OR a rubric describing what correct looks like>",
  score: <filled in by grading> }
```

An eval set is a list of these plus a grader. The whole set lives in one file
(JSON or markdown table) next to whatever it tests.

## The iron rule: cheapest reliable grader wins

Grading is the recurring cost — you re-run it on every iteration — so pick the
cheapest grader that's still trustworthy. In order of preference:

1. **Code grading** — exact match, regex, set membership, a numeric threshold.
   Free and deterministic. *Prefer this even if it costs design effort:* often
   all that stands between you and a code-gradable eval is reformatting the task
   (e.g. rewrite a free-form question as multiple-choice, or require the answer
   to end with `ANSWER: X`). Do that reformatting.
2. **Model grading** — an LLM judges output against a rubric. Use only when
   correctness genuinely can't be pattern-matched (tone, faithfulness,
   "did it follow the skill's structure"). Costs a call per case.
3. **Human grading** — you read every output. The bottleneck. Reserve for the
   handful of cases model grading can't be trusted on, and use those to
   *calibrate* the model grader.

## Model-grader prompt (copy verbatim)

When you must use a model grader, this is the template. Keep the grader
critiquing against a rubric, force reasoning before the verdict, and extract a
single machine-readable tag:

```
You will be provided an answer that an assistant gave to a question, and a
rubric that instructs you on what makes the answer correct or incorrect.

Here is the answer that the assistant gave to the question.
<answer>{answer}</answer>

Here is the rubric on what makes the answer correct or incorrect.
<rubric>{rubric}</rubric>

An answer is correct if it entirely meets the rubric criteria, and is otherwise
incorrect. First, think through whether the answer is correct or incorrect based
on the rubric inside <thinking></thinking> tags. Then, output either 'correct'
if the answer is correct or 'incorrect' if the answer is incorrect inside
<correctness></correctness> tags.
```

Score = `count('correct') / total * 100`. Report the number and the failing cases.

## Running a set

- **Small set (< ~10 cases), code-graded** — just run inline: feed each input,
  apply the grader, tally.
- **Larger set, or model-graded** — fan out with the Workflow tool (opt-in):
  `pipeline(cases, run, grade)` — each case runs through the thing-under-test
  then its grader, no barrier. Return the scored list; you synthesize the
  summary (pass rate + every failure with its input). This composes with the
  evaluator-optimizer loop in [orchestration.md](~/.claude/docs/orchestration.md):
  the model grader here *is* that loop's evaluator.

## Discipline

- Write the eval set **before** you tune the prompt — otherwise you tune to
  memory, not to a fixed target.
- A case is only worth keeping if it can fail. Cases the thing always passes
  measure nothing; cases it always fails are either bugs to fix or bad cases.
- Log what you didn't test. A pass rate over 8 cherry-picked cases is not
  "it works" — say the set is 8 cases and what's uncovered.
- Keep the golden answers honest per the source-quality rules: a rubric that
  encodes your assumption rather than the actual requirement grades nothing.
