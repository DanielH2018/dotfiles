# claude-guard

One Python package for Claude Code Bash permission decisions. Slice 1 shipped the segmenter
and the CLI; slice 2 shipped the settings loader, the compound judge, the scratch-rm and
safe-curl checks, and the PermissionRequest hook in shadow; slice 3 ported the remaining
PermissionRequest hooks (readonly-remote, daniel-server host trust, ansible-readonly, plus
#474's clean-reset and #477's compound-bash rule changes), adopted the spec's single-segment
judging, and cut the hook over to live — `guard-permission-request.sh` is now the sole
decision for Bash PermissionRequest, and the six bash hooks it replaces are deleted; slice 4
ported the PreToolUse deny rules and cut `guard-pre-tool-use.sh` over to live, unregistering
`block-dangerous-bash.sh` from the host (the file itself stays, frozen, for the sandbox — see
"The deny rules, live" below); slice 6 (2026-09-17, narrowed) retired the allow-side shadow
apparatus that slice 3 left behind (`CLAUDE_GUARD_SHADOW`, `BASH_CHAIN`, `bash_chain_allows`,
`claude-guard-shadow.jsonl`, `shadow-report`'s allow half, `replay --compare-bash` /
`--compare-hooks`) — every `BASH_CHAIN` member was already deleted from disk in slice 3, so
shadow mode was comparing against nothing. `cmdparse.sh`, `block-dangerous-bash.sh` and the
deny-side shadow stay: the sandbox still bind-mounts and runs `block-dangerous-bash.sh` as its
own in-container deny hook and cannot yet run the Python port (see "Sandbox port" in the spec).
Spec: `docs/specs/2026-09-06-claude-guard-design.md` (dotfiles repo).

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
every Bash call and is the sole decision for Bash PreToolUse on THIS HOST: it computes
`deny()`'s verdict and denies, upgrades, or stays silent. Its failure contract is the OPPOSITE
of the PermissionRequest shim's: cannot run → it prints `ask` itself, without Python, the
posture the bash takes on a missing `jq`. An exception inside Python in live mode prints the
same `ask` from `hook.py`.

**`block-dangerous-bash.sh` itself is not deleted** — see its own header comment and
`docs/plans/2026-09-17-claude-guard-slice-4-cutover.md`. It is unregistered from PreToolUse on
the host (this cutover) but stays deployed, frozen, and sourcing `cmdparse.sh`, because the
sandbox (`home/private_dot_claude/sandbox/`) bind-mounts and registers this exact deployed copy
as its own in-container deny hook and cannot yet run the Python port. `--compare-hook` above
still runs against it for that reason; the M02 shadow census inside it
(`_bdb_shadow_log`/`CMDPARSE_SHADOW`) is still real and still tested
(`tests/hooks/cmdparse-shadow.test.js`), because the hook still runs — in the sandbox.

The host hook goes live when `CLAUDE_GUARD_DENY_SHADOW` is exactly `"0"` — `settings.json`'s
`env` sets it, and the shim's own default matches, so a stale `settings.json` that lost the key
fails toward live rather than toward a shadow mode whose bash comparison no longer runs on the
host (see `guard-pre-tool-use.sh`'s own comment for why that direction is the safe one
post-cutover; it was a separate switch from the allow side's, now retired, so the two sides
cut over independently). Any other value still computes the verdict, runs the deployed
`block-dangerous-bash.sh` on the same stdin (with the M02 census switches removed, so that
re-run cannot double-count), and appends one line to
`~/.claude/logs/claude-guard-deny-shadow.jsonl`:

    {"bash": "deny", "cmd_sha": "…16 hex…", "python": "deny", "rule": "rm-root",
     "ts": "2026-09-06T12:00:00Z"}

`python` is `deny` | `ask` | `allow` | `none` | `error`; `bash` is the same set, where `error`
means the bash could not be run or read — never folded into `none`, so a missing hook is not
agreement. `rule` is a fixed literal (`exception` for an error), never text from the command.

    claude-guard shadow-report               # deny-side only; historical: the pre-cutover
                                              # agreement record

The cutover gate (spec row 4) was `shadow-report --deny` (the flag has since been dropped --
`shadow-report` is deny-only now that slice 6 retired the allow side's log and report half)
showing at least 200 records collected over at least 3 days, with zero `python_only`, `bash_only`, `mismatch`,
`detail_mismatch`, `python_error`, `bash_error` and `bash_timeout` rows, checked against the
host-registered bash before this cutover; measured 11,973 records over 6.6 days at zero across
the board. `bash_timeout` rows were expected on large heredocs — the bash is quadratic there
and exceeds the 5s re-run cap — and would not have blocked; no longer relevant to the host gate
now that no host-side shadow comparison runs by default, but the underlying cost is unchanged
for the sandbox's own use of the hook.

## Tests

From this directory, under uv's managed 3.14, without writing a `.venv` into the source tree:

    PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q

`tests/python-suites.test.js` at the repo root runs the same command as part of `node --test`.
