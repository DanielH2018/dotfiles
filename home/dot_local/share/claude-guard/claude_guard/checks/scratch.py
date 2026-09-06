"""An rm whose every operand is provably confined to a scratch root. allow-safe-rm.sh ported.

The option table is an ALLOWLIST: an option this module does not name is not a decision.
Absent by intent is --no-preserve-root. What the check cannot see, and why it is still
sound: a symlink under a scratch root pointing outside it — deleting the link deletes the
link, POSIX never traverses a symlink while deleting, and a trailing slash on a symlink
operand makes rm refuse rather than follow (allow-safe-rm.sh:20-29).
"""

# allow-safe-rm.sh:54-61. -i/-I only add prompts; -v only prints. --preserve-root is the
# default and is named so writing it explicitly is not a refusal.
BOOL_SHORT = frozenset("rRfdvIi")
LONG_OK = frozenset(
    {
        "--recursive",
        "--force",
        "--dir",
        "--verbose",
        "--interactive",
        "--one-file-system",
        "--preserve-root",
    }
)

# :88-89. Any shell-special character OUTSIDE quotes is a refusal: chaining, pipes,
# redirection, substitution, grouping, and the glob characters — the shell expands a glob
# AFTER the decision is made, so a pattern could reach rm as paths never validated.
_SPECIAL = frozenset(";&|<>(){}$`\\*?[]\n\r")


def tokenize(s: str) -> list[str] | None:
    """:69-110. Split into words, honouring quotes. None is a refusal, never an empty list."""
    tokens: list[str] = []
    state = ""
    cur = ""
    started = False
    for c in s:
        if state == "":
            if c in " \t":
                if started:
                    tokens.append(cur)
                    cur = ""
                    started = False
            elif c == "'":
                state = "single"
                started = True
            elif c == '"':
                state = "double"
                started = True
            elif c in _SPECIAL or c == "~":
                return None
            else:
                cur += c
                started = True
        elif state == "single":
            if c == "'":
                state = ""
            else:
                cur += c
        else:  # double: :98-104, $ ` and \ are refused, everything else literal
            if c == '"':
                state = ""
            elif c in "$`\\":
                return None
            else:
                cur += c
    if state:
        return None  # unterminated quote
    if started:
        tokens.append(cur)
    return tokens


def under_scratch(path: str, roots: tuple[str, ...]) -> bool:
    """:115-130. Strictly below a root, judged lexically; `..` is a refusal, not resolved."""
    if not path.startswith("/"):
        return False  # relative path: cwd is unknown here
    if ".." in path:
        return False
    p = path.removesuffix("/")  # one trailing slash is cosmetic (${p%/})
    if not p:
        return False  # the filesystem root on its own
    if "//" in p:
        return False  # collapsed separators: refuse rather than guess
    # `[[ $p == "$root"/?* ]]`: the root, a slash, and at least one more character.
    return any(p.startswith(root + "/") and len(p) > len(root) + 1 for root in roots)


def rm_confined(command: str, roots: tuple[str, ...]) -> bool:
    """:137-174. True only when a confined operand was seen and nothing else was refused."""
    if not command:
        return False
    tokens = tokenize(command)
    if not tokens:
        return False
    # :142. The command word with any path prefix stripped; nothing may precede it.
    if tokens[0].rsplit("/", 1)[-1] != "rm":
        return False
    saw_path = False
    endopts = False
    for tok in tokens[1:]:
        if not endopts:
            if tok == "--":
                endopts = True
                continue
            if tok.startswith("--"):
                if tok not in LONG_OK:
                    return False
                continue
            if tok.startswith("-") and len(tok) > 1:
                # :158-166. Every letter in a cluster must be in the boolean table.
                if any(ch not in BOOL_SHORT for ch in tok[1:]):
                    return False
                continue
            if tok == "-":
                return False
        if not under_scratch(tok, roots):
            return False
        saw_path = True
    return saw_path
