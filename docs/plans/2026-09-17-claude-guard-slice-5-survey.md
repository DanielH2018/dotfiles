# claude-guard slice 5: survey of the server repo's Bash hooks

Input for re-planning the `homelab-guard` consolidation the spec describes at
`docs/specs/2026-09-06-claude-guard-design.md`, "homelab-guard (server repo)". Surveyed
2026-09-17 against `DanielH2018/server` at `c246ea0a8`. Every line citation is to that tree.
Twelve of these facts contradict the spec's description; slice 5 was narrowed on the strength
of them and the consolidation waits for a plan written from this page.

## Registrations

`.claude/settings.json`, hooks block `:23-140`. Six Bash-surface registrations across two
events, not the five the spec counts:

- PreToolUse, matcher `Bash`, in order: `auto-approve-readonly.sh` (`:30`, timeout 10),
  `uv-python.sh` (`:35`, 10), `block-protected-bash.sh` (`:40`, 15), `nudge-land-sh.sh`
  (`:45`, 10), `block-footguns.sh` (`:50`, 10).
- PermissionRequest, matcher `Bash`: `auto-approve-remote-ssh.sh` (`:101`, 10).

Library modules, registered nowhere: `_readonly_shell.py`, `_readonly_tables.py`,
`_hook_common.py`, `hooklib/`.

Every `.sh` shim is the same shape: `cd /home/ubuntu/server || { stderr; exit 0; }` then
`exec /home/ubuntu/.local/bin/uv run --no-sync --quiet python <hook>.py`. The hooks dir is
`sys.path[0]`, so bare-name imports resolve. Fail-open: a Python crash emits nothing and the
prompt stands.

## The hooks

### `auto-approve-readonly.py` (753 lines)

A deny-by-default read-only classifier. `classify(command)` (`:668-712`) tokenises each line
with `shlex(posix=True, punctuation_chars=True)`, splits on `_SEQ` then `|`, strips write-free
redirects, and requires every stage's argv[0] to be in `TIER1` or pass a per-program guard in
`HANDLERS` (`:633-654`: ssh, git, find, sort, uniq, ip, systemctl, journalctl, rg, docker,
awk/gawk/mawk, sed, dpkg, apt, apt-mark, pipx, crontab, sensors). `main()` (`:729-749`) emits a
PreToolUse `allow`, or with `--permission-request` a PermissionRequest allow only when
`classify_remote` (`:715-726`) finds an `ssh ` stage. Imports from `_hook_common`,
`_readonly_shell` (`_FORBIDDEN, _OP_TOKEN, _SEQ, _SUBST, _split, _strip_redirects`) and
`_readonly_tables` (`SSH_HOSTS, TIER1, _SSH_FLAGS, _SSH_GLOB, _SSH_OPTIONS, _SSH_SECRET,
_SSH_VALUE_FLAGS`).

**No kubectl handling and no probe.py grant.** The spec's `grants.py` ("kubectl read verbs,
the probe.py grant, the remote-ssh answer") describes `permissions.allow` rules at
`settings.json:4-20`, not hook logic. Only the remote-ssh answer is in this file.

`auto-approve-remote-ssh.sh` (14 lines) is a shim over the same file with
`--permission-request`. `docs/claude-shell-permissions.md:47-50` says it is registered in the
user-level chezmoi settings; it is registered at `.claude/settings.json:101` and chezmoi does
not name it.

### `block-protected-bash.py` (392 lines)

Three arms: a write to a protected file → `ask` with reason (`written_paths :92`, `decide
:337`); a content-printing read of a secret-bearing host script → `deny` (`read_reason :174`);
a write escaping an isolated worktree → `deny` (`escaping_write_reason :282`). Loads
`classify` **by path from `block-protected-edits.py`** via `importlib.util.spec_from_file_location`
(`:54-77`), and `secret_bearing_host_paths` from `scripts/secrets_mgmt` via a `sys.path`
insert (`:156-172`). Has its own segmenter: `_SEGMENTS` regex (`:219`) and
`strip_heredoc_bodies` (`:222-241`). `block-protected-edits.sh` stays registered on the Edit
matcher (`:56-60`), so the shared classifier cannot move without either duplicating it or
keeping the by-path import.

### `block-footguns.py` (296 lines)

Seven silent-failure denies (docstring `:2-43`). `problem()` (`:251-273`) iterates
`split_stages`, strips leading keywords, first `_RULES` hit denies. Imports `emit_pretooluse_decision,
invokes, short_flags, split_stages, strip_shell_keywords` from `_hook_common`. Its own
`_SSH_HOSTS = ("daniel-server", "daniel-pi", "daniel-box", "daniel-stage")` (`:64`) is a
different table for a different rule (remote git needs a `cd`) and deliberately includes
`daniel-box`, which `claude_guard.tables:40-44` excludes from the trust grant.

### `nudge-land-sh.py` (152 lines)

Denies `gh run watch` / `gh pr checks --watch` and the third or later CI-status read per
session (`classify :66`, `bump :84`, counter file under `tempfile`, TTL 24h `:56`). Escape:
any command containing `land.sh`/`land.py` (`:122-123`). PEP 758 at `:97`.

### `uv-python.sh` (263 lines, bash + jq)

Rewrites `python3?|pytest|py.test|ansible(-…)?|*.py` command starts to `uv run …` (`:42`,
`:222-234`) after a quote- and heredoc-aware character walk (`:170-216`, helpers `:108-168`).
Emits `updatedInput` only when the text changed (`:256-263`). The stdio fixup (`:44-69`,
`:236-254`): an ansible CLI anywhere in the command gets `stdio-blocking; ` prepended (or the
inline `os.set_blocking` form when that binary is absent), because ansible's
`check_blocking_io()` refuses the O_NONBLOCK fds the Bash tool hands it. 59 tests drive the
bash via subprocess and read `HOOK_TEXT`; a Python port rewrites the harness, not only the
logic.

### `_hook_common.py`

A dependency of every hook and absent from the spec's package layout.
`_split_top_level_semicolons` (`:14`), `split_stages` (`:64`, a quote-aware `;` walk then
`shlex.split` per piece, cut on `&&`/`||`/`|`/`&`), `strip_shell_keywords` (`:116`),
`invokes` (`:129`), `short_flags` (`:145`), `emit_permissionrequest_allow` (`:158`),
`emit_pretooluse_decision` (`:178`). `test_module_length_ratchet.py:44` names it by path.

### `hooklib/`

Consumed only by `session-health.py:55-56` (SessionStart). Out of scope.

## Four segmenters, not one

The spec names one private segmenter. In play:

1. `classify()` + `_readonly_shell.py` — `shlex(punctuation_chars=True)` over each line
   after `command.split("\n")` (`auto-approve-readonly.py:682-688`); `_split` is a plain
   separator split; `_strip_redirects` judges redirects (input ok, `/dev/null` writes ok, fd
   dups ok, a real-file write → refuse). Substitution refused by substring test before
   tokenising (`_SUBST`); `(`/`)`/`&` refused via `_FORBIDDEN`.
2. `_hook_common.split_stages` — used by footguns and nudge.
3. `block-protected-bash._SEGMENTS` + `strip_heredoc_bodies`.
4. `uv-python.sh`'s bash character walk.

`claude_guard.segment.parse` is a single character walk over raw text with a frame stack
(quotes, backtick, paren, dparen, brace, procsub); recognises separators only at command
position; lifts heredoc bodies with quoted/unquoted delimiter; collects substitution
contents; returns `unreadable:*` statuses. Measured difference:
`classify("cat <<EOF\ntouch /tmp/pwned\nEOF")` → `None`; `parse` of the same → `ok`, one
segment with the body lifted. The server side has what `claude_guard` lacks too: redirect
safety judgement and an argv per stage. `Segment.text` is raw text.

## Tables

| server (`_readonly_tables.py`) | len | `claude_guard.tables` |
|---|---|---|
| `TIER1` (`:23`) | 88 | nearest `REMOTE_READONLY_VERBS` (`:50`, 67). `TIER1 − REMOTE` = 32 names; `REMOTE − TIER1` = 11. `printenv` is in `TIER1`; `tables.py:48-49` says `env`/`printenv` are deliberately absent. **Not equivalent; moving it is a policy change.** |
| `SSH_HOSTS` (`:120`) | 2 | `== set(TRUSTED_SSH_HOSTS)` (`:44`). **Moved in the narrowed slice.** |
| `_SSH_FLAGS` (`:125`) | 5 | none; `checks/remote.py:270` refuses any leading `-` except `-o BatchMode=yes`. |
| `_SSH_VALUE_FLAGS` (`:126`) | 4 | none. |
| `_SSH_OPTIONS` (`:130`) | 8 | none; `claude_guard` permits exactly one option value. |
| `_SSH_SECRET` (`:145`) | 1 regex | `SECRET_PATH_RE` (`:125`), identical modulo one outer group; sole consumer is `.search()`. **Moved.** |
| `_SSH_GLOB` (`:158`) | 1 regex | none; nearest `checks/remote.py:23` `_RAW_BAN`, wider and module-private. |

## Tests and guards that trip on a change

`.claude/hooks/tests/`, 275 collected across 12 files. Each file bootstraps its own
`sys.path`; `conftest.py` fences `gh/sops/docker/curl`.

- `test_auto_approve_readonly.py` — 155 inline vectors (60 approve, 90 reject, 5 remote-only),
  loads the hook by path.
- `test_uv_python.py` — 59, subprocess `bash` plus `HOOK_TEXT`.
- `test_block_footguns.py` 55, `test_block_protected_bash.py` 44, `test_nudge_land_sh.py` 25,
  `test_command_vectors.py` 17 (against the chezmoi `command-vectors.json`, skips if absent),
  `test_hook_common.py` 12, `test_auto_approve_remote_ssh.py` 10 (e2e skips without `uv`).
- `test_hook_shim_fail_open.py:70-85` asserts the exact 8-name shim census.
- `test_hook_scripts_executable.py` requires settings-referenced scripts to be 100755 in the
  index.
- `test_project_settings_shape.py:150-167` requires `timeout` on every hook entry.
- `.claude/tests/test_setup_wiring.py:46,90` — every settings hook exists; every `.sh` naming a
  `.py` points at an existing file.
- `ansible/tests/repo/module_length_allowlist.txt:16` names `auto-approve-readonly.py 753`;
  `test_module_length_ratchet.py:44` names `_hook_common.py`;
  `test_no_future_annotations_import.py:55` names `block-footguns.py`.

## Consumers outside `.claude/hooks/`

- `evals/harness_metrics.py:40-47` imports `classify()` from `auto-approve-readonly.py` by
  path. **A non-test consumer**; shrinking the file breaks it.
- `scripts/secrets_mgmt/tests/test_secret_bearing_host_paths.py:58` reads
  `block-protected-bash.py`.
- `scripts/deploy_tools/land.sh:7`: a rename must keep the `"land.sh" in command` escape.
- `scripts/deploy.sh:88`, `scripts/secrets_mgmt/rotation_tools.py:184`: comments on the
  stdio fixup.
- `ansible/tests/setup/test_host_python_invocations.py:66-67` names three shims.
- Docs: `docs/claude-shell-permissions.md:8,15,43-47,58`; `docs/reference/scripts.md:29,77`
  and `decisions.md:20-25,326-331` (generated); `docs/archive/host-python-314-plan.md`;
  `.claude/skills/issue-fanout/SKILL.md:76`; `CLAUDE.md:310-336` (the three deny hooks) and
  `:530-533` (`uv-python.sh`).

## The rewriter collision, measured

`tq-wrap-tests` is user-level: `~/.claude/hooks/tq-wrap-tests.{sh,py}` (chezmoi source
`home/private_dot_claude/hooks/executable_tq-wrap-tests.*`), registered at
`~/.claude/settings.json:747` under PreToolUse `Bash`, after `guard-pre-tool-use.sh`. It wraps a
single simple command whose argv[0] is a tq candidate in `tq …` and emits `updatedInput`.
For `pytest .claude/hooks/tests -q`, `uv-python.sh` emits `uv run pytest …` and
`tq-wrap-tests.py` emits `tq pytest …` — same event, same matcher, different settings files,
neither sees the other. `uv` is itself a tq launcher, so ordering the two would not stop tq
matching the first rewriter's output. The spec's open question is answered: no ordering
settles it; the harness's own rule for competing `updatedInput`s decides, and the fix is one
rewriter, which the re-planned slice can do.

## The import, measured

`import claude_guard` fails under `uv run --no-sync python` from `/home/ubuntu/server`
(`ModuleNotFoundError`) and succeeds after
`sys.path.insert(0, "/home/ubuntu/.local/share/claude-guard")`. The interpreter is 3.14.6.
The spec's guarded insert is required, and the deployed-import test the spec names as slice
5's exit criterion was red before the narrowed slice shipped it.

## The double launch, measured

Two PermissionRequest hooks judge every prompted ssh command since the slice 4 cutover: the
user-level `guard-permission-request.sh` (`claude_guard.judge()`) and the server repo's
`auto-approve-remote-ssh.sh` (`classify_remote`, reading `TRUSTED_SSH_HOSTS` and
`SECRET_PATH_RE` from this package since server PR #1861). Measured 2026-09-17 on
daniel-server, 20 runs each, payload `ssh daniel-server docker ps | head -3`, package
reachable: the repo shim takes 37 ms median (35 ms when the package is missing and it fails
open) and the judge shim 65 ms (1 ms when it exits at the `cli.py` existence check). The
double launch costs about 100 ms per command that reaches a prompt, and only there — in a
normal auto-mode session neither `Bash(ssh:*)` nor `Bash(curl:*)` is an ask rule, so no
PermissionRequest hook fires at all; both hooks carry Manual mode. The full table is
`docs/claude-shell-permissions.md` in the server repo (PR #1894, issue #1864).

The two hooks were not interchangeable when this was measured, which bounded the
retire-or-keep decision. On the payload above the judge emitted nothing and the repo shim
allowed: `readonly_remote_safe` (`claude_guard/checks/remote.py`) returned no opinion unless
`segment.parse` yielded exactly one segment, so any local pipeline around the ssh stage fell
through, while `classify_remote` walked each local stage and judged the ssh stage plus the
readers around it. On `ssh daniel-server uptime` both allowed.

Resolved 2026-09-18 (server #1898): the repo shim retired. `judge_segment` gained a
per-segment arm for an `ssh`/`hl` stage (after `rules.denies`, before `rules.asks`), so
`ssh daniel-server docker ps | head -3` is judged as a read-only remote stage plus an
allow-listed `head`; a `2>&1` / `2>/dev/null` word on the stage is stripped first. The
thirteen argv guards the shim reached over ssh (`git`, `find`, `sort`, `uniq`, `awk`
`gawk` `mawk`, `sed`, `dpkg`, `apt`, `apt-mark`, `pipx`, `crontab`) moved into
`checks/remote_guards.py`, and `readonly_remote_safe` re-tokenizes the remote argv the way
ssh and the far shell do — quote-stripping read `ssh host "sed '1 w /x' f"` as the script
`1`. The one hook that judges a prompted ssh command is `guard-permission-request.sh`.
