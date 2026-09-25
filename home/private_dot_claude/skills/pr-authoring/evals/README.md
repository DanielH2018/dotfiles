# pr-authoring — trigger eval

Does the skill's `description` fire on the prompts it should, and stay quiet on the ones
it should not?

```sh
~/.claude/skills/pr-authoring/evals/run.sh              # all 8 cases, 3 runs each
~/.claude/skills/pr-authoring/evals/run.sh --runs 1     # a fast smoke pass
~/.claude/skills/pr-authoring/evals/run.sh --case commit-message
```

Exit 0 means every case passed; exit 1 prints the failures with their fire rates.

## Why this axis and not another

A model-invoked skill fails **silently**. The description either matches how the problem
gets phrased or it does not, and when it does not, nothing errors — the skill simply never
loads and the session proceeds without it. That failure is invisible from inside a session,
which is what makes it worth a standing measurement.

## How it grades

Code, not a model. Each run is `claude -p` with `--allowedTools "Skill"`, and the verdict
is whether the stream carried a `tool_use` naming `pr-authoring`. Binary, free, and it
observes the real selection mechanism rather than a proxy for it.

Restricting the tool list to `Skill` is deliberate: the run ends as soon as the skill fires,
so a case costs one decision rather than a full task.

## The isolation is the eval

Every run uses a throwaway `CLAUDE_CONFIG_DIR` holding only `pr-authoring` and the two
skills it must be told apart from — `gh-stack` and `receiving-code-review`.
No `CLAUDE.md`, no hooks, no plugins.

Without that, the numbers are worthless. The real config loads `superpowers:using-superpowers`,
which instructs: *"If you think there is even a 1% chance a skill might apply to what you are
doing, you ABSOLUTELY MUST invoke the skill."* Under that instruction every negative case
fires something, and the eval measures the harness instead of the description.

Verified on 2026-08-29: an isolated run reports a skill roster of exactly the four placed
skills plus built-ins.

The credential file does not follow `CLAUDE_CONFIG_DIR`, so the runner symlinks it in.
Without it every run returns `Not logged in` and silently scores as "did not fire" — which
looks like a passing negative arm and a failing positive one.

## The cases

Four expect `fires`, four expect `silent`. Two carry most of the weight:

- **`commit-message`** is the discriminating negative. The skill states that a squash merge
  makes the PR title the commit subject, so it has every reason to over-fire on a
  commit-message request. Nothing is being opened, so it should stay quiet.
- **`empty-body`** is phrased as the symptom rather than the action. Anyone who can think
  "I should load the PR skill" never needed it; the real moment is noticing the body is blank.

A case earns its place only if it can fail. `split-branch` and `rebase-howto` exist because
the description mentions branches and `gh pr create`, and firing on that vocabulary alone
would be the failure.

## Pass rule

A `fires` case must fire on **every** run; a `silent` case must stay quiet on every run. An
intermittent trigger counts as a failure and the printed rate says how bad — that is the
point of running each case three times rather than once.

## What this does not test

Stated plainly, because a pass rate over 8 cases is not "the skill works":

- **Compliance.** Whether text produced *with* the skill loaded actually follows it —
  headings as reviewer questions, a rejected-alternatives section, verification quoting
  literal output. That needs a second eval with an ablation arm (the same inputs, skill
  absent), keeping only the assertions that flip between arms. Most obvious checks — no
  `feat:` prefix, no "This PR" opening — a competent model passes unaided and so measure
  nothing.
- **The Precedence section**, including whether a repo's own `pull_request_template.md`
  actually wins.
- **The template-checkbox rule** and the phase-marker qualification.
- **Any model but the one recorded in `cases.json`.** Trigger behaviour is model-dependent,
  so a result is only valid for the model that produced it.

## Results

`results.md` holds the last recorded run: date, model, per-case rates. Re-record it after
any edit to the skill's `description`, which is the only field this eval measures.

**That is enforced, not remembered.** `bin/check-eval-freshness` runs in the pre-push gate
and rejects a push whose diff changes a `description:` line without touching that skill's
`results.md`. It does not run the eval — ~24 model calls, minutes, and network have no place
in a gate whose contract is deterministic, free and offline — it checks that the recording
happened and names the command. `EVAL_FRESHNESS_OFF=1` bypasses it.

The gate is opt-in per skill: having an `evals/cases.json` is what gates you, so a second
skill's eval needs no edit to the gate.
