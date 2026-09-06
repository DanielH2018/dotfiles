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

With `CLAUDE_GUARD_SHADOW=1` (set in `settings.json`'s `env`, and the shim's default) it decides
nothing: it computes its verdict, runs the three bash hooks it will replace on the same stdin,
and appends one line to `~/.claude/logs/claude-guard-shadow.jsonl`:

    {"bash": "allow", "bash_hook": "allow-compound-bash.sh", "cmd_sha": "…16 hex…",
     "python": "allow", "rule": "allow", "ts": "2026-09-06T12:00:00Z"}

The command itself is never written. `CLAUDE_GUARD_SHADOW_SAMPLE=N` samples the log write
1-in-N; it never changes what is decided.

    claude-guard shadow-report                              # agree / python-only / bash-only, and the rules
    claude-guard replay commands.jsonl --judge               # allow count and the allowed commands
    claude-guard replay commands.jsonl --judge --compare-hooks ~/.claude/hooks
                                                            # agreement with the bash chain per record

The exit criterion for this slice is several days of `shadow-report` agreement; the cutover
is slice 3.

## Tests

From this directory, under uv's managed 3.14, without writing a `.venv` into the source tree:

    PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q

`tests/python-suites.test.js` at the repo root runs the same command as part of `node --test`.
