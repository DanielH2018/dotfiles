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

The spans come from `segment.substitution_spans`, the same pass `parse` makes, so this
module and the segmenter cannot disagree on where a substitution starts or ends. Refused
outright: a backtick, a substitution inside `${ }` (whose operators reach arithmetic, which
can run a command through an array subscript), and one inside `$(( ))`, which is left in
the masked text and so fails the check that the masked command parses with none left.
"""

from dataclasses import dataclass

from claude_guard.segment import parse, substitution_spans

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

# The span kinds this module cuts out and judges. `$(( ))` is arithmetic, left in place.
_JUDGED_KINDS = frozenset({"paren", "procsub"})


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


def mask(command: str) -> Masked | None:
    """The command with its top-level substitutions cut out, or None when it cannot be.

    None means refuse: a backtick, the placeholder already in the text, a parse the
    segmenter refuses, a substitution inside `${ }`, or a masked command that still holds
    a substitution.
    """
    if "`" in command or PLACEHOLDER in command:
        return None
    spans = substitution_spans(command)
    if spans is None or any(s.in_brace for s in spans):
        return None
    judged = [s for s in spans if s.kind in _JUDGED_KINDS]
    out: list[str] = []
    prev = 0
    for span in judged:
        out += (command[prev : span.start], PLACEHOLDER)
        prev = span.end
    out.append(command[prev:])
    masked = "".join(out)
    after = parse(masked)
    if not after.ok or after.substitutions or len(after.segments) != len(parse(command).segments):
        return None
    return Masked(masked, tuple(command[s.body : s.end - 1] for s in judged))
