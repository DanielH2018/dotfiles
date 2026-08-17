# Drive an iterative review-fix loop via Ralph Loop

Shared mechanics for the `/review-loop` and `/review-setup-loop` commands. Both wrap the
same three steps around a different per-iteration command, so the steps live here and each
command supplies only its own parameters.

## When to use

Read this when running `/review-loop` or `/review-setup-loop`, or when adding a third loop
command. Do not invoke this reference directly — it has no arguments of its own and drives
nothing on its own.

## Parameters the calling command supplies

| Parameter | Meaning |
|---|---|
| `ITERATION_COMMAND` | The slash command run once per iteration |
| `DEFAULT_MAX` | Max iterations when `$ARGUMENTS` names no number |
| `TRIAGE_FILE` | Per-loop triage ledger, cleared at the start of every run |

## Steps

1. **Parse `$ARGUMENTS`.** The first bare number is max iterations; use `DEFAULT_MAX` when
   there is none. `--auto` and `--confirm` set the autonomy mode, which defaults to
   `default`. Never infer the mode from anything other than these two flags.

2. **Clear the triage ledger.** Delete `TRIAGE_FILE` if it exists, so each run starts on a
   clean slate. A stale ledger makes the first iteration re-apply decisions from an earlier
   run against a diff that has since changed. If the file does not exist, continue — its
   absence is the normal case on a first run, not an error.

3. **Construct the Ralph Loop prompt** in this exact shape, then invoke the
   `ralph-loop:ralph-loop` skill with it:

   ```
   "ITERATION_COMMAND [MODE]" --max-iterations [N] --completion-promise "NO FIXES NEEDED"
   ```

   `[MODE]` is the autonomy mode and `[N]` is the max iterations. The mode must be passed
   through to `ITERATION_COMMAND` — an iteration that cannot see the mode falls back to
   `default` and will stop to confirm fixes the caller already approved.

## Edges

- The completion promise is the literal string `NO FIXES NEEDED`. Never reword it: the loop
  terminates by matching it, so a paraphrase runs the loop to its iteration cap instead.
- These commands set `disable-model-invocation: true`. They are typed by the user; do not
  invoke either one on your own initiative.
