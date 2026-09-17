# claude-guard slice 4: the deny-side cutover

`guard-pre-tool-use.sh` becomes the PreToolUse decider for Bash and `block-dangerous-bash.sh`
is deleted. Spec: `docs/specs/2026-09-06-claude-guard-design.md`, Rollout row 4. The port
itself (`deny.py`) landed in PR #481 and has run in shadow since 2026-09-09.

## The gates, measured 2026-09-17 before any change

Row 4 names four. All four are green.

- **Vector file green.** `tests/test_deny.py` consumes
  `tests/fixtures/block-dangerous-bash-vectors.json` (32 deny groups, 27 allow groups, 281
  commands); the package suite passes at 822.
- **`replay --deny --compare-hook` on the corpus:** `AGREE 1058/1058` against the deployed
  `~/.claude/hooks/block-dangerous-bash.sh`, on the 1058-record corpus at
  `~/.claude/artifacts/claude-guard-slice3/prompted_inputs-2026-09-12.jsonl`.
- **`replay --deny --compare-hook` on every vector:** `AGREE 281/281`, the fixture flattened to
  one record per command.
- **`shadow-report --deny`:** 16,235 records from 2026-09-09T22:41:03Z to 2026-09-17T01:10:49Z.
  One `bash_only` row, at 2026-09-10T11:37:36Z with an empty rule name — PR #484 deploying in
  halves (its bash change reached `~/.claude/hooks/` while the matching `deny.py` sat
  unapplied in the source tree for three minutes). From 2026-09-10T11:40Z, after that apply:
  **11,973 records over 6.6 days with zero `python_only`, `bash_only`, `mismatch`,
  `detail_mismatch`, `python_error`, `bash_error` and `bash_timeout`.** The floor is 200 over 3
  days.

Unlike slice 3's gate, this census is two-sided. PreToolUse fires on every Bash call, so the
log holds both sides' verdict for 16k commands the bash judged — `deny 184`, `allow 6`,
`none 16044` — not only the prompted subset.

## What has NOT drifted

`block-dangerous-bash.sh` changed twice since `deny.py` was written: #484 (both sides, same
PR) and the slice-3 comment fix (`eecd6df`, no behaviour). `deny.py` is at parity by
construction and by census.

## The cutover, one PR

1. `home/.chezmoitemplates/settings.base.json`: `env.CLAUDE_GUARD_DENY_SHADOW` `"1"` → `"0"`;
   remove the `block-dangerous-bash.sh` PreToolUse registration; fix the comments at both
   sites. `guard-pre-tool-use.sh` stays and becomes the decision.
2. `home/private_dot_claude/hooks/executable_guard-pre-tool-use.sh:38`: the shim's own
   default `:=1` → `:=0`. Same two-place flip as slice 3, same reason: a stale generated
   `settings.json` that lost the key must fail toward live, not toward a shadow mode with no
   bash left to compare against.
3. Delete `home/private_dot_claude/hooks/executable_block-dangerous-bash.sh`,
   `tests/hooks/block-dangerous-bash.test.js`, `tests/hooks/block-dangerous-bash-vectors.js`.
   Keep `tests/fixtures/block-dangerous-bash-vectors.json` — `test_deny.py` is its consumer
   now.
4. **Keep `cmdparse.sh`.** Its last hook consumer goes with this PR, but slice 6 owns its
   retirement together with the node suites that pin it (`cmdparse.test.js`,
   `cmdparse-shadow.test.js`) and the M02 census. Fix its header comment to say so.
5. `tests/settings/settings-base-shape.test.js`: assert `block-dangerous-bash.sh` is gone
   from PreToolUse and `guard-pre-tool-use.sh` remains. Mutation-prove it.
6. Tests whose subject this deletes. `test_deny.py:813` and `test_hook.py:505,716` gate on
   `HOOK.exists()` / `DENY_HOOK_SRC` — after step 3 they skip silently and forever. Delete
   them with their subject. `test_bash_deny_verdict_missing_hook_is_error_not_none` and the
   timeout test drive a fake hook and stay. `test_cli.py:364` `DENY_HOOK_SRC` likewise.
7. **Keep the deny-side shadow apparatus** — `DENY_HOOK`, `bash_deny_verdict`,
   `deny_shadow_record`, `summarize_deny`, `DENY_LOG_NAME`, `replay --deny --compare-hook`.
   `shadow_mode` and `append_log` are shared with the allow side. Slice 6 retires all of it as
   one piece.
8. `home/.chezmoiremove`: create it, listing `.claude/hooks/block-dangerous-bash.sh` and the
   six allow hooks slice 3 deleted plus `.claude/hooks/test_allow_daniel_server.py`, so the
   apply removes them on every machine rather than leaving unmanaged copies. Slice 3 found
   this the hard way: a rc=0 apply left all six executable in `~/.claude/hooks/`.
9. `node bin/config-soak land`.
10. Docs in the same PR: spec row 4 marked done with the numbers above; the row's
    "bash_timeout rows are expected on large heredocs … subject of a follow-up against the
    bash" clause is moot once the bash is gone, say so; `README.md`; every present-tense claim
    about `block-dangerous-bash.sh` deciding anything, in `settings.base.json`,
    `settings.permissions.json`, `cmdparse.sh`, the two SKILL.md files slice 3 touched, and
    the server repo's `CLAUDE.md` (which names it under `block-protected-bash`) — that last
    one is a separate repo and a separate PR; list it as a follow-up rather than touching it
    here.

## After landing

`chezmoi apply`, then verify the change rather than the workload: drive
`~/.claude/hooks/guard-pre-tool-use.sh` directly with `rm -rf /` (expect the deny JSON with
#484-era wording), `git push --force origin main` (expect the `--force-with-lease` upgrade),
and `ls -la` (expect no output). Then `chezmoi unmanaged .claude/hooks` must list nothing
from either slice. A session already running when the apply lands keeps
`CLAUDE_GUARD_DENY_SHADOW=1` from its own env block and `block-dangerous-bash.sh` still
registered in its loaded settings. The file still exists (kept for the sandbox) and reads no
env var, so that session keeps the bash deny until it restarts — fail-closed, like slice 3,
for a different reason: there the allow side falling away meant a prompt, here the deny side
is simply not removed. (An earlier draft of this section said fail-open; that was true of the
original plan to delete the file and false of what shipped.) Restart live sessions anyway, so
the host converges on one decider before slice 6 retires the bash.

## Not in this slice

The `hl`/`ssh` remote-verb table consolidation and `uv-python` (slice 5, server repo).
`cmdparse.sh`, the node hook suites, the shadow logs and the doc sections on the old layering
(slice 6).

## What shipped differently

Step 3's "delete `block-dangerous-bash.sh`" turned out to be wrong once checked against a
consumer this plan never considered: `home/private_dot_claude/sandbox/executable_claude-sandbox`
bind-mounts the deployed copy of this exact file read-only into the sandbox container, and
`home/private_dot_claude/sandbox/settings.base.json` registers it there as the container's own
PreToolUse deny hook. That sandbox has no `uv`, no managed Python 3.14, and no mount for
`~/.local/share/claude-guard`, so it cannot run `deny.py` instead. Docker turns a missing
bind-mount source into a silently-created empty directory rather than a failed run, so deleting
the file would leave a fresh machine's sandbox running with its registered deny hook silently
replaced by a directory — fail-open, in the sandbox, discovered by nobody until an audit.

**What actually shipped:** the file stays in source, deployed, and unchanged — a header comment
at its own top says why and points here. Only its *host* registration is cut: the two-place flip
(`CLAUDE_GUARD_DENY_SHADOW`, the shim default) and removing it from `settings.base.json`'s
PreToolUse block still land exactly as planned. Its five test files
(`tests/hooks/block-dangerous-bash.test.js`, `-vectors.js`, `-normalization.test.js`,
`tests/lib/block-dangerous-bash.js`, `tests/hooks/cmdparse-shadow.test.js`) all stay too — the
file still runs, in the sandbox, so an untested frozen copy would be worse than the tested one
already in the tree. `cmdparse.sh` keeps its real consumer (sandbox-only now) and is not
retired this slice either. Three `SECRET_PATHS`/census-family parity checks that used to read
the deployed bash directly (`jsonq.test.js`, `tests/hooks/protect-secrets.test.js`,
`tests/secret-registry.test.js`) are still repointed at `claude_guard.deny` as their oracle —
that direction is right independent of whether the bash file is deleted or merely unregistered,
since the host no longer runs it either way.

Removing `block-dangerous-bash.sh` for real is the sandbox-port follow-up's job: ship `uv` and
the `claude-guard` package into the sandbox's container image, repoint the mount and the
registration at `guard-pre-tool-use.sh`, then delete the file, its sourcing of `cmdparse.sh`,
and the five test files above, together with `cmdparse.sh` itself. Not attempted here.
