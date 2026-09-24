"""Per-verb guards for a REMOTE argv: verbs that read under most arguments but write or
exec under a few. Ported from the server repo's `auto-approve-readonly.py` (server #1898),
where each lived as a `HANDLERS` entry returning a reason string; here each returns a bool
and takes the remote argv the far shell would run (`checks/remote.py` tokenizes it).

Two shapes, and the tables beside each say which:
  * a flag scan (`find`, `sort`, `uniq`, `dpkg`): refuse when a writing flag is present;
  * a subcommand table (`git`, `apt`, `apt-mark`, `pipx`, `crontab`): allow only a listed
    read-only subcommand, after skipping the global options that cannot change what runs.
`sed` and `awk` are the third shape: their program text is scanned for a command that
writes a file or runs a process, and a program the scanner cannot read (`-f FILE`) refuses.

Every guard is biased to refuse: a parse ambiguity leaves more text to scan, which can only
add refusals. False is "no opinion" — the caller falls through to the prompt.

`claude_guard/readonly.py` applies the same guards to LOCAL commands, with stricter
pre-checks of its own (`_GAPS`). The server repo kept a second copy of each guard for its
PreToolUse classifier until dotfiles #628 moved that classifier here and deleted it.
"""

import re
from collections.abc import Callable

# git subcommands that are read-only regardless of arguments (branch/tag/remote omitted:
# their bare form lists but `git branch <name>` / `-D` mutate).
GIT_READONLY = frozenset(
    {
        "status",
        "log",
        "diff",
        "show",
        "describe",
        "rev-parse",
        "rev-list",
        "ls-files",
        "ls-tree",
        "blame",
        "shortlog",
        "whatchanged",
        "cat-file",
        "for-each-ref",
        "grep",
        "name-rev",
        "var",
    }
)
# git global options safe to skip before the subcommand (NOT -c: config injection can set
# core.pager to an arbitrary command).
_GIT_SKIP = frozenset(
    {
        "--no-pager",
        "-P",
        "--paginate",
        "--bare",
        "--literal-pathspecs",
        "--no-replace-objects",
        "--icase-pathspecs",
    }
)
_GIT_SKIP_VALUE = frozenset({"-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"})


def git_readonly(argv: list[str]) -> bool:
    i, n = 1, len(argv)
    while i < n and argv[i].startswith("-"):
        a = argv[i]
        if a in _GIT_SKIP:
            i += 1
        elif a in _GIT_SKIP_VALUE:
            i += 2
        elif a.split("=", 1)[0] in _GIT_SKIP_VALUE:
            i += 1
        else:
            return False  # -c and anything unrecognised: refuse
    return i < n and argv[i] in GIT_READONLY


_FIND_WRITE = frozenset(
    {
        "-delete",
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-fprint",
        "-fprintf",
        "-fprint0",
        "-fls",
    }
)


def find_readonly(argv: list[str]) -> bool:
    return not any(a in _FIND_WRITE for a in argv[1:])


_SORT_OUTPUT_SHORT = re.compile(r"-[A-Za-z]*o")


def sort_readonly(argv: list[str]) -> bool:
    # -o / --output writes to a file; the o may sit inside a short cluster (`-uo`).
    return not any(
        a == "--output" or a.startswith("--output=") or _SORT_OUTPUT_SHORT.match(a)
        for a in argv[1:]
    )


def uniq_readonly(argv: list[str]) -> bool:
    # uniq [INPUT [OUTPUT]] -- a second positional is an output file (a write).
    return len([a for a in argv[1:] if not a.startswith("-")]) <= 1


# awk can write files (`print > "f"`), pipe to a shell (`print | "sh"`, `"cmd" | getline`)
# or exec (`system(...)`); -f reads an uninspectable program and -i edits in place. Refuse
# the program outright if any of these appear, and refuse -f/-i. The `>` check also refuses
# benign comparisons -- safe over-refusal.
_AWK_DANGER = ("system", "getline", "|", ">")


def awk_readonly(argv: list[str]) -> bool:
    prog: list[str] = []
    i, n = 1, len(argv)
    while i < n:
        a = argv[i]
        if a == "--":
            i += 1
            break
        if not a.startswith("-") or a == "-":
            prog.append(a)  # first positional is the program text
            i += 1
            break
        if a.startswith("-f") or a.startswith("-i"):
            return False  # -f program-file (uninspectable), -i in-place
        if a in ("-e", "--source"):
            if i + 1 >= n:
                return False
            prog.append(argv[i + 1])
            i += 2
            continue
        if a in ("-v", "-F"):
            i += 2  # option takes a separate value
            continue
        i += 1  # other/glued flags (-F:, -vX=1, -W ...)
    text = " ".join(prog)
    return bool(text) and not any(d in text for d in _AWK_DANGER)


def _sed_dangerous(script: str) -> bool:
    """True if a sed script can write a file or execute a command.

    Walks the script skipping addresses and s///,y/// bodies so the command letters
    w/W/r/R/e (write-file, read-file, execute) and the s/// e/w flags are only matched in
    command position. Biased to refuse: any parse ambiguity leaves more text to scan, which
    can only add refusals, never allows.
    """
    i, n = 0, len(script)
    while i < n:
        c = script[i]
        if c in " \t\n;{}!" or c.isdigit() or c in "$,~+-":
            i += 1  # separators / line addresses
            continue
        if c == "/":  # /regex/ address
            i += 1
            while i < n and script[i] != "/":
                i += 2 if script[i] == "\\" else 1
            i += 1
            continue
        if c == "\\" and i + 1 < n:  # \cregexc address (custom delim)
            delim = script[i + 1]
            i += 2
            while i < n and script[i] != delim:
                i += 2 if script[i] == "\\" else 1
            i += 1
            continue
        if c in ("s", "y"):  # s<d>..<d>..<d>flags / y<d>..<d>..<d>
            if i + 1 >= n:
                return True
            delim = script[i + 1]
            i += 2
            fields = 0
            while i < n and fields < 2:
                if script[i] == "\\":
                    i += 2
                    continue
                if script[i] == delim:
                    fields += 1
                i += 1
            flags = ""
            while i < n and script[i] not in " \t\n;}":
                flags += script[i]
                i += 1
            if c == "s" and ("e" in flags or "w" in flags):
                return True  # s///e executes, s///w writes
            continue
        if c in ("w", "W", "r", "R", "e"):
            return True  # write-file / read-file / execute
        i += 1  # p d n g h x b t : = l q c a i z ...
    return False


def sed_readonly(argv: list[str]) -> bool:
    script: list[str] = []
    saw_script = False
    i, n = 1, len(argv)
    while i < n:
        a = argv[i]
        if a == "--":
            i += 1
            if not saw_script and i < n:
                script.append(argv[i])
                saw_script = True
                i += 1
            break
        if a.startswith("-") and a != "-":
            if a.startswith("-i") or a.startswith("--in-place"):
                return False  # in-place edit writes
            if a == "-f" or a == "--file" or a.startswith("--file="):
                return False  # program file (uninspectable)
            if a in ("-e", "--expression"):
                if i + 1 >= n:
                    return False
                script.append(argv[i + 1])
                saw_script = True
                i += 2
                continue
            if a.startswith("-e"):
                script.append(a[2:])
                saw_script = True
                i += 1
                continue
            if a.startswith("--expression="):
                script.append(a.split("=", 1)[1])
                saw_script = True
                i += 1
                continue
            i += 1  # safe flags: -n -E -r -s -z ...
            continue
        if not saw_script:  # first positional is the script
            script.append(a)
            saw_script = True
        i += 1  # later positionals are input files
    return saw_script and not _sed_dangerous("\n".join(script))


# Package-manager / host-query guards. The same binaries query read-only but mutate under
# install/remove/etc. actions, so each is gated to its read-only forms. The always-read-only
# query tools (apt-cache, dpkg-query, lsb_release, mailq) sit in REMOTE_READONLY_VERBS.

# dpkg: an action flag selects the mode. Allow only when a read-only action is present and no
# mutating action (-i/--install, -r/--remove, -P/--purge, --configure, --unpack,
# --set-selections, ...) appears.
_DPKG_READ = frozenset(
    {
        "-l",
        "--list",
        "-L",
        "--listfiles",
        "-s",
        "--status",
        "-p",
        "--print-avail",
        "-S",
        "--search",
        "-V",
        "--verify",
        "-C",
        "--audit",
        "--get-selections",
        "--print-architecture",
        "--print-foreign-architectures",
    }
)
_DPKG_WRITE = frozenset(
    {
        "-i",
        "--install",
        "--unpack",
        "--configure",
        "-r",
        "--remove",
        "-P",
        "--purge",
        "-A",
        "--record-avail",
        "--update-avail",
        "--merge-avail",
        "--clear-avail",
        "--set-selections",
        "--clear-selections",
        "--forget-old-unavail",
        "--add-architecture",
        "--remove-architecture",
        "--triggers-only",
    }
)


def dpkg_readonly(argv: list[str]) -> bool:
    saw_read = False
    for a in argv[1:]:
        key = a.split("=", 1)[0]
        if key in _DPKG_WRITE:
            return False
        if key in _DPKG_READ:
            saw_read = True
    return saw_read


# apt: the first non-option token is the subcommand; allow only query ones.
_APT_READ = frozenset(
    {"list", "show", "search", "policy", "depends", "rdepends", "showsrc", "madison", "moo"}
)
_APT_SKIP_VALUE = frozenset({"-o", "--option", "-c", "--config-file", "-t", "--target-release"})


def apt_readonly(argv: list[str]) -> bool:
    i, n = 1, len(argv)
    while i < n:
        a = argv[i]
        if a in _APT_SKIP_VALUE:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        return a in _APT_READ
    return False


_APT_MARK_READ = frozenset({"showmanual", "showauto", "showhold", "showinstall"})


def apt_mark_readonly(argv: list[str]) -> bool:
    for a in argv[1:]:
        if a.startswith("-"):
            continue
        return a in _APT_MARK_READ
    return False


_PIPX_READ = frozenset({"list", "environment"})


def pipx_readonly(argv: list[str]) -> bool:
    for a in argv[1:]:
        if a == "--version":
            return True
        if a.startswith("-"):
            continue
        return a in _PIPX_READ
    return False


def crontab_readonly(argv: list[str]) -> bool:
    # Read-only ONLY as `crontab -l`. `-r` deletes, `-e`/`-i` edit, and a bare file argument
    # (or bare `crontab` reading stdin) installs a new crontab.
    saw_list = False
    i, n = 1, len(argv)
    while i < n:
        a = argv[i]
        if a == "-l":
            saw_list = True
            i += 1
        elif a == "-u":
            i += 2  # -u USER takes a value
        else:
            return False
    return saw_list


# Flag-guarded readers (server #2078): verbs that read under every argument but a few, each
# named as its long options plus the letters that mean the same inside a short cluster
# (`-xKy`, `-xCy`). A long option matches on its name, before any `=`. Until #2078 these were
# regex arms in `checks/remote.py` that ran on the joined remote text BEFORE the table lookup,
# with the verb itself listed bare in `REMOTE_READONLY_VERBS` — so `remote_argv_readonly`,
# the half the server repo replays its vectors through, answered True for `dmesg -C`, and
# nothing kept the two sides' copies agreeing. As `GUARDS` entries they sit under that replay.
_FLAG_MUTATES: dict[str, tuple[tuple[str, ...], str]] = {
    # -K/--kill closes sockets (server #1898).
    "ss": (("--kill",), "K"),
    # -s/--set writes the config back to the hardware.
    "sensors": (("--set",), "s"),
    # -C/--clear clears the ring buffer, -c/--read-clear prints then clears. -n/--console-level,
    # -D/--console-off and -E/--console-on change what the kernel logs to the console; they
    # need CAP_SYSLOG, which the homelab's `sudo` deny withholds, so the exposure there is
    # nil — but the guard is the verb's write surface, not one fleet's.
    "dmesg": (
        ("--clear", "--read-clear", "--console-level", "--console-off", "--console-on"),
        "CcnDE",
    ),
}


def _flag_guarded(verb: str) -> Callable[[list[str]], bool]:
    longs, letters = _FLAG_MUTATES[verb]
    cluster = re.compile(rf"-[a-zA-Z]*[{letters}]")

    def guard(argv: list[str]) -> bool:
        return not any(a.split("=", 1)[0] in longs or cluster.match(a) for a in argv[1:])

    return guard


# journalctl reads logs, but these flags delete, rotate or reconfigure the journal.
_JOURNALCTL_WRITE = frozenset(
    {
        "--rotate",
        "--vacuum-size",
        "--vacuum-time",
        "--vacuum-files",
        "--flush",
        "--sync",
        "--relinquish-var",
        "--smart-relinquish-var",
        "--update-catalog",
        "--setup-keys",
    }
)


def journalctl_readonly(argv: list[str]) -> bool:
    return not any(a.split("=", 1)[0] in _JOURNALCTL_WRITE for a in argv[1:])


# rg's `--pre` runs an arbitrary preprocessor per file and `--hostname-bin` an arbitrary
# binary.
_RG_EXEC = frozenset({"--pre", "--hostname-bin"})


def rg_readonly(argv: list[str]) -> bool:
    return not any(a.split("=", 1)[0] in _RG_EXEC for a in argv[1:])


# nvidia-smi's write surface (`-pm`, `-pl`, `-r`, `-ac`, `mig`, `drain`, ...) is long and
# grows, so only the query forms are listed and every other argument refuses (server #1898).
# Until dotfiles #559 this was an inline arm of `readonly_remote_safe` that ran before the
# table lookup, with the verb listed bare in `_REMOTE_ONLY` — so `remote_argv_readonly`
# answered True for `nvidia-smi -pm 1`, the shape `dmesg -C` had before server #2078.
_NVIDIA_SMI_READ_FLAGS = frozenset(
    {"-q", "-L", "--list-gpus", "-x", "--xml-format", "-u", "--unit"}
)
_NVIDIA_SMI_READ_VALUED = ("-i", "--id", "-d", "--display", "-l", "--loop", "-f", "--filename")
_NVIDIA_SMI_READ_PREFIX = ("--query-", "--format=", "--id=", "--display=", "--loop=")


def nvidia_smi_readonly(argv: list[str]) -> bool:
    """True only when every argument is a query flag. `-f FILE` writes the report to a file,
    so it is refused with the rest; a subcommand word (`topo`, `mig`, `drain`) refuses too —
    some are reads, but the write ones sit beside them and this list is the safe side."""
    skip = False
    for a in argv[1:]:
        if skip:
            skip = False
            continue
        if a in _NVIDIA_SMI_READ_FLAGS or a.startswith(_NVIDIA_SMI_READ_PREFIX):
            continue
        if a in _NVIDIA_SMI_READ_VALUED and a not in ("-f", "--filename"):
            skip = True
            continue
        return False
    return not skip


GUARDS: dict[str, Callable[[list[str]], bool]] = {
    "git": git_readonly,
    "find": find_readonly,
    "sort": sort_readonly,
    "uniq": uniq_readonly,
    "awk": awk_readonly,
    "gawk": awk_readonly,
    "mawk": awk_readonly,
    "sed": sed_readonly,
    "dpkg": dpkg_readonly,
    "apt": apt_readonly,
    "apt-mark": apt_mark_readonly,
    "pipx": pipx_readonly,
    "crontab": crontab_readonly,
    "journalctl": journalctl_readonly,
    "rg": rg_readonly,
    "ss": _flag_guarded("ss"),
    "sensors": _flag_guarded("sensors"),
    "dmesg": _flag_guarded("dmesg"),
    "nvidia-smi": nvidia_smi_readonly,
}
