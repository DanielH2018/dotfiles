# claude-guard: one Python package for Bash permission decisions

Date: 2026-09-06. Status: design approved in conversation, awaiting written review.

## Goal

Replace the shell hooks that judge Bash tool calls with one Python package, `claude-guard`,
that owns segmentation, the allow and deny rules, and the shared tables. The homelab server
repo gets a second package, `homelab-guard`, that owns project policy and imports the first.
Two packages, one direction of dependency.

The outcome the migration has to deliver: one segmenter, one answer to "is this command
read-only", one home for each table (scratch roots, trusted hosts, curl hosts, remote verbs),
and one hook per event so the harness's undocumented multi-hook resolution stops mattering.

## Non-goals

- Changing what is allowed. Every rule ports with its accept/reject tests; the policy changes
  are listed under *Decisions* and are the only intended behaviour differences.
- Touching hooks that rewrite or guard files rather than judge permissions: `tq-wrap-tests`,
  `chezmoi-apply-guard`, `protect-secrets`, `isolation-guard`, and the server's
  `block-protected-edits`. `uv-python` is the exception, because it moves into
  `homelab-guard` so the server has one Bash hook package.
- Moving homelab policy out of the server repo. The rules stay where the evidence for them is.

## Current state

Five layers decide a Bash permission today, in this order:

1. Static rules in the generated `~/.claude/settings.json` (deny, then ask, then allow), with
   `autoMode.classifyAllShell` suspending the Bash allow list and handing every command to the
   classifier.
2. PreToolUse hooks: `block-dangerous-bash.sh` (user, 1144 lines, deny or ask) and the
   server's `auto-approve-readonly.py`, `uv-python.sh`, `block-protected-bash.py`,
   `nudge-land-sh.py`, `block-footguns.py`. All matching hooks run in parallel.
3. The classifier.
4. PermissionRequest hooks, fired only when a prompt is pending: `allow-compound-bash.sh`,
   `allow-readonly-remote.sh`, `allow-safe-curl.sh`, `allow-safe-rm.sh`,
   `allow-daniel-server.sh` (user), and `auto-approve-remote-ssh.sh` (server). Every one is
   allow-or-nothing, which is the only reason the unstated resolution order has not bitten.
5. `cmdparse.sh`, the shared awk segmenter three of the user hooks source, and
   `_readonly_shell.py`, a second segmenter in the server repo. `tests/fixtures/command-vectors.json`
   is the corpus that keeps the two from disagreeing.

The 2026-09-06 audit found, with `file:line` evidence: the trailing `2>&1 | tail -N` tolerance
implemented in three files; the read-only question answered in eight places; the homelab host
allowlist defined in both repos; two rewriting hooks with no stated winner; and two of the
morning's draft PRs adding a fourth tokenizer and a hook that sources the chezmoi source
filename and is inert once deployed. The shell has grown past what a shell script can carry
legibly, which is the request this spec answers.

## Architecture

### `claude-guard` (dotfiles)

Source: `home/dot_local/share/claude-guard/`. Deployed: `~/.local/share/claude-guard/`. Same
layout as `jsonq` and `tq`: the code under `share`, one-line shims under `~/.claude/hooks/`.

Python 3.14 syntax, stdlib only. The package carries its own `pyproject.toml` with
`requires-python = ">=3.14"` and a lockfile with no dependencies.

```
claude-guard/
  pyproject.toml
  claude_guard/
    __init__.py
    segment.py      # the awk pass, ported; same contract as cmdparse.sh
    rules.py        # reads deployed settings; allow from user scope, deny/ask from all
    judge.py        # the compound decision
    deny.py         # block-dangerous-bash's rules
    tables.py       # SCRATCH_ROOTS, CURL_HOSTS, TRUSTED_SSH_HOSTS, REMOTE_READONLY_VERBS
    checks/
      scratch.py    # rm and heredoc-write operands under a scratch root or the cwd
      curl.py       # GET/HEAD against an allowlisted host, option allowlist
      git_reset.py  # clean tree, origin/master or origin/main
      ansible.py    # --check / --list-* / --syntax-check, no file-valued extra-vars
      remote.py     # ssh/hl read-only verbs, trusted hosts
    cli.py          # permission-request | pre-tool-use | explain | replay | segment --json
  tests/
```

`segment.py` keeps `cmdparse.sh`'s contract verbatim: a list of segments, each with its
terminating separator (`&&`, `||`, `;`, `|`, `&`, newline, eof), its heredoc bodies, and
whether the heredoc delimiter was quoted; substitutions stay inside the segment that carries
them and are counted; an unbalanced quote or an unavailable input is a refusal, never a skip.
`command-vectors.json` is its acceptance test.

`rules.py` reproduces the scope asymmetry `allow-compound-bash.sh` documents: allow comes from
the user-level settings alone, deny and ask from every settings file in scope, so a project
can only tighten. Matching follows Claude Code's prefix semantics for `Bash(prog:*)` and its
glob semantics for patterns with an interior wildcard.

`checks/` are pure functions from one segment to a verdict. Each owns nothing but its option
allowlist; every table it reads comes from `tables.py`. Adding a delegate is adding one file
and one line in `judge.py`.

`judge.py` allows a chain when every segment is allow-listed or passes a check, and no segment
matches deny or ask. It carries three of PR #477's four rules: a newline separates like `;`; a
`cat > path <<'EOF'` with a quoted delimiter is judged as a write to `path`; `set -…`
segments are skipped; `timeout N` is stripped before the program is judged. A single segment
is judged exactly like a chain of one. CORRECTED (Task 8 fix round 1, G1): #477's fourth rule,
stripping a literal `VAR=value` prefix, is NOT ported — it is a fail-open (an assignment can
change what the rest of the segment executes, e.g. `PATH=/tmp ls -la`), and removing it
restores parity with the deployed hook it replaces, which never stripped one. A segment
carrying a leading assignment refuses instead, under its own `assignment` rule label.

`deny.py` ports `block-dangerous-bash.sh` rule by rule against
`tests/hooks/block-dangerous-bash-vectors.js`, which becomes a JSON fixture the pytest reads.

`cli.py` exposes five subcommands. `permission-request` and `pre-tool-use` read the hook JSON
on stdin and print a decision or nothing. `explain "<cmd>"` prints the segments and the rule
that decided each, for debugging a surprise prompt. `replay <jsonl>` runs a file of
`{command, cwd}` records and prints the allow count and the allowed commands, which is the
cutover gate below. `segment --json` prints `cmdparse.sh --json`'s shape for tests and the
parity gate.

Two shims in `home/private_dot_claude/hooks/`: `guard-permission-request.sh` and
`guard-pre-tool-use.sh`. Each resolves the interpreter with `uv python find --no-project --managed-python --system 3.14` (without `--no-project`, a shim run inside a uv project resolves that project's venv; `--system` stops uv answering with a virtual environment found in the working directory, which a version-matching `.venv` otherwise wins), execs it
with `-S` on the package's entry point, and implements the failure contract for its event.
They replace six hook registrations in `settings.base.json`: the five PermissionRequest hooks
and `block-dangerous-bash.sh`. A third entry point, `~/.local/bin/claude-guard`, is the human
CLI and is not a hook.

### `homelab-guard` (server repo)

Source and deployment: `~/server/.claude/hooks/homelab_guard/`, run under the repo's uv-pinned
interpreter, which is already 3.14.

```
homelab_guard/
  __init__.py       # sys.path insert of ~/.local/share/claude-guard, guarded
  footguns.py       # block-footguns rules
  protected.py      # block-protected-bash rules
  land_nudge.py     # nudge-land-sh
  uv_rewrite.py     # uv-python's rewrite and the stdio fixup
  grants.py         # kubectl read verbs, the probe.py grant, the remote-ssh answer
  cli.py            # pre-tool-use | permission-request
```

It imports `claude_guard.segment` and `claude_guard.tables`. Its private segmenter
(`_readonly_shell.py`) and tables (`_readonly_tables.py`) are deleted; `SSH_HOSTS` moves to
`claude_guard.tables.TRUSTED_SSH_HOSTS`, so the host allowlist is defined once.
`auto-approve-readonly.py` shrinks to `grants.py`. Two shims replace the five Bash hook
registrations in the server's `.claude/settings.json`.

## Decision flow

PreToolUse runs on every Bash call. `claude-guard pre-tool-use` evaluates the deny rules and
nothing else. `homelab-guard pre-tool-use` evaluates footguns, protected paths and the nudge,
and emits the `uv` rewrite. The harness runs both in parallel and neither sees the other's
output, which is the situation today and is now written down.

PermissionRequest runs only once the classifier has decided to ask. `claude-guard
permission-request` runs the judge. `homelab-guard permission-request` answers only its own
grants. The rewritten command text is what both see, since the harness applies `updatedInput`
before permission evaluation.

## Failure contracts

Stated once, in each shim, and tested end to end.

| path | cannot run or cannot parse | posture |
|---|---|---|
| any allow path | emits nothing | the prompt stands |
| `claude-guard` deny path | the shim emits `ask` itself, without Python | matches `block-dangerous-bash` on a missing `jq` |
| `homelab-guard` deny path | stderr line, exit 0 | the posture issue #1014 already tests |

A server pytest asserts that `import claude_guard` resolves on the deployed machine, so a
silent disarm shows in CI rather than in a transcript.

## Interpreter

`run_once_after_install-python-tools.sh.tmpl` already runs `uv python install 3.12`; it gains
3.14. The shims resolve the path at call time with `uv python find --no-project
--managed-python --system 3.14` rather than at
`chezmoi apply` time, so an interpreter upgrade cannot leave a stale path in a deployed shim.
`--system` stops uv answering with a virtual environment found in the working directory,
which a version-matching `.venv` otherwise wins.
Startup measured for the design: `python3 -S` on an empty script is about 7 ms on this
machine (10 runs in 69 ms, 2026-09-06, uv-managed 3.14.6); the bash hooks fork `jq` and `awk` several times each and are not faster.

## Testing

Pytest, run under the same 3.14 via the package's `pyproject.toml`; the repo's
`python-suites.test.js` runner picks it up. Three layers:

- Unit. Every check and every deny rule ships as an accept/reject pair, `…_is_allowed` /
  `…_is_refused`. `command-vectors.json` becomes the segmenter's acceptance test; one
  implementation asserts both its `cmdparse` and `readonly` fields, and the server's
  `test_command_vectors.py` covers homelab rules only.
- End to end. The node:test suites that drive the real hooks against a temp HOME port to
  pytest driving the shims the same way, so the settings-reading path and the failure
  contracts are exercised rather than only the functions.
- Replay. `claude-guard replay` over a JSONL of real prompted commands is a local tool, not a
  committed fixture, because the corpus is transcript-derived.

## Rollout

Six slices, each runnable on its own. Shadow mode uses the existing `bin/shadow-report`
tooling: the new hook is registered beside the old ones, logs its verdict, and decides nothing.

| slice | ships | exit criterion |
|---|---|---|
| 1 | package skeleton, `segment.py`, `explain`, `replay` | vector corpus green; replay of the 2026-09-06 corpus (677 commands) segments identically to `cmdparse.sh` on every one |
| 2 | `rules.py`, `judge.py`, scratch and curl checks, PermissionRequest shim in shadow | `shadow-report` shows at least 200 records collected over at least 3 days, with zero `python_only`, zero `python_error`, and no `bash_only` row other than `not-compound`; an empty log satisfies none of this. A `not-compound` `bash_only` row is slice 3's own intended change showing up early -- the bash judges a single segment with a standalone hook where `judge()` ports its `:51-59` eligibility test, so the census scores the difference this slice deliberately keeps. Every other `bash_only` rule name is a real disagreement and blocks |
| 3 | PermissionRequest cutover; the #477, #474 and ansible rules; the five bash hooks removed | **Done.** Exit criterion was replay allows at least the 84 of 677 the #477 prototype allowed; PRs #474 and #477 closed unmerged, #476's hook half dropped. Measured: the corpus was rebuilt at 1058 records, not 677 -- it is transcript-derived and not committed, so slice 1's count was already stale by slice 3. `replay --judge --compare-hooks` reads `ALLOW 84/1058`, exactly the floor: the gate was met, not cleared with margin. |
| 4 | `deny.py` in shadow, then cutover; `block-dangerous-bash.sh` unregistered on the host (kept, frozen, for the sandbox) | **Done, with one change from plan.** Vector file green (`tests/test_deny.py` against 32 deny / 27 allow groups, 281 commands; package suite 822). `replay --deny --compare-hook` gave `AGREE 1058/1058` on the 2026-09-06 corpus and `AGREE 281/281` on every vector. `shadow-report --deny` read 11,973 records over 6.6 days (2026-09-10T11:40Z–2026-09-17T01:10Z) with zero `python_only`, `bash_only`, `mismatch`, `detail_mismatch`, `python_error`, `bash_error` and `bash_timeout` rows — clear of the >=200-over->=3-days floor with a wide margin. The cutover PR flipped `CLAUDE_GUARD_DENY_SHADOW` to `0` and removed `block-dangerous-bash.sh`'s PreToolUse registration, but the file itself is **unregistered on the host and frozen, not deleted**: the sandbox (`home/private_dot_claude/sandbox/`) bind-mounts and registers the deployed copy as its own in-container deny hook and cannot yet run the Python port, so removing the file would have shipped a silent fail-open there on every new machine. Removed when the sandbox runs the port (follow-up, not this PR). See `docs/plans/2026-09-17-claude-guard-slice-4-cutover.md`, "What shipped differently," for the long form. The `bash_timeout` clause that used to sit here (large heredocs, the bash's quadratic segmenter) no longer gates a host-side shadow comparison — that comparison stopped when the hook was unregistered — but the underlying cost is still real for the sandbox's own operation, unchanged by this PR. |
| 5 | `homelab-guard`: four hooks and `uv-python` consolidated, private segmenter and tables deleted, `SSH_HOSTS` moved | server suite green; the deployed-import test green |
| 6 | `cmdparse.sh`, the node hook suites, and the doc sections describing the old layering retired | `claude-shell-permissions.md`, the CLAUDE.md permission sections and the settings comments updated in the same PRs |

Slices 1 to 4 and 6 are dotfiles PRs; slice 5 is a server PR that lands after slice 3 has
deployed. `stash-mine` (#475), the `stdio-blocking` script with its ask entries (#476), and
the server's `uv-python` change (#1368) land independently and ahead of this.

Shadow is per side. The PermissionRequest shim reads `CLAUDE_GUARD_SHADOW` and logs to
`claude-guard-shadow.jsonl`; the PreToolUse shim reads `CLAUDE_GUARD_DENY_SHADOW` and logs
to `claude-guard-deny-shadow.jsonl`. Slice 4 ships before slice 3 because its census is
independent of slice 2's, and a shared switch would take the deny side live with the allow
side's cutover. The deny side's verdict has a fourth value the table above does not name:
`allow` with `updatedInput`, the `--force` → `--force-with-lease` upgrade the bash performs
at :1130-1142. It ports as-is.

## Decisions

Recorded here and as `DECIDED` markers at the line each governs, so a reviewer does not
re-derive them.

- **The segmenter moves to Python.** `cmdparse.sh` was kept in bash for interpreter start on
  the hot path and for a missing interpreter being a fail-open surface. The first is measured
  above and the second is closed by the shim contracts. This overturns the header in
  `cmdparse.sh` and the "meant to stay separate" note in both vector suites.
- **One segmenter, both repos.** The server package imports it rather than keeping a second.
- **A single segment is judged like a chain.** Today the compound hook makes no decision on
  one segment, so a wrapper's blanket allow entry reaches the rule only inside a chain, and a
  bare `jsonq` or `stash-mine drop` is the classifier's call. Telemetry cannot distinguish the
  two, since both accepts are labelled `source=config`.
- **Python 3.14 syntax**, under uv's managed interpreter, rather than 3.9 under the system one.
- **The four prototype PRs are superseded, not landed.** Their rules and tests port into the
  package.
- **Homelab policy stays in the server repo** as `homelab-guard`; only the shared tables move.

## Open questions

None that block slice 1. Two are deferred to the slice that meets them:

- Whether `allow-readonly-remote`'s verb table and `allow-daniel-server`'s host trust collapse
  into one `remote` check with two tiers, or stay two checks. Decided in slice 3, as D1: two
  functions, `readonly_remote_safe` and `trusted_host_safe`, because the bash hooks have
  different parsers and neither has the other's filter.
- Whether the two rewriters, `tq-wrap-tests` and `homelab-guard`'s `uv` rewrite, need an
  ordering. Both run in parallel today and neither sees the other. Measured in slice 5.
