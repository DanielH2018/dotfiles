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

## Running

    claude-guard explain 'git status && ls & rm -rf /'
    printf '%s' 'ls; pwd' | claude-guard segment --json

## The judge

`claude_guard.judge.judge(command, rules, roots, cwd)` is `allow-compound-bash.sh`'s decision,
ported line for line, plus the standalone PermissionRequest hooks it never delegated to (the
four whole-command checks below) and the spec's "a single segment is judged like a chain"
decision: a bare command reaches the same checks a chained one does rather than returning
`not-compound`. It allows a chain when every segment is allow-listed or passes a check
(`checks/scratch.py` for a confined `rm`, `checks/curl.py` for a plain GET/HEAD against an
allowlisted host, the `git merge --ff-only <ref>` exception), and no segment matches deny or
ask, or when the whole command passes one of `checks/remote.py`'s `readonly_remote_safe()` /
`trusted_host_safe()`, `checks/ansible.py`'s `ansible_readonly_safe()`, or
`checks/git_reset.py`'s `clean_reset_safe()`. The two remote checks also run per segment,
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

The slice 3 cutover gate (spec row 3) was `replay --judge --compare-hooks` allowing at least
84 of the prompted corpus — the floor set by what the #477 prototype allowed — checked
against the pre-cutover bash chain before the six hooks were deleted. `replay --judge` alone
still prints that ALLOW tally and remains the load-bearing gate going forward.

## The deny rules, live

`claude_guard.deny.deny(command, cwd, env)` is `block-dangerous-bash.sh`'s decision, ported
rule for rule with the bash line ranges cited in each function and the messages verbatim (the
bash is deleted; the line ranges read against `git show 8bbe82d:home/private_dot_claude/hooks/executable_block-dangerous-bash.sh`,
the last commit that carried it). It
returns a `Verdict` whose `kind` is `deny`, `allow` (the `--force` → `--force-with-lease`
upgrade, with `updated_command`), or `none`; `deny()` never returns `ask` itself. The rules
read three subjects the bash builds: the normalised whole command, that plus one line per
segment and substitution, and the segment lines alone for the pair rules. A parse refusal
degrades to the whole-string subject, as the bash does — this is the one place the
segmenter's "a refusal is never a skip" contract reads differently, and it is deliberate,
because this is a port.

    claude-guard explain 'ssh homelab sudo reboot'          # unchanged: segments and the judge
    claude-guard replay commands.jsonl --deny                # one line per non-none verdict

`~/.claude/hooks/guard-pre-tool-use.sh` runs `claude-guard pre-tool-use` on PreToolUse for
every Bash call and is the sole decision for Bash PreToolUse on THIS HOST: it computes
`deny()`'s verdict and denies, upgrades, or stays silent. Its failure contract is the OPPOSITE
of the PermissionRequest shim's: cannot run → it prints `ask` itself, without Python, the
posture the bash took on a missing `jq`. An exception inside Python prints the same `ask` from
`hook.py`. In the sandbox `CLAUDE_GUARD_FAIL_CLOSED=1` turns that `ask` into a `deny` with exit
2, because `--dangerously-skip-permissions` skips an ask (see the shim's header).

When nothing above decides, `readonly.py` (dotfiles #628, ported from the server repo's
`auto-approve-readonly.py`) allows a command whose every stage is provably read-only. It
applies only when the session cwd is `$HOME` itself or inside `~/server` or
`~/.local/share/chezmoi`, because git reads a repo's own config and that config can run
code. A failure inside it is no decision, never the `ask` above: it can only remove a prompt.

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
