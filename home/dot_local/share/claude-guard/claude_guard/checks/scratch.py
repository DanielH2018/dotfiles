"""An rm whose every operand is provably confined to a scratch root. allow-safe-rm.sh ported.

The option table is an ALLOWLIST: an option this module does not name is not a decision.
Absent by intent is --no-preserve-root. What the check cannot see, and why it is still
sound: a symlink under a scratch root pointing outside it — deleting the link deletes the
link, POSIX never traverses a symlink while deleting, and a trailing slash on a symlink
operand makes rm refuse rather than follow (allow-safe-rm.sh:20-29).
"""

import os
import stat

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
# AFTER the decision is made, so a pattern could reach rm as paths never validated. The
# exceptions are rm_confined's, which can bound a last-component glob (`glob_confined`) and
# knows the one variable $CLAUDE_JOB_DIR.
_SPECIAL = frozenset(";&|<>(){}$`\\*?[]\n\r")


# The one variable an rm operand may name (#956). Claude Code sets it in a background
# job's environment, and the hook inherits that environment, so its value is known here.
JOB_DIR_VAR = "CLAUDE_JOB_DIR"
_GLOB = frozenset("*?[]")


def _words(s: str, job_dir: str = "", globs: bool = False) -> list[tuple[str, bool]] | None:
    """Split into (word, globbed) pairs, honouring quotes. None is a refusal.

    `job_dir` is the value `$CLAUDE_JOB_DIR` and `${CLAUDE_JOB_DIR}` expand to outside
    single quotes; empty refuses them like any other `$`. `globs` admits `*`, `?` and `[`
    outside quotes, and `globbed` marks a word that carries one.
    """
    words: list[tuple[str, bool]] = []
    state = ""
    cur = ""
    started = False
    globbed = False
    i = 0
    while i < len(s):
        c = s[i]
        if c == "$" and state != "single":
            name_len = _job_dir_ref(s, i)
            if not job_dir or not name_len:
                return None
            cur += job_dir
            started = True
            i += name_len
            continue
        if state == "":
            if c in " \t":
                if started:
                    words.append((cur, globbed))
                    cur = ""
                    started = False
                    globbed = False
            elif c == "'":
                state = "single"
                started = True
            elif c == '"':
                state = "double"
                started = True
            elif globs and c in _GLOB:
                cur += c
                started = True
                globbed = True
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
            elif c in "`\\":
                return None
            else:
                cur += c
        i += 1
    if state:
        return None  # unterminated quote
    if started:
        words.append((cur, globbed))
    return words


def _job_dir_ref(s: str, i: int) -> int:
    """The length of a `$CLAUDE_JOB_DIR` or `${CLAUDE_JOB_DIR}` reference at `s[i]`, else 0."""
    braced = "${" + JOB_DIR_VAR + "}"
    if s.startswith(braced, i):
        return len(braced)
    bare = "$" + JOB_DIR_VAR
    end = i + len(bare)
    if s.startswith(bare, i) and not (end < len(s) and (s[end].isalnum() or s[end] == "_")):
        return len(bare)
    return 0


def tokenize(s: str) -> list[str] | None:
    """:69-110. Split into words, honouring quotes. None is a refusal, never an empty list."""
    words = _words(s)
    return None if words is None else [w for w, _ in words]


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


def write_confined(target: str, roots: tuple[str, ...]) -> bool:
    """True when a `>`/`>>` redirect to `target` writes a plain file inside a scratch root.

    Unlike `under_scratch`, this resolves: the target's parent directory must exist and its
    real path must sit at or below a root's real path, so a symlinked directory cannot carry
    the write out, and macOS's `/tmp` -> `/private/tmp` link compares equal on both sides.
    The target itself must be absent, or a regular file with one link: an existing symlink
    or a hard link to a file elsewhere would carry the write to that file. Whether a later
    segment of the same chain can create such a link before the write runs is the caller's
    question (see `judge.LINK_MAKERS`).
    """
    if tokenize(target) != [target] or not target.startswith("/"):
        return False
    parent, name = os.path.split(target)
    if name in ("", ".", ".."):
        return False
    real_parent = os.path.realpath(parent)
    if not os.path.isdir(real_parent):
        return False
    real_roots = [os.path.realpath(r) for r in roots]
    if not any(real_parent == r or real_parent.startswith(r + "/") for r in real_roots):
        return False
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_nlink == 1


def glob_confined(pattern: str, roots: tuple[str, ...]) -> bool:
    """True when every path the glob `pattern` can expand to sits strictly below a root.

    The pattern may glob in its last component only, so it expands to entries of one parent
    directory. That parent must exist and resolve strictly below a resolved root, so a
    symlinked parent cannot carry the expansion out. A last component that starts with `.`
    refuses, because `.*` can match `..`.
    """
    parent, _, name = pattern.rpartition("/")
    if not name or name.startswith(".") or any(c in _GLOB for c in parent):
        return False
    if not under_scratch(parent, roots):
        return False
    real_parent = os.path.realpath(parent)
    if not os.path.isdir(real_parent):
        return False
    return any(real_parent.startswith(os.path.realpath(r) + "/") for r in roots)


def rm_confined(
    command: str, roots: tuple[str, ...], job_dir: str = "", globs: bool = False
) -> bool:
    """:137-174. True only when a confined operand was seen and nothing else was refused.

    Args:
      command: the rm segment.
      roots: the scratch roots.
      job_dir: the value of $CLAUDE_JOB_DIR, which an operand may name (#956). Empty
        refuses the reference. The caller must refuse a value the command itself could set.
      globs: admit an operand that globs in its last component (`glob_confined`). The caller
        passes False when the chain could plant a symlink at the parent first.
    """
    if not command:
        return False
    if job_dir and tokenize(job_dir) != [job_dir]:
        return False  # a value holding whitespace or a special character
    words = _words(command, job_dir, globs)
    if not words:
        return False
    tokens = [w for w, _ in words]
    globbed = {i for i, (_, g) in enumerate(words) if g}
    # :142. The command word with any path prefix stripped; nothing may precede it.
    if tokens[0].rsplit("/", 1)[-1] != "rm":
        return False
    saw_path = False
    endopts = False
    for i, tok in enumerate(tokens[1:], start=1):
        if i in globbed:
            if not glob_confined(tok, roots):
                return False
            saw_path = True
            continue
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
