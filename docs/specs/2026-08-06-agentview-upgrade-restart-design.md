# Agent View — restart a running picker across an in-place upgrade — design

**Status:** design approved (2026-08-06); pending spec review before planning.

## 0. Decisions (locked via brainstorming)

| Decision | Choice | Why |
| --- | --- | --- |
| Behaviour on detecting a changed script | Silently re-exec the picker | Correct for any schema change, not only an added column. A banner leaves the rows wrong until the operator acts on it. |
| State carried across the restart | The typed query only | Fold state already lives on disk. Restoring the cursor needs an identity→position lookup and a rule for "that session ended", for a case that arises at most once per upgrade. |
| When the check runs | Immediately before each repaint | The only moment skewed rows can appear. Nothing polls; an idle picker costs nothing. |
| Fingerprint scope | Launcher **and** every module in `$AV_LIB` | The incident changed `render.sh`, not the launcher. A launcher-only fingerprint would have missed it entirely. |

## 1. Problem

fzf's field selection is fixed at launch: `--with-nth=3..` and `--id-nth=2` are argv, read once. The row schema, however, is produced by a *separate later process* — every repaint is `reload('$SELF' --body)`, which re-executes the launcher from disk.

So an upgrade that changes the row schema while a picker is open pairs an old fzf with new rows. Commit `a493a71` did exactly that: it inserted a stable identity column at position 2 and moved `--with-nth` from `2..` to `3..`. A picker opened before the deploy kept `--with-nth=2..`, and its next repaint rendered field 2 — the `\x1f`-joined `host␟cwd␟kind` identity — as though it were display text:

```
fedora/home/daniel/.local/share/chezmoibg  ▏ 1  Linux  claude · chezmoi  ··
fold:completed                             ▏ ▾ COMPLETED 1
```

Observed 2026-08-06: deploy at 16:13:43, screenshot at 16:15:00, with `fzf … --with-nth=2..` still running from 15:21. The rows are correct; only the column offset is wrong. The picker never recovers on its own — it renders that way until closed.

This is not specific to that one commit. Any future change to field order, field count, or `--id-nth` reproduces it, and the failure is silent: no error, no exit, just wrong columns.

## 2. Design

### 2.1 The repaint becomes conditional

Today every repaint is a literal reload. Each becomes a `transform`, which lets a subprocess *choose* the action fzf then performs:

```
--bind='ctrl-f:transform('"'$SELF'"' --repaint {q})'
```

`--repaint` prints exactly one of:

```
unchanged →  reload('$SELF' --body)+refresh-preview
changed   →  become('$SELF' --query <q>)
```

`become` replaces the fzf process, so the new picker parses its own argv — which is the whole point: the stale `--with-nth` cannot survive.

Both halves of this mechanism were verified against fzf 0.74.2 before the design was accepted:

- a `transform` may emit `become`, and `{q}` reaches it — the probe printed `BECAME q=ROW` and fzf exited;
- an env var exported before fzf is visible to the `transform` child, which is how the fingerprint reaches `--repaint` without a temp file.

### 2.2 Fingerprint

`agentview --fingerprint` prints a digest over the launcher and every `*.sh` in `$AV_LIB`. Size and mtime suffice: these files arrive via `chezmoi apply`, which replaces them atomically rather than editing in place.

The picker computes it once at startup and exports it as `AV_FP` before invoking fzf. `--repaint` recomputes and compares against `$AV_FP`. A mismatch means the bytes behind the next `--body` are not the bytes this fzf was launched for.

Deliberately coarse: any change to any module restarts the picker, including one that could not have affected the row format. During active development on agentview — the only time this fires — a restart per apply is the desired behaviour, not a cost.

### 2.3 `--query`

One new flag, seeding fzf's `--query`. It exists solely so the restart can carry the typed filter.

### 2.4 The paths that repaint

Ten `reload(` sites, in three shapes:

- **eight key binds** (`executable_agentview:659-666`) — `ctrl-t`, `ctrl-v`, `ctrl-g`, `ctrl-r`, `ctrl-p`, `ctrl-f`, `ctrl-n`, `ctrl-x`. Each becomes a `transform`.
- **the fold toggle** (`executable_agentview:107`) — reached through `--enter`, which is *already* a transform choosing between accept and fold. It composes its own action string, so it gains a fingerprint branch rather than a new mechanism. Easy to miss: it is the one repaint that is not a key bind and not a poster.
- **one poster** (`rows.sh:635`, `post_reload()`) — shared by `--refresh-remote` and `--watch`, so both background paths are fixed in a single function.

**Open mechanism question, to be settled in slice 3 rather than guessed at now:** whether the `--listen` HTTP API accepts a `transform(...)` action and resolves `{q}` the way a key bind does. If it does not, the posters check the fingerprint themselves — they are already separate processes reading the same files — and POST `become(...)` directly. The fallback is known to work; only the tidier form is uncertain.

## 3. Sequencing

Thin slices, each exercisable by hand:

1. `--fingerprint`, `--repaint`, `--query`, wired to `ctrl-f` alone. Provable with one keypress: open a picker, `chezmoi apply` a changed module, press `ctrl-f`.
2. The remaining seven key binds, plus the fold toggle in `--enter`.
3. `post_reload()`, resolving §2.4.
4. Regression test and mutation check.

## 4. Testing

The pty harness (`tests/lib/pty.js`) already drives the real picker through a real fzf, so the test reproduces the real failure rather than asserting on the wiring:

1. open a picker against a scratch launcher and module copy;
2. rewrite the module under it so `--body` emits an extra leading column;
3. trigger a repaint;
4. assert the screen shows correct rows — specifically that no `\x1f`-joined identity appears as display text.

Asserting that `--repaint` prints the string `become(...)` would pass while the picker still rendered garbage, so that is not the test.

**Mutation check:** pin the fingerprint to a constant and the test must fail with the skewed columns visible. Without that, the test could be passing because the harness never actually changed anything.

## 5. Explicitly out of scope

- **Restoring the cursor across the restart.** Decided against; see §0.
- **Reloading modules without restarting fzf.** The stale argv is the defect, and only a new process fixes it.
- **Versioning the row format.** A schema version compared at repaint is a second source of truth that can drift from the actual field layout. The fingerprint asks the question that matters — *are these the bytes I was launched for* — without anyone having to remember to bump anything.
