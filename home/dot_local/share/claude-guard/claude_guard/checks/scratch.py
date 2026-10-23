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
# AFTER the decision is made, so a pattern could reach rm as paths never validated. Only
# rm_confined keeps the glob characters, and only to vet the directory they expand in.
_SPECIAL = frozenset(";&|<>(){}$`\\*?[]\n\r")
_GLOB = frozenset("*?[]")
# The one variable an rm operand may name. The hook's environment holds its value, and a
# background job's scratch files live under it (dotfiles #956).
JOB_DIR_VAR = "CLAUDE_JOB_DIR"
_NAME_CHAR = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")


def _job_dir_ref(s: str, i: int) -> int:
    """Length of a `$CLAUDE_JOB_DIR` or `${CLAUDE_JOB_DIR}` starting at `s[i]`, else 0.

    A longer name (`$CLAUDE_JOB_DIRX`) and any `${…}` modifier (`${CLAUDE_JOB_DIR:-/}`) are
    not this reference, so they return 0 and the caller refuses the `$`.
    """
    braced = "${" + JOB_DIR_VAR + "}"
    if s.startswith(braced, i):
        return len(braced)
    bare = "$" + JOB_DIR_VAR
    end = i + len(bare)
    if s.startswith(bare, i) and (end == len(s) or s[end] not in _NAME_CHAR):
        return len(bare)
    return 0


def _words(s: str, job_dir: str = "", globs: bool = False) -> list[tuple[str, int]] | None:
    """Split `s` into (word, index of its first unquoted glob character or -1).

    `job_dir` is substituted for a `$CLAUDE_JOB_DIR` reference, unquoted or in double
    quotes, when it is an absolute path with no shell-special character, so that word
    splitting and globbing leave it one word. With `globs`, an unquoted `*?[]` is kept and
    its position reported. None is a refusal.
    """
    usable_job_dir = bool(job_dir) and job_dir.startswith("/") and tokenize(job_dir) == [job_dir]
    words: list[tuple[str, int]] = []
    state = ""
    cur = ""
    glob_at = -1
    started = False
    i = 0
    while i < len(s):
        c = s[i]
        if c == "$" and state != "single":
            ref = _job_dir_ref(s, i) if usable_job_dir else 0
            if not ref:
                return None
            cur += job_dir
            started = True
            i += ref
            continue
        i += 1
        if state == "":
            if c in " \t":
                if started:
                    words.append((cur, glob_at))
                    cur = ""
                    glob_at = -1
                    started = False
            elif c == "'":
                state = "single"
                started = True
            elif c == '"':
                state = "double"
                started = True
            elif globs and c in _GLOB:
                if glob_at < 0:
                    glob_at = len(cur)
                cur += c
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
        else:  # double: :98-104, ` and \ are refused, everything else literal
            if c == '"':
                state = ""
            elif c in "`\\":
                return None
            else:
                cur += c
    if state:
        return None  # unterminated quote
    if started:
        words.append((cur, glob_at))
    return words


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


def _glob_confined(word: str, glob_at: int, roots: tuple[str, ...]) -> bool:
    """True when the pattern `word` can only expand to entries of a directory inside a root.

    A glob only in the final component matches only entries of its parent, so the parent
    decides. The parent must sit strictly below a root both as spelled and as resolved: an
    intermediate symlink IS followed, so `/tmp/x/*` with `/tmp/x` a link to home would
    delete in home. A final component starting with `.` or `[` could match `.` or `..` in
    a shell without globskipdots, and is refused rather than left to rm's own refusal.
    """
    slash = word.rfind("/")
    if slash < 0 or slash > glob_at:
        return False
    parent, name = word[:slash], word[slash + 1 :]
    if name.startswith((".", "[")) or not under_scratch(parent, roots):
        return False
    real_parent = os.path.realpath(parent)
    return any(real_parent.startswith(os.path.realpath(r) + "/") for r in roots)


def rm_confined(command: str, roots: tuple[str, ...], job_dir: str = "") -> bool:
    """:137-174. True only when a confined operand was seen and nothing else was refused.

    `job_dir` is the hook's $CLAUDE_JOB_DIR, which an operand may name (`_words`). An
    operand may also carry a glob in its final component (`_glob_confined`).
    """
    if not command:
        return False
    words = _words(command, job_dir, globs=True)
    if not words:
        return False
    # :142. The command word with any path prefix stripped; nothing may precede it.
    if words[0][1] >= 0 or words[0][0].rsplit("/", 1)[-1] != "rm":
        return False
    saw_path = False
    endopts = False
    for tok, glob_at in words[1:]:
        if glob_at >= 0:
            if not _glob_confined(tok, glob_at, roots):
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
