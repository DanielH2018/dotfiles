"""Commands that fail silently: a plausible wrong answer, never an error.

Four rules ported from the server repo's `.claude/hooks/block-footguns.py` (dotfiles
#628). They key on a host tool or on GitHub rather than on that repo, so they belong in the
guard every repo runs. The server keeps its five repo-specific rules. What the four share
is that none of them errors, so nothing downstream notices:

  1. `grep -Z` / `grep -z` where grep is ugrep. There `-Z` is `--fuzzy` and `-z` is
     `--decompress`, not GNU's NUL separator and `--null-data`, so `grep -lZ ... | xargs -0`
     fuzzy-matches and emits newline-separated names. One such sweep rewrote part of the
     server tree and left 49 stale paths behind. The rule asks `grep --version` first: on
     GNU or BSD grep the flags mean what the writer thinks.
  2. `git stash pop` / `apply` with no ref. The stash stack is per-repository, not
     per-worktree, so a bare pop takes whatever another session pushed last.
  3. `pgrep -f <pattern>`. The shell running the check carries the pattern in its own
     cmdline, so the waiter matches itself and reads as "still running" forever.
  4. A partial `security_and_analysis` PATCH. GitHub replaces the object, so every member
     left out is reset, and the call returns 200 either way.

`footgun()` returns a deny naming the fix, or None.

DECIDED: a command the segmenter or shlex cannot read gets NO decision here, where the
server's copy asked. These rules flag quiet mistakes, they do not guard anything dangerous:
`deny()` still judges the whole string of an unreadable command. And an ask spread to
every repo would fire on each `gh pr create` whose heredoc body holds an odd quote
(dotfiles #614's vector), which is most of what these binaries appear in.
"""

import functools
import shlex
import subprocess

from claude_guard.deny import Verdict
from claude_guard.segment import parse

_UGREP_FLAG_FIXES = {
    "Z": "-Z is --fuzzy here (approximate matching), not a NUL separator. Use --null (-0).",
    "z": "-z is --decompress here, not --null-data. Use --null-data.",
}

# Every member of GitHub's `security_and_analysis` object. A PATCH REPLACES the object, so
# any member left out is reset rather than preserved; naming all five is the only safe
# partial edit.
_SECURITY_ANALYSIS_MEMBERS = (
    "advanced_security",
    "secret_scanning",
    "secret_scanning_push_protection",
    "dependabot_security_updates",
    "secret_scanning_validity_checks",
)

# Words that can precede the real binary in a stage: `until ! pgrep -f x; do ...` opens
# with `until` and `!`, and a rule testing the first word would never see the pgrep.
_LEADING_KEYWORDS = frozenset(
    {"!", "until", "while", "if", "elif", "then", "do", "time", "command"}
)


def _stages(command: str) -> list[list[str]] | None:
    """Every pipeline/sequence stage of `command` as shlex words, or None when unreadable.

    None covers a segmenter refusal and a segment shlex cannot tokenise; the module
    docstring's DECIDED says why that is no decision rather than an ask.
    """
    parsed = parse(command)
    if not parsed.ok:
        return None
    stages = []
    for segment in parsed.segments:
        try:
            words = shlex.split(segment.text)
        except ValueError:
            return None
        i = 0
        while i < len(words) and words[i] in _LEADING_KEYWORDS:
            i += 1
        if words[i:]:
            stages.append(words[i:])
    return stages


def _invokes(stage: list[str], prefix: tuple[str, ...]) -> bool:
    """True when `stage` runs `prefix`, allowing global flags before the subcommand.

    The subcommand words match as an adjacent run anywhere after the binary, so
    `gh --repo o/r api` still reads as `gh api` without dropping a flag's value.
    """
    if not stage or stage[0] != prefix[0]:
        return False
    words, rest = list(prefix[1:]), stage[1:]
    if not words:
        return True
    return any(rest[i : i + len(words)] == words for i in range(len(rest)))


def _short_flags(stage: list[str]) -> set[str]:
    """Every single-letter flag in `stage`, unbundled: `-lZ` is `-l` and `-Z`."""
    letters: set[str] = set()
    for word in stage:
        if word.startswith("-") and not word.startswith("--") and len(word) > 1:
            letters.update(word[1:])
    return letters


@functools.cache
def _grep_is_ugrep() -> bool:
    """Is `grep` on this host ugrep? Any failure to tell reads as no.

    Asked at most once per process, and only for a grep carrying `-Z` or `-z`, so an
    ordinary command pays nothing.
    """
    try:
        out = subprocess.run(
            ["grep", "--version"], capture_output=True, text=True, timeout=2, check=False
        ).stdout
    except OSError, subprocess.TimeoutExpired:
        return False
    return out.lstrip().lower().startswith("ugrep")


def _ugrep_flag(stage: list[str]) -> str | None:
    if not stage or stage[0] != "grep":
        return None
    flagged = sorted(_short_flags(stage) & set(_UGREP_FLAG_FIXES))
    if not flagged or not _grep_is_ugrep():
        return None
    return f"This host's grep is ugrep, not GNU grep. {_UGREP_FLAG_FIXES[flagged[0]]}"


def _bare_stash(stage: list[str]) -> str | None:
    if not (_invokes(stage, ("git", "stash", "pop")) or _invokes(stage, ("git", "stash", "apply"))):
        return None
    if any(word.startswith("stash@") for word in stage):
        return None
    return (
        "The git stash stack is per-repository, not per-worktree, so a bare pop can apply "
        "another session's work-in-progress into this tree. Run `git stash list` and pop "
        "the ref you meant: `git stash pop 'stash@{0}'`."
    )


def _pgrep_self_match(stage: list[str]) -> str | None:
    if not stage or stage[0] != "pgrep" or "f" not in _short_flags(stage):
        return None
    # A character class breaks the self-match, which is the documented fix; its presence
    # says the author already knows.
    if any("[" in word for word in stage):
        return None
    return (
        "`pgrep -f` matches the shell running it, because this command's own /proc cmdline "
        "contains the pattern, so the check reads as 'still running' forever. Wait on the "
        "thing itself: prefer `run_in_background: true` and let the harness notify on exit, "
        "or match the PID (`while kill -0 <pid> 2>/dev/null`), or break the self-match with "
        "a character class: `pgrep -f 'b2_[w]ipe_prefixes'`."
    )


def _security_and_analysis(stage: list[str]) -> str | None:
    if not _invokes(stage, ("gh", "api")):
        return None
    text = " ".join(stage)
    if "security_and_analysis" not in text:
        return None
    if "PATCH" not in text and "-X" not in text:
        return None
    missing = [m for m in _SECURITY_ANALYSIS_MEMBERS if m not in text]
    if not missing:
        return None
    return (
        "A `security_and_analysis` PATCH REPLACES the object: every member you omit is "
        "reset, and the call returns 200 either way. This one omits: "
        + ", ".join(missing)
        + ". Send all five, or use the dedicated endpoints "
        "(`PUT /repos/{o}/{r}/vulnerability-alerts`, `.../automated-security-fixes`), which "
        "change one setting without touching the rest."
    )


_RULES = (
    ("ugrep-flag", _ugrep_flag),
    ("bare-stash", _bare_stash),
    ("pgrep-self-match", _pgrep_self_match),
    ("security-and-analysis", _security_and_analysis),
)


def footgun(command: str) -> Verdict | None:
    """A deny naming the first footgun `command` trips, or None."""
    for stage in _stages(command) or []:
        for rule, check in _RULES:
            found = check(stage)
            if found:
                return Verdict("deny", rule, found)
    return None
