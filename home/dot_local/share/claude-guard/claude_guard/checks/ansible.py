"""A hand-run `ansible-playbook` invocation that is provably read-only.
allow-ansible-readonly.sh ported.

The option table is an ALLOWLIST, same posture as allow-safe-rm.sh: a flag this module does
not recognize decides nothing. Read-only-ness is not "no dangerous flag was seen" — it is
"one of the five modes ansible itself treats as read-only was named", checked as a whole
token, never as a substring of the command text (:20-27).

`--check` only means "make no changes" when nothing it evaluates comes from outside the
command line. `-e @file.yml` / `--extra-vars @file.yml` loads that file's content as vars,
and this check cannot see what is in it, so a file-valued (`@...`) extra-vars anywhere in
the command refuses the whole thing, even alongside --check (:29-33).

Two invocation shapes this check must also see through, stripped by exact pattern before
tokenizing so neither smuggles in extra shell structure: an optional leading
`stdio-blocking; ` and an optional trailing `2>&1 | tail -n <N>` / `tail -<N>` (:37-43).
"""

import re

from claude_guard.checks.scratch import tokenize

# K3 (task-8-fix-4-brief.md): the SAME constant as `judge.WS`, restated here rather than
# imported — `judge.py` imports THIS module (`ansible_readonly_safe`) at module level, so
# an import the other way would be circular. Kept in sync by hand; the value (bash's IFS
# word boundary, space and tab — never Python's wider `\s`) is what matters and is
# exercised identically by `tests/test_ansible.py`, so a drift between the two literals
# would show up there before it could hide the way the J1/J2 marker in judge.py warns a
# genuinely independent regex pair can.
_WS = " \t"

# :57-59. A literal prefix, matched on the RAW string before tokenizing. If it doesn't match
# verbatim, the string is left untouched and the tokenizer below refuses whatever remains —
# this is NOT a recognised leading token, so `stdio-blocking ;` (a space before the
# semicolon) is a different string that never matches and dies on the bare `;` instead.
# K3: `[{_WS}]*`, not `\s*` — the run of IFS whitespace bash allows between the literal
# `;` and the next word. Whether this one actually MATTERS is a closer call than the rest
# of the sweep: `(.*)$` runs with `re.DOTALL`, so it captures the ENTIRE remainder of the
# string regardless of how many leading whitespace bytes `[{_WS}]*` consumes — nothing
# past this prefix is ever discarded the way a `_HEREDOC_CAT_WRITE`-style strip discards
# what it does not capture. Tightened anyway, for the same reason `_first_word`'s
# docstring gives for going the other way: leaving one instance of the old, wider class
# beside every other instance in this file that now reads narrower invites a future sweep
# to "fix" it without checking whether it was already deliberate.
_LEADING = re.compile(rf"^stdio-blocking;[{_WS}]*(.*)$", re.DOTALL)

# :60-62. Anchored at the end of the string, immediately after `2>&1`: `tail -n 50`,
# `tail -n50` and a bare `tail -3` are the only three shapes accepted.
# K3: every `\s` here modeled a real bash word boundary in the `... 2>&1 | tail -n <N>`
# idiom, so all of them read off `_WS` now, `\S` included (`[^{_WS}]`, the complement).
# This is the one K3 replacement gate-tested in isolation rather than folded into the
# rest of the sweep: it sits on the path of a named production shape
# (`git merge --ff-only <ref> 2>&1 | tail -3`, `tests/test_judge.py`'s own ff-only case)
# and of `ansible-playbook ... --check 2>&1 | tail -n 50`-style rows in the replay
# corpus — narrowing it wrongly would cost a live row, not just a synthetic one.
# Measured floor-neutral (`ALLOW 84/1058`, unchanged) after this exact replacement.
_TRAILING = re.compile(
    rf"^(.*[^{_WS}])[{_WS}]*2>&1[{_WS}]*\|[{_WS}]*tail[{_WS}]+-(?:n[{_WS}]*)?[0-9]+[{_WS}]*$",
    re.DOTALL,
)

# :66. Read-only ansible modes. Anything else, or nothing from this table, is not a
# decision this check can make.
READONLY: frozenset[str] = frozenset(
    {"--check", "--list-tasks", "--list-tags", "--list-hosts", "--syntax-check"}
)


def _head_index(tokens: list[str]) -> int | None:
    """:123-138. Positional head recognition, run BEFORE any flag scanning: nothing may
    precede `ansible-playbook`, `uv run ansible-playbook`, or `uv run --frozen
    ansible-playbook`. Returns the index of the first token past the recognized head, or
    None when the head is not one of these three (an unrecognised head refuses immediately,
    even one carrying a read-only flag — otherwise `helm ansible-playbook.sh --check` could
    falsely allow)."""
    if tokens[0].rsplit("/", 1)[-1] == "ansible-playbook":
        return 1
    if tokens[0] == "uv" and len(tokens) > 1 and tokens[1] == "run":
        if len(tokens) > 2 and tokens[2].rsplit("/", 1)[-1] == "ansible-playbook":
            return 3
        if (
            len(tokens) > 3
            and tokens[2] == "--frozen"
            and tokens[3].rsplit("/", 1)[-1] == "ansible-playbook"
        ):
            return 4
        return None
    return None


def ansible_readonly_safe(command: str) -> bool:
    """:53-172. True only when `command` is a recognized ansible-playbook invocation naming
    at least one read-only mode, with no file-valued `-e`/`--extra-vars`.

    False is "no opinion" everywhere else — a parse refusal (a shell-special character
    outside quotes, an unterminated quote), an unrecognised head, or no read-only mode named
    are all the same fall-through as the bash's unconditional `exit 0` (:171-172).
    """
    if not command:
        return False

    # :53-62. The two exact-pattern strips run on the RAW string, before tokenizing.
    core = command
    leading = _LEADING.match(core)
    if leading:
        core = leading.group(1)
    trailing = _TRAILING.match(core)
    if trailing:
        core = trailing.group(1)

    # :68-113. Same posture as allow-safe-rm.sh's tokenizer: any shell-special character
    # outside quotes is a refusal, so chaining, piping, redirection, substitution and globs
    # are read the same way the shell would read them.
    tokens = tokenize(core)
    if not tokens:
        return False

    idx = _head_index(tokens)
    if idx is None:
        return False

    saw_readonly = False
    i = idx
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        i += 1

        # :146-162. The value of -e/--extra-vars is opaque: never scanned for a read-only
        # flag, only ever checked for the one thing that disqualifies it (a file
        # reference). The value token is skipped entirely from the scan below, not merely
        # ignored.
        if tok in ("-e", "--extra-vars"):
            val = tokens[i] if i < n else ""
            i += 1
            if val.startswith("@"):
                return False
            continue
        if tok.startswith("--extra-vars="):
            if tok.removeprefix("--extra-vars=").startswith("@"):
                return False
            continue
        # :158-162. Attached short form, e.g. -e@vars.yml or -eKEY=VAL, with no space or
        # '='. Distinguished from --extra-vars=... by not starting with `--`.
        if tok.startswith("-e") and len(tok) > 2 and not tok.startswith("--"):
            if tok[2:].startswith("@"):
                return False
            continue

        if tok in READONLY:
            saw_readonly = True

    return saw_readonly
