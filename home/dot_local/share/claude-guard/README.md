# claude-guard

One Python package for Claude Code Bash permission decisions. Slice 1 shipped the segmenter
and the CLI; slice 2 shipped the settings loader, the compound judge, the scratch-rm and
safe-curl checks, and the PermissionRequest hook in shadow; slice 3 ported the remaining
PermissionRequest hooks (readonly-remote, daniel-server host trust, ansible-readonly, plus
#474's clean-reset and #477's compound-bash rule changes), adopted the spec's single-segment
judging, and cut the hook over to live — `guard-permission-request.sh` is now the sole
decision for Bash PermissionRequest, and the six bash hooks it replaces are deleted. The deny
rules and their own cutover are slice 4 of the spec in
`docs/specs/2026-09-06-claude-guard-design.md` (dotfiles repo).

## The segmenter's contract

`claude_guard.segment.parse(command)` returns a `Parsed` whose `status` is `ok` or
`unreadable:<reason>`. **A non-ok status is a refusal, never a skip.** A caller must defer
(PermissionRequest) or ask (PreToolUse); it must never read it as "nothing to worry about".

On `ok`: `segments` are the top-level commands in order, each with the separator that
terminated it (`&&` `||` `;` `|` `&` `newline` `eof`), its lifted heredoc bodies, and whether
each heredoc delimiter was quoted. `substitutions` holds the content of every `$( )`,
`` ` ` ``, `<( )` and `>( )`, flattened across nesting. This is a port of `cmdparse.sh`'s
awk pass and agrees with it field for field (`tests/test_vectors.py`), except that the bash
`heredoc` field cannot represent an empty body; `_comparable` in `cli.py` drops empty bodies
on both sides.

## Running

    claude-guard explain 'git status && ls & rm -rf /'
    claude-guard replay commands.jsonl --compare-bash ~/.claude/hooks/cmdparse.sh
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
`checks/git_reset.py`'s `clean_reset_safe()`. `rules.py` reads the deployed settings with the
scope asymmetry the bash documents: allow from `~/.claude/settings.json` alone, deny and ask
from that file plus the project's `.claude/settings.json` and `settings.local.json`.

    claude-guard explain 'git status && timeout 5 ls'      # segments, then the decision and rule

## The hook, live

`~/.claude/hooks/guard-permission-request.sh` runs `claude-guard permission-request` on the
PermissionRequest event and is the sole decision for Bash PermissionRequest: it computes
`judge()`'s verdict and allows, or stays silent and the prompt stands. Cannot run or cannot
parse → it prints nothing and the prompt stands, the same failure contract it had in shadow.

The hook goes live when `CLAUDE_GUARD_SHADOW` is exactly `"0"` — `settings.json`'s `env` sets
it, and the shim's own default matches, so a stale `settings.json` that lost the key fails
toward live rather than toward a shadow mode whose bash chain no longer exists to compare
against (see `guard-permission-request.sh`'s own comment for why that direction is the safe
one post-cutover). Any other value still computes the verdict and would log it to
`~/.claude/logs/claude-guard-shadow.jsonl` for comparison against a bash chain, but the six
bash hooks it shadowed (`allow-compound-bash.sh`, `allow-readonly-remote.sh`,
`allow-safe-curl.sh`, `allow-safe-rm.sh`, `allow-ansible-readonly.sh`,
`allow-daniel-server.sh`) are deleted, so that comparison has nothing left to run.

    claude-guard shadow-report                              # historical: the pre-cutover agreement record
    claude-guard replay commands.jsonl --judge               # allow count and the allowed commands
    claude-guard replay commands.jsonl --judge --compare-hooks ~/.claude/hooks
                                                            # agreement with whatever bash hooks remain in the dir

The cutover gate (spec row 3) was `replay --judge --compare-hooks` allowing at least 84 of the
prompted corpus — the floor set by what the #477 prototype allowed — checked against the
pre-cutover bash chain before the six hooks were deleted.

## The deny rules, and their own shadow

`claude_guard.deny.deny(command, cwd, env)` is `block-dangerous-bash.sh`'s decision, ported
rule for rule with the bash line ranges cited in each function and the messages verbatim. It
returns a `Verdict` whose `kind` is `deny`, `allow` (the `--force` → `--force-with-lease`
upgrade, with `updated_command`), or `none`; `deny()` never returns `ask` itself. The rules
read three subjects the bash builds: the normalised whole command, that plus one line per
segment and substitution, and the segment lines alone for the pair rules. A parse refusal
degrades to the whole-string subject, as the bash does — this is the one place the
segmenter's "a refusal is never a skip" contract reads differently, and it is deliberate,
because this is a port.

    claude-guard explain 'ssh homelab sudo reboot'          # unchanged: segments and the judge
    claude-guard replay commands.jsonl --deny                # one line per non-none verdict
    claude-guard replay commands.jsonl --deny --compare-hook ~/.claude/hooks/block-dangerous-bash.sh
                                                            # AGREE n/N, verdict AND message

`~/.claude/hooks/guard-pre-tool-use.sh` runs `claude-guard pre-tool-use` on PreToolUse for
every Bash call. Its failure contract is the OPPOSITE of the PermissionRequest shim's: cannot
run → it prints `ask` itself, without Python, the posture the bash takes on a missing `jq`.
An exception inside Python in live mode prints the same `ask` from `hook.py`.

The deny side runs in shadow unless `CLAUDE_GUARD_DENY_SHADOW` is exactly `"0"` — a separate
switch from `CLAUDE_GUARD_SHADOW`, so the two sides cut over independently. In shadow it
computes its verdict, runs the deployed `block-dangerous-bash.sh` on the same stdin (with the
M02 census switches removed, so that re-run cannot double-count), and appends one line to
`~/.claude/logs/claude-guard-deny-shadow.jsonl`:

    {"bash": "deny", "cmd_sha": "…16 hex…", "python": "deny", "rule": "rm-root",
     "ts": "2026-09-06T12:00:00Z"}

`python` is `deny` | `ask` | `allow` | `none` | `error`; `bash` is the same set, where `error`
means the bash could not be run or read — never folded into `none`, so a missing hook is not
agreement. `rule` is a fixed literal (`exception` for an error), never text from the command.

    claude-guard shadow-report --deny        # agree (deny/ask/none/allow), python-only,
                                             # bash-only, mismatch, python-error, bash-error

The cutover needs `shadow-report --deny` to show at least 200 records collected over at least
3 days, with zero `python_only`, `bash_only`, `mismatch`, `detail_mismatch`, `python_error`
and `bash_error` rows. An empty log satisfies none of this. `bash_timeout` rows are expected
on large heredocs — the bash hook is quadratic there and exceeds the 5s re-run cap — and do
not block, but each is a command the bash could not judge in time, and is the subject of a
follow-up against the bash.

## Tests

From this directory, under uv's managed 3.14, without writing a `.venv` into the source tree:

    PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q

`tests/python-suites.test.js` at the repo root runs the same command as part of `node --test`.
