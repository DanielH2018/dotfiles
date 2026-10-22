"""Command substitutions read apart from the command around them, so the judge can vet both.

Typical usage example:

    masked = mask('echo "head: $(git rev-parse HEAD)"')
    # masked.command == 'echo "head: __claude_guard_sub__"'
    # masked.inner == ("git rev-parse HEAD",)

The judge allows a command with a `$( )`, `<( )` or `>( )` in it only when every inner
command is allowed on its own AND the outer command is allowed with each substitution
replaced by `PLACEHOLDER`. The placeholder stands for text the judge cannot see, so where it
may sit is narrow: a standalone assignment's value, a `for` word list, an argument to one
of `INERT_COMMANDS`, or a `printf` argument after a literal format. Nowhere else, and never
in a write redirect target. A substitution's output is word-split into the outer
command, so in an argument to `git push` it can supply `--force`, and the deny rule that
reads `--force` off the literal text never sees it. A variable assigned from a
substitution, or a `for` variable looping over one, carries the same output, so the judge
holds every later reference to it to the same rules.

Backticks are refused outright, and so is anything this module and `segment.parse` read
differently: `mask` re-derives the substitution list from its own spans and returns None
unless it equals the one `parse` reported. A second scanner here is the drift hazard
`segment.py` warns about, and the cross-check is what makes a drift refuse rather than allow.
"""

from dataclasses import dataclass

from claude_guard.segment import parse

PLACEHOLDER = "__claude_guard_sub__"

# Commands whose arguments can neither write a file nor run a program, whatever text a
# substitution puts there. They read files, compare them, print, or test. `printf` is not
# listed: a substitution as its first argument can expand to `-v PATH`, which reassigns a
# variable every later segment runs under, so the judge admits it only behind a literal
# format. `sed` (`w`, `-i`), `sort -o`, `find -exec` and `tee` are left out because an
# argument can make them write.
INERT_COMMANDS = frozenset(
    {
        "echo",
        "test",
        "[",
        "cd",
        "cat",
        "head",
        "tail",
        "wc",
        "ls",
        "grep",
        "diff",
        "comm",
        "join",
        "basename",
        "dirname",
    }
)

# Frames that count `(`/`)` toward their own close. `$((` is arithmetic, not a substitution.
_PAREN_FRAMES = frozenset({"sub", "arith"})


@dataclass(frozen=True, slots=True)
class Masked:
    """A command with its top-level substitutions cut out.

    Attributes:
        command: the command with each top-level substitution replaced by `PLACEHOLDER`.
        inner: the text inside each top-level substitution, in order. A nested substitution
            stays inside its parent's text, for the judge to find when it judges the parent.
    """

    command: str
    inner: tuple[str, ...]


def _spans(s: str) -> list[tuple[int, int, int]] | None:
    """(start, body_start, end) for each top-level `$( )`, `<( )` or `>( )`, or None.

    `s[start:end]` is the whole substitution and `s[body_start:end - 1]` its body. Quoting
    follows `segment.parse`: no frame opens inside single quotes, and `<(` does not open
    inside double quotes.
    """
    n = len(s)
    kind: list[str] = []
    depth: list[int] = []
    spans: list[tuple[int, int, int]] = []
    open_at = -1
    i = 0
    while i < n:
        c = s[i]
        top = kind[-1] if kind else ""
        if top == "squote":
            if c == "'":
                kind.pop()
                depth.pop()
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c == "'":
            if top != "dquote":
                kind.append("squote")
                depth.append(0)
            i += 1
            continue
        if c == '"':
            if top == "dquote":
                kind.pop()
                depth.pop()
            else:
                kind.append("dquote")
                depth.append(0)
            i += 1
            continue
        nxt = s[i + 1] if i + 1 < n else ""
        opens = (c == "$" and nxt == "(") or (c in "<>" and nxt == "(" and top != "dquote")
        if opens:
            arith = c == "$" and s[i + 2 : i + 3] == "("
            if not arith and not any(k in _PAREN_FRAMES or k == "brace" for k in kind):
                open_at = i
            kind.append("arith" if arith else "sub")
            depth.append(0)
            i += 2
            continue
        if c == "$" and nxt == "{":
            kind.append("brace")
            depth.append(0)
            i += 2
            continue
        if top in _PAREN_FRAMES:
            if c == "(":
                depth[-1] += 1
            elif c == ")":
                if depth[-1]:
                    depth[-1] -= 1
                else:
                    kind.pop()
                    depth.pop()
                    if top == "sub" and not any(k in _PAREN_FRAMES or k == "brace" for k in kind):
                        spans.append((open_at, open_at + 2, i + 1))
            i += 1
            continue
        if top == "brace":
            if c == "{":
                depth[-1] += 1
            elif c == "}":
                if depth[-1]:
                    depth[-1] -= 1
                else:
                    kind.pop()
                    depth.pop()
        i += 1
    return None if kind else spans


def mask(command: str) -> Masked | None:
    """The command with its top-level substitutions cut out, or None when it cannot be.

    None means refuse: a backtick, the placeholder already in the text, a parse the
    segmenter refuses, or spans that do not reproduce `parse`'s own substitution list.
    """
    if "`" in command or PLACEHOLDER in command:
        return None
    parsed = parse(command)
    if not parsed.ok:
        return None
    spans = _spans(command)
    if spans is None:
        return None
    expected: list[str] = []
    for start, _body, end in spans:
        piece = parse(command[start:end])
        if not piece.ok:
            return None
        expected += piece.substitutions
    if tuple(expected) != parsed.substitutions:
        return None
    out: list[str] = []
    prev = 0
    for start, _body, end in spans:
        out.append(command[prev:start])
        out.append(PLACEHOLDER)
        prev = end
    out.append(command[prev:])
    masked = "".join(out)
    after = parse(masked)
    if not after.ok or after.substitutions or len(after.segments) != len(parsed.segments):
        return None
    return Masked(masked, tuple(command[body : end - 1] for _s, body, end in spans))
