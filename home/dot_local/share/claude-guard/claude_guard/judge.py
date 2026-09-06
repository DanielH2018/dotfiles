"""The compound decision, ported from allow-compound-bash.sh as it decides TODAY.

A chain is allowed when every segment is allow-listed or passes a check, and no segment
matches deny or ask. Everything that makes the bash defer makes this defer, in the same
order, with the bash line cited beside it. This is a PORT: the #477 rules (a newline as
`;`, a quoted-heredoc write, `set -e`/`VAR=`/`timeout` stripping) and the spec's "a single
segment is judged like a chain" are slice 3. Today a command containing none of `&&`, `;`,
`|` gets no decision at all (:51-59), and this module keeps that.
"""

import re
from dataclasses import dataclass

from claude_guard.checks.curl import curl_safe
from claude_guard.checks.scratch import rm_confined
from claude_guard.rules import Rules
from claude_guard.segment import parse

# :191. Wrapper commands take another command as an ARGUMENT and exec it.
WRAPPERS = frozenset({"timeout", "env", "nice", "nohup", "setsid", "stdbuf", "xargs"})

_DEVNULL_REDIRECT = re.compile(r"[0-9]*>>?\s*/dev/null")
_FD_DUP = re.compile(r"[0-9]*>&[0-9-]")
_OPTION_WORD = re.compile(r"\s+-\S+")
_DEVNULL_WORD = re.compile(r"\s+/dev/null")


@dataclass(frozen=True, slots=True)
class Decision:
    allow: bool
    rule: str
    reasons: tuple[str, ...]


def _trim(s: str) -> str:
    """:137-142. Spaces and tabs only."""
    return s.strip(" \t")


def _first_word(s: str) -> str:
    """`${s%%[[:space:]]*}`: everything before the first whitespace character."""
    return re.split(r"\s", s, maxsplit=1)[0]


def _basename(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def unwrap_wrapper(segment: str) -> str | None:
    """:181-270. Resolve a segment to the command that will actually execute.

    A segment that is not a wrapper comes back unchanged. None means the argument shape
    could not be read with confidence; the caller MUST defer, never fall back to the
    wrapper's own allow entry. The flag tables are closed: an unknown option is a refusal.
    """
    s = segment
    depth = 0
    while depth < 4:  # `timeout 5 nohup nice cmd` nests; a bound stops a cycle
        depth += 1
        # bash `read -a` (the wrapper's tokenizer) reads only the first line of the
        # segment; Python's split() also splits on an embedded newline and other Unicode
        # whitespace, so this port can see MORE tokens than the bash for the same input.
        # Extra tokens can only trip a stricter branch (an unrecognised flag, a missing
        # positional) and land on `return None` (defer), never add an allow the bash
        # wouldn't also give — so the port is never more permissive than the bash it mirrors.
        t = s.split()
        n = len(t)
        if n == 0:
            return None
        w = _basename(t[0])
        if w not in WRAPPERS:
            return s
        i = 1
        if w in ("nohup", "setsid"):
            pass
        elif w == "nice":
            while i < n:
                tok = t[i]
                if tok == "-n":
                    i += 2
                    continue
                numeric = len(tok) > 1 and tok[0] == "-" and tok[1].isdigit()
                if numeric or tok.startswith("--adjustment="):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None
                break
        elif w == "timeout":
            while i < n:
                tok = t[i]
                if tok in ("--preserve-status", "--foreground", "-v", "--verbose"):
                    i += 1
                    continue
                if tok in ("-s", "-k"):
                    i += 2
                    continue
                if tok.startswith("--signal=") or tok.startswith("--kill-after="):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None
                break
            # :218-224. The duration is positional and mandatory.
            if i >= n or not t[i][:1].isdigit():
                return None
            i += 1
        elif w == "env":
            # :225-235. Only the plain `env VAR=VALUE... cmd` shape; every option refused.
            while i < n:
                tok = t[i]
                if tok.startswith("-"):
                    return None
                if "=" in tok:
                    i += 1
                    continue
                break
        elif w == "stdbuf":
            while i < n:
                tok = t[i]
                if (len(tok) > 2 and tok[0] == "-" and tok[1] in "ioe") or tok.startswith(
                    ("--input=", "--output=", "--error=")
                ):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None  # includes the separated `-o L` form
                break
        elif w == "xargs":
            while i < n:
                tok = t[i]
                if tok in (
                    "-0",
                    "-r",
                    "-t",
                    "-x",
                    "-p",
                    "--null",
                    "--no-run-if-empty",
                    "--verbose",
                    "--interactive",
                ):
                    i += 1
                    continue
                if tok in ("-n", "-I", "-P", "-d", "-a", "-L", "-s", "-E"):
                    i += 2
                    continue
                if len(tok) > 2 and tok[0] == "-" and tok[1] in "nIPdaLsE":
                    i += 1
                    continue
                if tok.startswith(
                    (
                        "--max-args=",
                        "--replace=",
                        "--max-procs=",
                        "--delimiter=",
                        "--arg-file=",
                        "--max-lines=",
                        "--max-chars=",
                        "--eof=",
                    )
                ):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None  # -e and -l carry OPTIONAL arguments; arity is unknowable
                break
            if i >= n:
                return None  # bare xargs runs echo; there is no command word to judge
        if i >= n:
            return None
        # :262-266. Word splitting above is naive, so a quote among the consumed tokens
        # means the real boundaries are not where they appear. Refuse rather than guess.
        if any("'" in tok or '"' in tok for tok in t[:i]):
            return None
        s = " ".join(t[i:])
    return None


def judge_segment(part: str, rules: Rules, roots: tuple[str, ...]) -> tuple[bool, str]:
    """:286-395, one iteration of the loop. (ok, reason)."""
    # :293-300. Redirection turns an allow-listed reader into a writer. /dev/null and fd
    # dups are the harmless cases and are everywhere in diagnostics.
    redir = _FD_DUP.sub("", _DEVNULL_REDIRECT.sub("", part))
    if ">" in redir:
        return False, "redirect"

    # :302-313. tee writes every path it is handed. Judge the command WORD, not a glob
    # over the segment: `tee /usr/bin/tee` must not look harmless.
    teed = _DEVNULL_WORD.sub("", _OPTION_WORD.sub("", part))
    teecmd = _first_word(teed)
    if _basename(teecmd) == "tee" and teed != teecmd:
        return False, "tee"

    # :315-319. Deny → defer. No exception below reaches past this.
    if rules.denies(part):
        return False, "deny"

    # :321-341. The one ask-listed segment named as safe here: `git merge --ff-only <ref>`
    # with exactly one ref that does not look like an option, read off the
    # redirect-stripped form because nearly every real call carries `2>&1`.
    if part.startswith("git merge --ff-only "):
        ffref = _trim(redir.removeprefix("git merge --ff-only "))
        if ffref and not ffref.startswith("-") and not re.search(r"\s", ffref):
            return True, "ff-only"

    # :343-357. A provably-safe curl or a confined rm resolves its own ask rule. After
    # deny, before ask: where the standalone hooks sit relative to this one.
    word = _basename(_first_word(part))
    if word == "curl" and curl_safe(part):
        return True, "curl-check"
    if word == "rm" and rm_confined(part, roots):
        return True, "rm-check"

    # :359-363.
    if rules.asks(part):
        return False, "ask"

    # :365-372. Honour the allow list as written before unwrapping, or a narrowed rule
    # such as `/usr/bin/env bash --version` becomes unreachable.
    if rules.allows(part):
        return True, "allow-list"

    # :374-378.
    target = unwrap_wrapper(part)
    if target is None:
        return False, "wrapper-unreadable"
    if target == part:
        return False, "unlisted"

    # :380-387. The unwrapped command earns the same deny/ask scrutiny.
    if rules.denies(target) or rules.asks(target):
        return False, "wrapper-target-deny-or-ask"
    if not rules.allows(target):
        return False, "wrapper-target-unlisted"
    return True, f"wrapper:{target}"


def judge(command: str, rules: Rules, roots: tuple[str, ...]) -> Decision:
    # :51-59. Only a compound command is eligible: a literal substring test, deliberately.
    if "&&" not in command and ";" not in command and "|" not in command:
        return Decision(False, "not-compound", ())

    # :277-281.
    if rules.whole_glob_defer(command):
        return Decision(False, "whole-glob", ())

    # :402-403. The segmenter's refusal is a refusal, never a skip.
    parsed = parse(command)
    if not parsed.ok:
        return Decision(False, parsed.status, ())

    # :404-428. Two things stay conservative on purpose: a substitution's content is an
    # opaque atom this judge cannot vet, and a heredoc body is never scanned for one; a
    # bare `&` or a newline separator never reached judge() under the old splitter.
    if parsed.substitutions:
        return Decision(False, "unjudgeable:substitution", ())
    last = len(parsed.segments) - 1
    for i, seg in enumerate(parsed.segments):
        if any(seg.heredocs):
            return Decision(False, "unjudgeable:heredoc", ())
        if i < last and seg.sep in ("&", "newline"):
            return Decision(False, "unjudgeable:separator", ())

    reasons: list[str] = []
    for i, seg in enumerate(parsed.segments):
        part = _trim(seg.text)
        if not part:
            continue
        ok, reason = judge_segment(part, rules, roots)
        reasons.append(reason)
        if not ok:
            return Decision(False, f"segment:{i}:{reason}", tuple(reasons))
    return Decision(True, "allow", tuple(reasons))
