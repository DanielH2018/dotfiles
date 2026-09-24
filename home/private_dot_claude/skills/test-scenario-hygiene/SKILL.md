---
name: test-scenario-hygiene
description: Use when a finished change carries more test than it needs — test additions outweighing the implementation they cover, scaffolding written to drive out one line and never removed, a `temp`/`wip`/`scaffold` name about to be committed, an assertion that a stub ran rather than what it did, or an unexplained skip/xfail. Also on "clean up the tests", "did I over-test this", "trim the test additions", and before requesting review after a TDD session. Covers test CONTENT; pr-review-prep covers diff shape and commit history.
---

# test-scenario-hygiene

TDD leaves scaffolding behind. Tests written to drive out one line of implementation are
useful for an hour and then cost a reader's attention forever. This is the pass that removes
them, once, at the end — not a verification step bolted onto routine work.

Run it when a feature or bugfix is finished and before review. Skip it when the session added
no tests, or when the user has already reviewed the additions.

Scope is **the tests this session added or changed**, nothing else. A test that was already in
the repo is out of scope however scaffold-shaped it looks.

## Step 1 — Find what this session added

```sh
git diff --name-only && git diff --cached --name-only
git diff --stat $(git merge-base origin/HEAD HEAD)..HEAD
```

Take whichever range covers this session's work. List every test function added or modified in
those files — the functions, not just the files, since a mostly-durable file can carry two
scaffold tests.

If there are no test changes, say so and stop. Don't go looking for older ones to justify a run.

## Step 2 — Categorize

Delegate to one subagent so the categorization is made by something that did not write the
tests and has no stake in keeping them. Give it the test names and this rubric.

**Keep** — durable coverage:

- Tests that hit a real boundary (the filesystem, a rendered template, a parser, a real HTTP
  or CLI surface).
- Unit tests for pure functions with real branching.
- End-to-end tests for a workflow the user actually performs.
- Edge cases whose failure would break something.

**Discard** — little durable value:

- Tests that exercise only a stub, a language built-in, or a library's own behaviour.
- Assertions on private state, or on how often a stubbed callable ran, rather than on the
  effect. (See *Anti-patterns* below.)
- Coverage a stronger integration test in the same change already provides.
- Scaffolding added to drive out one line of implementation.
- `skip` or `xfail` markers with no explanation.

A name containing `temp`, `scaffold`, `wip` or `todo` is a reason to look, never an automatic
discard.

End the subagent's brief with this line verbatim — a reviewer asked to find deletions defaults
to finding none:

> If you don't recommend multiple discards, you're probably too permissive.

Ask it to return one line per test: `path::test_name — keep|discard — reason`.

## Step 3 — Apply the two carve-outs before presenting

The rubric is generic and this repo's testing doctrine overrides it in two places. Move any
test the subagent marked `discard` back to `keep` when either applies, and say you did:

- **Never break a red-proof pair.** A check ships with one input it must accept and one it
  must reject. The rejecting half (`..._is_flagged`, `..._is_rejected`) looks like scaffolding
  in isolation and is the only evidence the check can go red at all. Both halves stay.
- **Never remove a non-vacuity assertion.** A guard that finds its subject by glob passes
  vacuously once the glob matches nothing, so an assertion that the census contains named
  members (`KNOWN_CONSUMERS`, `assert len(found) >= n`) is load-bearing however trivial it reads.

Both carve-outs stand on their own reasoning above. Where a repo states them itself, defer to
its wording — the server repo's `CLAUDE.md` carries both, with the incidents behind them, under
*Python & Tests*.

## Step 4 — Present and ask

Show the keep and discard lists with paths, test names and reasons, plus anything Step 3 pulled
back. Ask which to remove: all recommended, review one at a time, or none. Removing a test is
the user's call — never delete on your own judgment.

## Step 5 — Remove, then verify

Delete the agreed tests, and any fixture or helper that nothing else uses afterwards. Then run
the suite covering what you touched, and the repo's linter. A hygiene pass that leaves a red
suite or an unused import has cost more than it saved.

Report what was removed, what was kept against the subagent's recommendation and why, and the
suite result.

## Anti-patterns

Five ways a test stays green while checking nothing. They apply when writing a test as much as
when sweeping one. Adapted from `testing-anti-patterns` on noriskillsets.dev, rewritten in
pytest idiom.

- **Assert the effect, not the stub.** A test that asserts a `monkeypatch`ed callable ran, or
  counts how often it ran, passes for a correct and an incorrect implementation alike. Assert
  the state the call was supposed to produce.
- **Stub the slow or external call, never the behaviour under test.** Over-stubbing "to be
  safe" strips the side effect the assertion depends on, so the test passes for the wrong
  reason. Write the test first and watch it fail against the real implementation — that
  failure names the seam to stub.
- **A stub returns the whole shape its caller reads**, including fields this test never
  touches. A partial return passes here and breaks in the real path, where something
  downstream reads the missing key.
- **A method only tests call belongs in a test helper**, not on the production class. A
  test-only `reset()` can fire in production.
- **A textual assertion needs an oracle the file under test doesn't supply.** Asserting that a
  doc contains a sentence copied out of that same doc proves only that the file equals itself:
  it breaks on any reword and passes while everything around it is wrong. Assert an
  identifier, a schema or an invariant instead. The server repo's
  `ansible/tests/deploy/test_ci_cancelled_is_not_a_verdict.py` is the pattern — it asserts that
  `_CI_NO_VERDICT_CONCLUSIONS` and `cancelled` appear in that repo's CLAUDE.md, not the
  paragraph around them, so a rename breaks the test and a reword doesn't. A generated file is
  the other sound case: its generator re-derives the content, which is a real oracle.
