"""git's command line as git reads it: the one place a rule finds git's subcommand (#709).

A rule that anchors on `git <subcommand>` misses every global option git accepts between the
two words. `git -C <dir> push -f` force-pushed past all three push rules in deny.py, and each
earlier fix covered one more spelling. This module reads the whole class once, and every git
rule reads git through it:

    invocation(argv)       the parsed form: subcommand, its arguments, the global options
                           before it, and the config it sets inline. git_conventions and
                           deny.py's push_config and no_verify rules read this.
    canonical_lines(text)  `git <subcommand> <args>` for the git a segment runs, with the
                           global options dropped and an inline alias expanded. deny.py adds
                           these to its segment set, so its regex rules match them unchanged.
    subcommand_at(subs)    a regex prefix for the same class in text the parser cannot read:
                           a refused parse, or git inside another program's argument
                           (`bash -c 'git -C x push -f'`). It is built from the same option
                           table.

The wrapper and assignment prefixes are read loosely, because every consumer here is a deny or
an ask. Reading `sudo -u x git push` as a git push can only add a decision, never remove one.
"""

import os
import re
import shlex
from dataclasses import dataclass

# `git --help`: the global options that take their value as the NEXT word. Each also has a
# one-token `--opt=value` spelling, which needs no entry. Every other dash word before the
# subcommand is a flag that takes no value: -p, -P, --paginate, --no-pager, --bare,
# --exec-path[=<path>], --no-replace-objects, --no-lazy-fetch, --no-optional-locks,
# --no-advice, and the four *-pathspecs options.
GLOBAL_WITH_ARG = frozenset(
    {
        "-C",
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--config-env",
        "--super-prefix",
        "--attr-source",
    }
)

# Commands that run the rest of their argv as a command.
_WRAPPERS = frozenset(
    {
        "command",
        "builtin",
        "exec",
        "env",
        "nohup",
        "setsid",
        "time",
        "nice",
        "timeout",
        "stdbuf",
        "sudo",
        "doas",
        "xargs",
    }
)

# The git subcommands that update a remote's refs. send-pack is the plumbing under push and
# takes the same --force, --mirror and +refspec.
PUSH_SUBCOMMANDS = frozenset({"push", "send-pack", "http-push"})

_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SEPARATORS = re.compile(r"[;&|\n]")
_PARAM = re.compile(r"'((?:[^']|'\\'')*)'(?:=('(?:[^']|'\\'')*'))?")


@dataclass(frozen=True, slots=True)
class Invocation:
    sub: str  # the subcommand after alias expansion; "" when a hidden alias hides it
    args: tuple[str, ...]
    global_opts: tuple[str, ...]
    # (key, value) for every config the command line sets: `-c`, `--config-env`,
    # GIT_CONFIG_KEY_n/VALUE_n and GIT_CONFIG_PARAMETERS. Keys are lowercased; a value is
    # None when git reads it from an environment variable the command does not show.
    config: tuple[tuple[str, str | None], ...]
    shell: str = ""  # a `!` alias's shell command, run instead of a subcommand


def strip_env(argv: list[str]) -> list[str]:
    """argv without its leading `NAME=value` assignments."""
    i = 0
    while i < len(argv) and _ASSIGNMENT.match(argv[i]):
        i += 1
    return argv[i:]


def _unwrap(argv: list[str]) -> tuple[list[str], dict[str, str]] | None:
    """(the git argv, the assignments before it) when `argv` runs git, else None. A wrapper's
    own options and their values are skipped without a table: the first word named git after
    only wrappers, assignments and option-shaped words is the git that runs."""
    env: dict[str, str] = {}
    i, wrapped = 0, False
    while i < len(argv):
        word = argv[i]
        name = os.path.basename(word)
        if name == "git":
            return argv[i:], env
        if _ASSIGNMENT.match(word):
            key, _, value = word.partition("=")
            env[key] = value
        elif name in _WRAPPERS:
            wrapped = True
        elif not wrapped:
            return None
        elif not (word.startswith("-") or word[:1].isdigit() or argv[i - 1].startswith("-")):
            return None  # a wrapper ran some other command
        i += 1
    return None


def _config_from_env(env: dict[str, str]) -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    for name, key in env.items():
        m = re.fullmatch(r"GIT_CONFIG_KEY_(\d+)", name)
        if m:
            out.append((key.lower(), env.get(f"GIT_CONFIG_VALUE_{m.group(1)}")))
    params = env.get("GIT_CONFIG_PARAMETERS", "")
    for m in _PARAM.finditer(params):
        key, value = m.group(1), m.group(2)
        if value is not None:
            out.append((key.lower(), value[1:-1]))
        else:  # the older 'key=value' form
            k, eq, v = key.partition("=")
            out.append((k.lower(), v if eq else "true"))
    return out


def _split_config(spec: str, hidden: bool) -> tuple[str, str | None]:
    key, eq, value = spec.partition("=")
    if hidden:
        return key.lower(), None
    return key.lower(), value if eq else "true"


def _read_globals(argv: list[str]) -> tuple[int, list[str], list[tuple[str, str | None]]]:
    """(index of the subcommand, the global options, the config they set) for a git argv."""
    config: list[tuple[str, str | None]] = []
    i = 1
    while i < len(argv) and argv[i].startswith("-"):
        word = argv[i]
        name, _, value = word.partition("=")
        if word in GLOBAL_WITH_ARG:
            value = argv[i + 1] if i + 1 < len(argv) else ""
            i += 2
        else:
            i += 1
        if word == "-c":
            config.append(_split_config(value, hidden=False))
        elif name == "--config-env":
            config.append(_split_config(value, hidden=True))
    return i, argv[1:i], config


def invocation(argv: list[str]) -> Invocation | None:
    """The git a command's argv runs, read as git reads it, or None when it runs no git."""
    found = _unwrap(argv)
    if found is None:
        return None
    git, env = found
    config = _config_from_env(env)
    i, global_opts, inline = _read_globals(git)
    config += inline
    if i >= len(git):
        return None
    sub, args = git[i], git[i + 1 :]
    # An alias expands in place, and its words may carry more global options. A builtin wins
    # over an alias of the same name, which only matters for push here. The bound stops an
    # alias loop, as git's own does.
    for _ in range(8):
        if sub in PUSH_SUBCOMMANDS:
            break
        values = [v for k, v in config if k == f"alias.{sub.lower()}"]
        if not values:
            break
        value = values[-1]
        if value is None:
            sub = ""  # --config-env hides what the alias runs
            break
        if value.startswith("!"):
            return Invocation("", tuple(args), tuple(global_opts), tuple(config), value[1:])
        try:
            words = shlex.split(value)
        except ValueError:
            break
        j, more_opts, more_config = _read_globals(["git", *words])
        global_opts += more_opts
        config += more_config
        if j >= len(words) + 1:
            break
        sub, args = words[j - 1], words[j:] + args
    return Invocation(sub, tuple(args), tuple(global_opts), tuple(config))


def canonical_lines(text: str, subs: frozenset[str]) -> list[str]:
    """`git <subcommand> <args>` for the git one segment runs when its subcommand is one of
    `subs`, else []. A `!` alias contributes its shell command, read the same way.

    A separator inside an argument becomes a space. The line is a new member of the caller's
    scan set, where `git commit -m "a; terraform apply"` must not put `terraform` in command
    position."""
    try:
        argv = shlex.split(text)
    except ValueError:
        return []
    inv = invocation(argv)
    if inv is None:
        return []
    if inv.shell:
        shell = f"{inv.shell} {shlex.join(inv.args)}".strip()
        return [shell, *canonical_lines(shell, subs)] if shell != text else [shell]
    if inv.sub not in subs:
        return []
    return [" ".join(["git", inv.sub, *(_SEPARATORS.sub(" ", a) for a in inv.args)])]


# `git config` options that take their value as the next word, and the ones that make the
# legacy form (no subcommand word) a read or a removal rather than a write.
_CONFIG_WITH_ARG = frozenset(
    {"-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--url"}
)
_CONFIG_READ_SUBCOMMANDS = frozenset(
    {"get", "list", "unset", "edit", "rename-section", "remove-section"}
)
_CONFIG_NOT_A_WRITE = frozenset(
    {
        "--get",
        "--get-all",
        "--get-regexp",
        "--get-urlmatch",
        "--get-color",
        "--get-colorbool",
        "-l",
        "--list",
        "--unset",
        "--unset-all",
        "--rename-section",
        "--remove-section",
        "-e",
        "--edit",
    }
)


def config_writes(inv: Invocation) -> list[tuple[str, str]]:
    """(key, value) for each setting a `git config` invocation writes, keys lowercased. Both
    spellings: `git config [opts] <key> <value>` and `git config set [opts] <key> <value>`."""
    if inv.sub != "config":
        return []
    words: list[str] = []
    flags: set[str] = set()
    args = list(inv.args)
    i = 0
    while i < len(args):
        tok = args[i]
        if tok.startswith("-") and tok != "-":
            name = tok.split("=", 1)[0]
            flags.add(name)
            i += 2 if tok in _CONFIG_WITH_ARG else 1
            continue
        words.append(tok)
        i += 1
    if words and words[0] == "set":
        words = words[1:]
    elif (words and words[0] in _CONFIG_READ_SUBCOMMANDS) or flags & _CONFIG_NOT_A_WRITE:
        return []
    if len(words) < 2:
        return []
    return [(words[0].lower(), words[1])]


def remote_add_mirrors_push(inv: Invocation) -> bool:
    """`git remote add --mirror[=push]`: every later `git push <that remote>` is a mirror
    push. A bare `--mirror` configures both directions; `--mirror=fetch` configures none of
    the push side."""
    if inv.sub != "remote" or not inv.args or inv.args[0] != "add":
        return False
    return any(a in ("--mirror", "--mirror=push") for a in inv.args[1:])


def invocations(text: str) -> list[Invocation]:
    """invocation() of one segment's text, or [] when it runs no git or cannot be split."""
    try:
        inv = invocation(shlex.split(text))
    except ValueError:
        return []
    return [inv] if inv else []


# --- the same class as a regex, for text the parser cannot read -----------------------------

_WITH_ARG_RE = "|".join(re.escape(o) for o in sorted(GLOBAL_WITH_ARG, key=len, reverse=True))
# Atomic and possessive: once `-C <dir>` is read as an option and its value, the regex never
# re-reads it as a flag followed by a subcommand, which is also what keeps a long run of
# options from backtracking exponentially.
GLOBALS_RE = rf"(?>\s+(?:{_WITH_ARG_RE})\s+[^\s;&|]+|\s+-[^\s;&|]*)*+"


def subcommand_at(subs: frozenset[str]) -> str:
    """A regex for `git`, any run of global options, then one of `subs` as the subcommand. It
    reads text with the quotes removed, so a quoted value holding a space ends it early; the
    canonical lines cover that case for a command the parser reads."""
    names = "|".join(re.escape(s) for s in sorted(subs))
    return rf"git{GLOBALS_RE}\s+(?:{names})\b"
