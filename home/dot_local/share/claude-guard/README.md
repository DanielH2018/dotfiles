# claude-guard

One Python package for Claude Code Bash permission decisions. Slice 1 shipped the segmenter
and the CLI; slice 2 ships the settings loader, the compound judge, the scratch-rm and safe-curl
checks, and the PermissionRequest hook in shadow. The deny rules and the cutover are later
slices of the spec in `docs/specs/2026-09-06-claude-guard-design.md` (dotfiles repo).

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

`claude_guard.judge.judge(command, rules, roots)` is `allow-compound-bash.sh`'s decision,
ported line for line. It allows a chain when every segment is allow-listed or passes a check
(`checks/scratch.py` for a confined `rm`, `checks/curl.py` for a plain GET/HEAD against an
allowlisted host, the `git merge --ff-only <ref>` exception) and no segment matches deny or
ask. A command containing none of `&&`, `;`, `|` gets no decision, as today. `rules.py` reads
the deployed settings with the scope asymmetry the bash documents: allow from
`~/.claude/settings.json` alone, deny and ask from that file plus the project's
`.claude/settings.json` and `settings.local.json`.

    claude-guard explain 'git status && timeout 5 ls'      # segments, then the decision and rule

## The hook, and shadow mode

`~/.claude/hooks/guard-permission-request.sh` runs `claude-guard permission-request` on the
PermissionRequest event. Cannot run or cannot parse → it prints nothing and the prompt stands.

The hook runs in shadow unless `CLAUDE_GUARD_SHADOW` is set to exactly `"0"` (`settings.json`'s
`env` sets it to `1`, and the shim also defaults it to `1`, so absent, misspelled, or any
other truthy-looking value all stay in shadow — only an exact `"0"` goes live). In shadow it
decides nothing: it computes its verdict, runs the three bash hooks it will replace on the
same stdin, and appends one line to `~/.claude/logs/claude-guard-shadow.jsonl`:

    {"bash": "allow", "bash_hook": "allow-compound-bash.sh", "cmd_sha": "…16 hex…",
     "python": "allow", "rule": "allow", "ts": "2026-09-06T12:00:00Z"}

An exception raised while computing the verdict still leaves a record rather than vanishing:
`"python": "error", "rule": "exception"`, never the exception text. The command itself is
never written. `CLAUDE_GUARD_SHADOW_SAMPLE=N` samples the log write 1-in-N; it never changes
what is decided.

    claude-guard shadow-report                              # agree / python-only / bash-only / python-error, and the rules
    claude-guard replay commands.jsonl --judge               # allow count and the allowed commands
    claude-guard replay commands.jsonl --judge --compare-hooks ~/.claude/hooks
                                                            # agreement with the bash chain per record

The cutover to slice 3 needs `shadow-report` to show at least 200 records collected over at
least 3 days, with zero `python_only`, zero `bash_only`, and zero `python_error` rows. An
empty log satisfies none of this — no records is not the same claim as agreement.

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
