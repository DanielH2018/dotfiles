# claude-guard

One Python package for Claude Code Bash permission decisions. Slice 1 shipped the segmenter
and the CLI; slice 2 shipped the settings loader, the compound judge, the scratch-rm and
safe-curl checks, and the PermissionRequest hook in shadow; slice 3 ported the remaining
PermissionRequest hooks (readonly-remote, daniel-server host trust, ansible-readonly, plus
#474's clean-reset and #477's compound-bash rule changes), adopted the spec's single-segment
judging, and cut the hook over to live — `guard-permission-request.sh` is now the sole
decision for Bash PermissionRequest, and the six bash hooks it replaces are deleted; slice 4
ported the PreToolUse deny rules and cut `guard-pre-tool-use.sh` over to live, unregistering
`block-dangerous-bash.sh` from the host; slice 6 retired the shadow apparatus on both sides —
the allow side on 2026-09-17 (`CLAUDE_GUARD_SHADOW`, `BASH_CHAIN`, `bash_chain_allows`,
`claude-guard-shadow.jsonl`, `shadow-report`'s allow half, `replay --compare-bash` /
`--compare-hooks`: every `BASH_CHAIN` member was already deleted from disk in slice 3, so
shadow mode was comparing against nothing), and the deny side on 2026-09-18, once the sandbox
port (dotfiles #508) had moved the last runner of `block-dangerous-bash.sh` onto
`guard-pre-tool-use.sh`. That second half deleted `cmdparse.sh`, `block-dangerous-bash.sh`,
their node suites, `CLAUDE_GUARD_DENY_SHADOW`, `claude-guard-deny-shadow.jsonl`,
`shadow-report` and `replay --deny --compare-hook`. Both hooks are live-only and take no
env switch. Spec: `docs/specs/2026-09-06-claude-guard-design.md` (dotfiles repo).

## The segmenter's contract

`claude_guard.segment.parse(command)` returns a `Parsed` whose `status` is `ok` or
`unreadable:<reason>`. **A non-ok status is a refusal, never a skip.** A caller must defer
(PermissionRequest) or ask (PreToolUse); it must never read it as "nothing to worry about".

On `ok`: `segments` are the top-level commands in order, each with the separator that
terminated it (`&&` `||` `;` `|` `&` `newline` `eof`), its lifted heredoc bodies, and whether
each heredoc delimiter was quoted. `substitutions` holds the content of every `$( )`,
`` ` ` ``, `<( )` and `>( )`, flattened across nesting. This is a port of `cmdparse.sh`'s
awk pass and agrees with it field for field (`tests/test_vectors.py`), except that the bash
`heredoc` field cannot represent an empty body — the parity tests there drop empty bodies on
both sides before comparing.

`substitution_spans(command)` comes from the same pass. It locates each outermost
substitution: its kind, where it starts, where its body starts, where it ends, and whether
it sits inside a `${ }`. `mask_substitutions` replaces each span with a placeholder for
`deny.py`'s word readers, and `substitution.mask` cuts the `$( )` and `<( )` spans out for
the judge.

## Running

    claude-guard explain 'git status && ls & rm -rf /'
    printf '%s' 'ls; pwd' | claude-guard segment --json

## The judge

`claude_guard.judge.judge(command, rules, roots, cwd)` is `allow-compound-bash.sh`'s decision,
ported line for line, plus the standalone PermissionRequest hooks it never delegated to (the
four whole-command checks below) and the spec's "a single segment is judged like a chain"
decision: a bare command reaches the same checks a chained one does rather than returning
`not-compound`. It allows a chain when every segment is allow-listed or passes a check
(`checks/scratch.py` for a confined `rm`, `checks/worktree_scratch.py` for an `rm` of
untracked files, a `git clean -f -- <paths>` of untracked files, or a `git restore` to
`HEAD` inside a `.claude/worktrees/<name>` checkout,
`checks/curl.py` for a plain GET/HEAD against an allowlisted host, the
`git merge --ff-only <ref>` exception), and no segment matches deny or
ask, or when the whole command passes one of `checks/remote.py`'s `readonly_remote_safe()` /
`trusted_host_safe()`, `checks/ansible.py`'s `ansible_readonly_safe()`, or
`checks/git_reset.py`'s `clean_reset_safe()`. Before a segment is judged, the judge reads
past a loop keyword (`for … in`, `while`, `until`, `do`, `done`) and a literal leading
`NAME=value` whose name `assignments.py` allows, and `git -C <path> <sub>` is judged as
`git <sub>` run in `<path>`. A path that is one double-quoted word of literal text and
`$NAME` references (`git -C "$d" status`) is admitted only for a read. A git read the allow
list cannot express safely goes through `gitread.py`, a table of subcommands that read with
some arguments and write with others (`symbolic-ref`, `ls-remote`, `range-diff`,
`merge-base`). A `$( )`, `<( )` or `>( )` is judged as a command of its own, with no cwd,
and `substitution.py` replaces it in the outer command with a placeholder. The placeholder,
and any variable assigned from it, may stand only in a standalone assignment, a `for` word
list, an argument to a command whose arguments cannot write or exec (`echo`, `cat`, `grep`,
`diff`, …), or a `printf` argument after a literal format. A backtick, or a substitution
inside `$(( ))` or `${ }`, stays `unjudgeable:substitution`. A redirect is found on the quote-masked text, so a quoted
`>` is an argument, and a `>`/`>>` into a scratch root is allowed when
`checks/scratch.py`'s `write_confined()` vets the target and no segment of the chain can
place a link there first. The two remote checks also run per segment,
so an `ssh`/`hl` stage inside a local pipeline is judged beside the allow-listed readers
around it; `checks/remote_guards.py` holds the per-verb guards (`git`, `sed`, `awk`, `find`,
`apt`, …) a remote argv is held to. `rules.py` reads the deployed settings with the
scope asymmetry the bash documents: allow from `~/.claude/settings.json` alone, deny and ask
from that file plus the project's `.claude/settings.json` and `settings.local.json`.

    claude-guard explain 'git status && timeout 5 ls'      # segments, then the decision and rule

## The hook, live

`~/.claude/hooks/guard-permission-request.sh` runs `claude-guard permission-request` on the
PermissionRequest event and is the sole decision for Bash PermissionRequest: it computes
`judge()`'s verdict and allows, or stays silent and the prompt stands. Cannot run or cannot
parse → it prints nothing and the prompt stands.

The hook is always live and takes no env switch. Slice 3 cut it over from shadow; slice 6
(2026-09-17, narrowed) retired the `CLAUDE_GUARD_SHADOW` switch itself and the shadow
apparatus it fed (`BASH_CHAIN`, `bash_chain_allows`, `claude-guard-shadow.jsonl`,
`shadow-report`'s allow half, `replay --compare-bash` and `replay --judge --compare-hooks`) —
every `BASH_CHAIN` member (`allow-compound-bash.sh`, `allow-readonly-remote.sh`,
`allow-safe-curl.sh`, `allow-safe-rm.sh`, `allow-ansible-readonly.sh`,
`allow-daniel-server.sh`) was already deleted from disk in slice 3, so shadow mode was
computing a verdict it could compare to nothing.

    claude-guard replay commands.jsonl --judge               # allow count and the allowed commands

`commands.jsonl` is one `{"command": ..., "cwd": ...}` object per line
(`cli.py`'s `_replay_judge`/`_replay_deny`). To ask "how many of the prompts I
actually answered this week would this rule set now answer itself" (dotfiles
issue that used to be `prompt-friction`'s job), pull the corpus straight from
Loki and bridge it with one `jq` line — `otelq`'s `tool_decision` rows carry no
`cwd` label, so this fills the field with `$HOME` the same way `prompt-friction`
filled it with its own analysis process's cwd, not the historical session's:

    otelq logs '{service_name="claude-code"} | event_name="tool_decision" | source=~"user.*" | tool_name="Bash"' --stream --since 7d \
      | jq -c '.data.result[] | . as $s | ($s.stream.tool_parameters | fromjson) as $p | range($s.values|length) | {command: $p.full_command, cwd: $ENV.HOME}' \
      > commands.jsonl
    claude-guard replay commands.jsonl --deny
    claude-guard replay commands.jsonl --judge

The slice 3 cutover gate (spec row 3) was `replay --judge --compare-hooks` allowing at least
84 of the prompted corpus — the floor set by what the #477 prototype allowed — checked
against the pre-cutover bash chain before the six hooks were deleted. `replay --judge` alone
still prints that ALLOW tally and remains the load-bearing gate going forward.

## The headless prompt tool

A `claude -p` session opens no permission dialog, so the PermissionRequest hook never runs
there, and every ask ends as "you haven't granted it yet". A PreToolUse `allow` does not
override a settings `ask` rule either (measured 2026-10-24). `claude-guard prompt-server` is
a stdio MCP server whose one tool, `decide`, a headless launch names with
`--permission-prompt-tool`:

    claude -p --mcp-config '{"mcpServers":{"claude-guard":{"command":"claude-guard","args":["prompt-server"]}}}' \
      --permission-prompt-tool mcp__claude-guard__decide ...

`decide` allows exactly what the PermissionRequest hook allows, by calling the same
`hook.decide`, and denies everything else: another tool, a command the judge defers, a
malformed request, any exception. Claude Code consults it for a settings ask rule and for a
hook's ask, and never after a hook's deny. The request carries no working directory, so the
PreToolUse arm records each Bash call's `cwd` and the environment values the judge reads
under `~/.cache/claude-guard/tool-context/<tool_use_id>.json` (mode 0700, records older than
an hour pruned on write). `decide` reads and deletes the record. With no record it judges
with an empty cwd, which every cwd-dependent check refuses.

## The deny rules, live

`claude_guard.deny.deny(command, cwd, env)` is `block-dangerous-bash.sh`'s decision, ported
rule for rule with the bash line ranges cited in each function and the messages verbatim (the
bash is deleted; the line ranges read against `git show 8bbe82d:home/private_dot_claude/hooks/executable_block-dangerous-bash.sh`,
the last commit that carried it). It
returns a `Verdict` whose `kind` is `deny` or `none`; `deny()` never returns `ask` or
`allow` itself. One rule is not the bash's: the bash rewrote a `--force`/`-f` push to a
feature branch into `--force-with-lease` and allowed it, and `force_push_flag` denies it
with the lease spelling in its reason, matching the settings deny rules (dotfiles #701).
It also denies an `f` in a short-option cluster (`-uf`) and a `+<refspec>` push to any
branch (dotfiles #706).

Every push rule also reads past git's global options (dotfiles #709). `claude_guard.gitargv`
is the one reader of git's command line. It finds the subcommand behind `-C`, `-c`,
`--git-dir` and the rest of `git --help`'s global options, behind an assignment prefix or a
wrapper, and behind an inline alias. `deny()` adds a canonical `git push <args>` line per push
to its segment set. For text the parser cannot read, such as `bash -c '…'`, it uses a
`GIT_PUSH_AT` regex built from the same option table. Two rules are new with it.
`push_config` denies a push whose inline config (`-c`, `--config-env`, `GIT_CONFIG_*`) sets a
`+` refspec, a refspec onto main/master, or `remote.<name>.mirror`. `push_no_verify` denies
`--no-verify` or an inline `core.hooksPath` on a push. `config_write` denies the persistent
form: a `git config` write of those keys, of an alias that force-pushes, or `git remote add
--mirror`, each of which makes a later plain `git push` do what no flag on it shows.
`--mirror` and `git send-pack` read as force pushes. `checks/git_conventions.py` reads git through the same module and denies a
commit that skips its hooks. The rules
read three subjects the bash builds: the normalised whole command, that plus one line per
segment and substitution, and the segment lines alone for the pair rules. A parse refusal
degrades to the whole-string subject, as the bash does — this is the one place the
segmenter's "a refusal is never a skip" contract reads differently, and it is deliberate,
because this is a port.

`loader_env` is the one deny rule that reads settings. It refuses a command that changes PATH
or a variable that loads code (PYTHONPATH, LD_PRELOAD, NODE_OPTIONS, BASH_ENV and their kin),
by prefix, `env`, `export`, `declare -x` or a bare assignment, and then runs a command by bare
name that the user-level allow rules grant. Claude Code's own matcher prompts for most of
these forms, but it lets a bare `PYTHONPATH=…;` segment through, and that segment loads code
when PYTHONPATH is already exported. Runners, interpreters and plain builtins are exempt,
because their allow rules already run workspace code or load none. The DECIDED comment above
`_LOADER_NAMES` has the measurements.

    claude-guard explain 'ssh homelab sudo reboot'          # unchanged: segments and the judge
    claude-guard replay commands.jsonl --deny                # one line per non-none verdict

`~/.claude/hooks/guard-pre-tool-use.sh` runs `claude-guard pre-tool-use` on PreToolUse for
every Bash call and is the sole decision for Bash PreToolUse on THIS HOST: it computes
`deny()`'s verdict, merged with the footgun rules and `checks/awk.py`, and denies, asks, or
stays silent. `checks/awk.py` (dotfiles #702) denies an awk program that runs a command
(`system()`, `cmd | getline`, `print | "cmd"`, `|&`) and asks on one it cannot read,
that pipes into a variable, that writes a file (`print > "f"`, dotfiles #707) or whose
text holds a shell `$VAR` the guard sees before expansion; the judge refuses both, so the `awk:*` allow rule cannot
approve them from either hook. Its failure contract is the OPPOSITE
of the PermissionRequest shim's: cannot run → it prints `ask` itself, without Python, the
posture the bash took on a missing `jq`. An exception inside Python prints the same `ask` from
`hook.py`. A `uv python find` or a judge that hangs is cut off by `run_bounded` (2s and 6s,
inside the hook's 10s) and takes the same `ask` (#660). In the sandbox `CLAUDE_GUARD_FAIL_CLOSED=1` turns that `ask` into a `deny` with exit
2, because `--dangerously-skip-permissions` skips an ask (see the shim's header).

`bypass.py` denies a call that sets `dangerouslyDisableSandbox` when the command would run
inside the sandbox unchanged. That means the sandbox is enabled, `judge()` allows the
command, every stage is a `readonly.py` read, nothing needs the network, and no
`denyRead` path is named. The denial tells the model to run it again without the flag. Like
`readonly.py`, it fails open.

`checks/read_only_agents.py` (dotfiles #848) is a deny rule beside the worktree-escape
check. When the payload's `agent_type` names an agent whose frontmatter under
`~/.claude/agents/` sets `read_only: true`, it denies a write redirect outside the scratch
roots, a command that changes files outside them, a shell or `eval`, and any git or gh verb
outside a read-only set. Its module docstring says why the rest is a denylist.

Three rules read text that no command runs, and they skip it only where that is provable.
`rm_root` matches each segment, substitution and heredoc body on its own. It leaves out a
stored heredoc, and a grep, echo or printf whose `rm` is only quoted, unless another segment
runs code. `pipe_to_shell` matches a stage after a pipe at its start, unless the stage runs
code. The sudo boundary skips the word search in a closed-shape Python program that
`inert_python.py` proves starts no process. That module is an allowlist of imports, attributes
and builtins, and it refuses a program naming a shell-startup, settings, hook or PATH file.
A week's replay over 32,188 commands took the deny count from 316 to 262. No command went
from allowed to denied (2026-10-24). The boundary also reads a Python script's own arguments
as data, past a literal `.py` path, so a `findings.py open --title` that names sudo passes.
That took the same replay from 262 to 258 (dotfiles #1000). Several rules then moved from
matching the joined scan to confirming against the parse: gh api's flags come from gh's own
argv, a grep pattern and a sed `s` script are one word, sed and perl -i edit only their file
operands, and a pipe into kill or a shell running a named script is judged at the stage. A
Jinja `secret.yaml.j2` template is not a secrets file. That took the replay from 243 denies
and 15 asks to 208 and 4, with nothing newly refused (2026-10-24).

When nothing above decides, `readonly.py` (dotfiles #628, ported from the server repo's
`auto-approve-readonly.py`) allows a command whose every stage is provably read-only. It
applies only when the session cwd is `$HOME` itself or inside `~/server` or
`~/.local/share/chezmoi`, because git reads a repo's own config and that config can run
code. A failure inside it is no decision, never the `ask` above: it can only remove a prompt.

`waits.py` is the `cc-wait` binding (docs/specs/2026-10-04-cc-wait-design.md). Beside the
rules above it denies a hand-written wait in the foreground: `sleep` of 10s or more, a loop
around `sleep`, `tail -f`, `gh run watch`, `gh pr checks --watch` and `kubectl … --watch`. A
call that runs `cc-wait` on a source gets an `updatedInput` and no decision; `cc-wait
<source> --help` prints usage, so it is left in the foreground. Where a task notification can
wake the session, that is `run_in_background: true`; where one cannot, it is a 600s foreground
timeout. A failure inside the rewrite leaves the call as typed.

The oracle for the rules is `tests/test_deny.py` against
`tests/fixtures/block-dangerous-bash-vectors.json` (32 deny / 27 allow groups, 281 commands),
plus `tests/test_deny_normalization.py`'s generated property corpus. The bash they were ported
from is gone, so there is no second implementation to agree with any more; the agreement
record that cleared the cutover is below.

The cutover gate (spec row 4) was `shadow-report --deny` showing at least 200 records
collected over at least 3 days, with zero `python_only`, `bash_only`, `mismatch`,
`detail_mismatch`, `python_error`, `bash_error` and `bash_timeout` rows, checked against the
host-registered bash before the cutover; measured 11,973 records over 6.6 days at zero across
the board, with `replay --deny --compare-hook` at `AGREE 1058/1058` on the prompted corpus and
`AGREE 281/281` on the vectors. The sandbox port repeated the vector replay inside the
container against the interpreter the image resolves before slice 6 deleted the bash and the
tooling that produced those numbers.

## Tests

From this directory, under uv's managed 3.14, without writing a `.venv` into the source tree:

    PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q

`tests/python-suites.test.js` at the repo root runs the same command as part of `node --test`.
