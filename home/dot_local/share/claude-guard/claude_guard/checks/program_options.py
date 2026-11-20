"""Options that hand an allow-listed command a program to run.

An allow rule such as `Bash(man:*)` or `Bash(go test:*)` approves the command whatever its
options are, and each command below has an option whose value it executes:

    man -P CMD, --pager=CMD, -H CMD, --html=CMD     the pager or browser
    go test -exec CMD, go build -toolexec CMD,      the program that runs each test binary,
    go vet -vettool=CMD                             each toolchain step, or the analysis
    uv run https://…                                a script uv downloads and then runs

`program_option` returns a reason when a command carries one. The guard does not read the
program the option names, so the form is refused and the reason says how to run the
command without it.
"""

import posixpath
import re
import shlex

from claude_guard.segment import parse

RULE = "program-option"

_MAN = re.compile(r"-[A-Za-z]*[PH].*|--(pager|html)(=.*)?")
_GO = re.compile(r"--?(exec|toolexec|vettool)(=.*)?")
_URL = re.compile(r"https?://", re.IGNORECASE)
_UV_RUN_VALUE_OPTS = frozenset(
    {
        "--with", "--with-editable", "--with-requirements", "--python", "-p", "--project",
        "--directory", "--env-file", "--extra", "--group", "--package", "--index",
        "--default-index", "--config-file", "--cache-dir", "-w", "-m", "--module",
    }
)  # fmt: skip
_LEADERS = frozenset({"env", "command", "nohup", "time", "nice", "timeout", "stdbuf", "xargs"})


def _reason(argv: list[str]) -> str | None:
    name = posixpath.basename(argv[0])
    args = argv[1:]
    if name == "man" and any(_MAN.fullmatch(a) for a in args):
        return "`man` runs the pager or browser its option names. Run `man` without it."
    if name == "go" and any(_GO.fullmatch(a) for a in args):
        return (
            "`go` runs the program that `-exec`, `-toolexec` or `-vettool` names. Run the "
            "go command without that option."
        )
    if name == "uv" and "run" in args:
        i = args.index("run") + 1
        while i < len(args) and args[i].startswith("-") and args[i] != "--":
            i += 2 if args[i] in _UV_RUN_VALUE_OPTS else 1
        if i < len(args) and args[i] == "--":
            i += 1
        if i < len(args) and _URL.match(args[i]):
            return (
                "`uv run <URL>` downloads a script and runs it. Download the file, read it, "
                "then run the local copy."
            )
    return None


def program_option(command: str) -> str | None:
    """Why `command` is refused, or None: one of its commands carries an option whose value
    it runs as a program. A command is read behind `env`, `timeout` and the other leaders
    that exec their arguments."""
    if not any(word in command for word in ("man", "go", "uv")):
        return None
    p = parse(command)
    if not p.ok:
        return None
    for text in [seg.text for seg in p.segments] + list(p.substitutions):
        try:
            words = shlex.split(text)
        except ValueError:
            continue
        for i, w in enumerate(words):
            name = posixpath.basename(w)
            led = all(
                posixpath.basename(x) in _LEADERS or "=" in x or x[:1] == "-" or x[:1].isdigit()
                for x in words[:i]
            )
            if name in ("man", "go", "uv") and led:
                reason = _reason(words[i:])
                if reason:
                    return f"Blocked: {reason}"
    return None
