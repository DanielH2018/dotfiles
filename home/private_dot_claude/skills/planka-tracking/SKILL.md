---
name: planka-tracking
description: Use when a session is editing code in a repo tracked on the Planka board — what to call the card, what the session-log comment should say, and when a checklist item deserves its own card. Hooks keep the card's list and fields current on their own; this covers the parts that need judgement.
---

# planka-tracking

Hooks already do the mechanical half: the first edit claims the card and moves it to In
Progress, TodoWrite mirrors into the Plan task list, Stop comments, and `bin/land` moves
the card to Done. Nothing below is needed to make that work — this is only the half that
needs a judgement call.

## Never write customer data

No PANs, no transaction detail, no account or card identifiers in a card title, comment,
task, or custom field. The PAN-redaction hook redacts *command output*; it never sees
what `planka` posts, so this rule is the only control on this path.

## If a card for this work already exists, adopt it

The hooks find a card by its `branch` custom field, which only a card they created
carries. A card written by hand is invisible to them, so the claim hook makes a second
one beside it — which is what happened the first time these hooks ran, on a board that
already had a card for the work.

When you know the work already has a card, adopt it before or after the first edit:

```bash
planka card adopt <card-id>
```

That stamps the branch onto the existing card and points the sidecar at it. Everything
else then treats it as this branch's card. The id is in the card's URL.

Adopt also works on `main` and `master`, which the hooks refuse to create cards for —
the guard is against accidents, not against you naming the card yourself.

## Retitle the card once the work has a shape

A card created by the claim hook is named after the branch. As soon as you know what the
work actually is, give it the name a person would write:

```bash
planka card field --set title="Stop the settlement retry from double-posting"
```

Name the outcome, not the files touched. The same sentence should serve as the PR title.

## Write the session-log comment before you stop

The Stop hook posts `~/.claude/planka/summary/$CLAUDE_SESSION_ID` when it exists, and a
bare "paused at `<sha>`" when it does not. Write the file whenever the session did
something worth reading later:

```bash
mkdir -p ~/.claude/planka/summary
```

Then write that file with three things, in this order: what changed, what was verified
and with which command, what is next. Quote an error string rather than paraphrasing it.

## Promote a task when it has become its own unit of work

A Plan task that deserves its own PR should become a card. It stays in the parent's
checklist and gains a link to the new one:

```bash
planka task promote <task-id> --task-list <task-list-id>
```

Both ids come from the card. Promote when a task has grown a test plan of its own, not
merely because it is large.

## Reverse states

Every state has a way back. Use these rather than clicking in the UI mid-session, so the
sidecar and the board stay in step.

| Situation | Command |
|---|---|
| Blocked on someone else | `planka card move --list blocked` |
| Queued again, not being touched | `planka card move --list onDeck` |
| This branch should stop being tracked | `planka card detach` |
| Where did this branch's card go | `planka status`, `planka open` |

## Branches that are never tracked

`main` and `master` never get a card created for them — a card is one unit of work and a
default branch is not one. Editing the primary checkout directly therefore leaves the
board alone. An existing card on such a branch still resolves; only creation stops.
Override with `skipBranches` in the config, which replaces the default rather than adding
to it.

## When nothing happens

`planka` exits 0 in silence whenever it is not configured, which is correct on any
machine without the work overlay. To tell "not configured" from "broken", run it with
`--strict`, or read `~/.claude/planka/log`.
