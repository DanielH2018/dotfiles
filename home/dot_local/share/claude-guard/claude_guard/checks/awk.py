"""awk programs that run a command or write a file, for the `Bash(awk:*)` allow rule (#702).

The settings allow awk everywhere and deny only `system(`. awk runs a command three more
ways, none of which contains `system`:

    print "x" | "cmd"      output to a command (also `printf`, and `|&`, gawk's coprocess)
    "cmd" | getline x      input from a command
    print "x" | var        either of the above with the command held in a variable

`print > "|cmd"` is not one of them: awk opens a file literally named `|cmd`. It is a file
write, which asks like any other (dotfiles #707): `print > "f"` and `print >> "f"`.

DECIDED (dotfiles #707): a write asks rather than denies. Writing a file is ordinary awk,
and the judge treats a shell `>` redirect the same way: it refuses to auto-approve one
unless it targets /dev/null or duplicates a descriptor. So a target of /dev/stdout,
/dev/stderr, /dev/null or /dev/fd/N writes nothing here either. `_writes` reads a `>` as
a redirect only inside a `print`/`printf` statement at bracket depth 0, which is where
awk's grammar reads it so; `$3 > 100`, `if ($3 > 100) print` and `print ($1 > $2)` compare.

`awk_risk` reads one command and returns ("deny" | "ask", reason) or None. The PreToolUse
hook turns it into a Verdict, because the native allow rule approves a bare awk before any
PermissionRequest hook runs. The judge refuses on either kind, because a PreToolUse ask
raises a dialog and the judge would otherwise auto-approve it through the same allow rule.

DECIDED: the definite forms deny, like the settings' `system(` rule, and only when they sit
in the program's CODE. `_code` blanks string literals to `"S"`, regex literals to `/R/` and
drops comments, so `print $1 " | " $2` and `/(;|&&)/` deny nothing. Any other lone `|` in
the code (not `||`) asks: it is a pipe to a command held in a variable. A program `_code`
cannot lex (an unterminated string or regex) asks when its raw text holds a `|`, `system`,
`getline` or `>`. Measured 2026-09-28 over the 821 distinct awk commands in this host's
transcripts: 813 get no decision, 5 ask (each reads its program with `-f`) and 3 deny (each
runs `date` through `cmd | getline`). Re-measured for #707 over 834: 823 get no decision,
and the 3 new asks are two programs that write files and one `grep -c awk $C`, where a
stray `awk` operand reads as an awk whose program is a shell variable.

The lexer decides regex versus division the way awk's grammar does, by position: `/` opens
a regex only after `(`, `,`, `{`, `}`, `;`, `!`, `~`, `&`, `|`, `=`, `<`, `>`, `?`, `:`, a
newline or the start. After anything else, including `+` and `-` (`x++ / 2`), it is division
and the text after it is read as code, which can only add findings. Bracket expressions are
not special: onetrue awk ends `/[/]/` at the second `/`, and a guard that disagreed with it
could be shown a pipe as regex text. Each disagreement with awk therefore lands on the side
of reading more text as code.

The program is the `-e`/`--source` text when there is any, else the first operand. `-F` and
`-v` values and the operands after the program are data, so `awk -F'|'` stays allowed. A
program the guard cannot read (`-f`, `--exec`, `@include`) asks, and so does a program that
carries a shell command substitution. So does a program that holds a shell parameter
expansion (`$VAR`, `${VAR}`, `$1`) outside single quotes (dotfiles #707): the guard reads
the text before the shell expands it, so the program awk runs is not the one it read.
`_mark_expansions` marks each one before shlex drops the quoting. A backslash-escaped `$`
stays awk's own `$`.
"""

import re
import shlex

from claude_guard.segment import parse

AWK_NAMES = frozenset({"awk", "gawk", "mawk", "nawk"})

_SYSTEM = re.compile(r"\bsystem\s*\(")
_PIPE_FROM = re.compile(r"\|&?\s*getline\b")
_COPROCESS = re.compile(r"\|&")
_PIPE_TO_STRING = re.compile(r"\|\s*\"")
_LONE_PIPE = re.compile(r"(?<!\|)\|(?!\|)")
_INCLUDE = re.compile(r"@(include|load|namespace)\b")

# Short options whose value is data (-F, -v), or the program (-e). gawk's -f/-E read a
# program file, -i includes one, -l loads a library, and -W is mawk's `-W exec FILE`.
_DATA_SHORT = frozenset("Fv")
_HIDDEN_SHORT = frozenset("fEilW")
_DATA_LONG = ("--field-separator", "--assign")
_HIDDEN_LONG = ("--file", "--exec", "--include", "--load")

_NAMES_AWK = re.compile(r"\b[gmn]?awk\b")
# Stands in for a command substitution's body, which awk_risk judges on its own.
_SUBSTITUTED = "\x00substitution\x00"
# Marks a shell parameter expansion (`$VAR`, `${VAR}`, `$1`) outside single quotes (#707).
_EXPANDED = "\x00expansion\x00"
_PARAM_START = re.compile(r"[A-Za-z0-9_{@*]")

# A `print`/`printf` statement, whose `>`/`>>` at bracket depth 0 is an output redirect.
_PRINT = re.compile(r"\bprintf?\b")
# Targets that write no file: awk's special names, and the paths the judge's redirect check
# treats as write-free for a shell redirect. `_code` turns such a literal into `"D"`.
_STREAM = re.compile(r"/dev/(stdout|stderr|null|fd/[0-9]+)")
_STREAM_CODE = '"D"'

UNREADABLE = "this awk command could not be read."
HIDDEN = "the awk program comes from a file, which the guard cannot read."

_REGEX_AFTER = frozenset("(,{};!~&|=<>?:\n")


def _end_of(text: str, i: int, quote: str) -> int | None:
    """The index just past the literal opened at `text[i]`, or None when it is unterminated
    on its line. A backslash escapes the next character in both strings and regexes."""
    j = i + 1
    while j < len(text):
        c = text[j]
        if c == "\\":
            j += 2
            continue
        if c == "\n":
            return None
        if c == quote:
            return j + 1
        j += 1
    return None


def _code(text: str) -> str | None:
    """`text` with string literals as `"S"`, regex literals as `/R/` and comments dropped.
    None when a string or regex is unterminated."""
    out: list[str] = []
    prev = ""  # the last code character that is not a space or tab; "" at the start
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "#":
            nl = text.find("\n", i)
            i = n if nl < 0 else nl
            continue
        if c == '"' or (c == "/" and (prev == "" or prev in _REGEX_AFTER)):
            end = _end_of(text, i, c)
            if end is None:
                return None
            if c == "/":
                out.append("/R/")
            else:
                out.append(_STREAM_CODE if _STREAM.fullmatch(text[i + 1 : end - 1]) else '"S"')
            prev = c
            i = end
            continue
        out.append(c)
        if c not in " \t":
            prev = c
        i += 1
    return "".join(out)


def _writes(code: str) -> bool:
    """`code` (from `_code`) redirects a `print`/`printf` into a file.

    Inside a print statement awk reads a `>` at bracket depth 0 as a redirect, so a
    comparison there needs parentheses (`print ($1 > $2)`); a `>` outside one (`$3 > 100`,
    `if ($3 > 100) print`) compares. The statement ends at `;`, `}` or a newline, which
    `_code` has already removed from strings and regexes. `>=` compares. A target of
    `"D"` (a standard stream or /dev/null) writes no file."""
    for m in _PRINT.finditer(code):
        depth = 0
        i, n = m.end(), len(code)
        while i < n:
            c = code[i]
            if c in "([":
                depth += 1
            elif c in ")]":
                depth -= 1
            elif c in ";}\n" and depth <= 0:
                break
            elif c == ">" and depth == 0:
                j = i + 1
                if code[j : j + 1] == "=":
                    i = j + 1
                    continue
                j += code[j : j + 1] == ">"
                if not code[j:].lstrip(" \t").startswith(_STREAM_CODE):
                    return True
                i = j
                continue
            i += 1
    return False


def _mark_expansions(text: str) -> str:
    """`text` with `_EXPANDED` before each `$` the shell would expand as a parameter:
    outside single quotes and not escaped by a backslash. `$(` is a substitution, which
    awk_risk handles on its own, and `$'...'` is a quoting form."""
    out: list[str] = []
    quote = ""
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\" and quote != "'":
            out.append(text[i : i + 2])
            i += 2
            continue
        if c in "'\"" and quote in ("", c):
            quote = "" if quote == c else c
        elif c == "$" and quote != "'" and _PARAM_START.match(text, i + 1):
            out.append(_EXPANDED)
        out.append(c)
        i += 1
    return "".join(out)


def _is_long(word: str, names: tuple[str, ...]) -> bool:
    """`word` is one of `names`, whole or abbreviated (getopt_long accepts any prefix)."""
    key = word.split("=", 1)[0]
    return len(key) > 2 and any(n.startswith(key) for n in names)


def _awk_argv(words: list[str]) -> list[str] | None:
    """The words from the first awk-named word on, or None when the stage runs no awk.

    Any position, not only the first: a wrapper (`timeout 5 awk`, `command awk`) runs it
    just the same, and a stray `awk` operand to another command reads as an awk with no
    program, which finds nothing."""
    for i, word in enumerate(words):
        if word.rsplit("/", 1)[-1] in AWK_NAMES:
            return words[i:]
    return None


def _programs(argv: list[str]) -> list[str] | str:
    """The program texts of one awk argv, or HIDDEN when the program is in a file."""
    sources: list[str] = []
    i, n = 1, len(argv)
    while i < n:
        a = argv[i]
        if a == "--":
            i += 1
            break
        if not a.startswith("-") or a == "-":
            break
        if a.startswith("--"):
            if _is_long(a, _HIDDEN_LONG):
                return HIDDEN
            value_next = "=" not in a
            if _is_long(a, ("--source",)):
                sources.append(argv[i + 1] if value_next and i + 1 < n else a.split("=", 1)[-1])
            i += 2 if value_next and _is_long(a, (*_DATA_LONG, "--source")) else 1
            continue
        for j, letter in enumerate(a[1:], start=2):
            if letter in _HIDDEN_SHORT:
                return HIDDEN
            if letter in _DATA_SHORT or letter == "e":
                value = a[j:] if j < len(a) else (argv[i + 1] if i + 1 < n else "")
                if letter == "e":
                    sources.append(value)
                i += 0 if j < len(a) else 1
                break
        i += 1
    return sources or argv[i : i + 1]


def argv_risk(argv: list[str]) -> tuple[str, str] | None:
    """The risk of one awk argv (argv[0] is the awk word)."""
    programs = _programs(argv)
    if programs == HIDDEN:
        return "ask", HIDDEN
    for text in programs:
        risk = _program_risk(text)
        if risk:
            return risk
    return None


def _program_risk(text: str) -> tuple[str, str] | None:
    if _SUBSTITUTED in text:
        return "ask", "this awk program is built by a command substitution."
    if _EXPANDED in text:
        return "ask", "the shell expands a variable into this awk program before awk reads it."
    if _INCLUDE.search(text):
        return "ask", "`@include`/`@load` pulls in code the guard cannot read."
    code = _code(text)
    if code is None:
        if any(s in text for s in ("|", "system", "getline", ">")):
            return "ask", "this awk program could not be lexed, and it may run a command."
        return None
    if _SYSTEM.search(code):
        return "deny", "awk's `system()` runs a shell command."
    if _PIPE_FROM.search(code):
        return "deny", "awk's `cmd | getline` runs `cmd` as a shell command."
    if _COPROCESS.search(code):
        return "deny", "awk's `|&` starts a shell command as a coprocess."
    if _PIPE_TO_STRING.search(code):
        return "deny", 'awk\'s `print | "cmd"` pipes into a shell command.'
    if _LONE_PIPE.search(code):
        return "ask", "this awk program pipes into a command held in a variable."
    if _writes(code):
        return "ask", 'this awk program writes a file (`print > "file"`).'
    return None


def segment_risk(text: str) -> tuple[str, str] | None:
    """The risk of one segment's text. A segment naming awk that shlex cannot read asks."""
    try:
        words = shlex.split(_mark_expansions(text))
    except ValueError:
        return ("ask", UNREADABLE) if _NAMES_AWK.search(text) else None
    argv = _awk_argv(words)
    return argv_risk(argv) if argv else None


def awk_risk(command: str) -> tuple[str, str] | None:
    """The strongest risk across `command`'s segments and its substitution bodies. A
    command the segmenter refuses asks when it names awk."""
    parsed = parse(command)
    if not parsed.ok:
        return ("ask", UNREADABLE) if _NAMES_AWK.search(command) else None
    # A substitution body is judged on its own below, so it is replaced in the segment that
    # holds it: otherwise the awk in `x=$(grep d f | awk '{print $2}' | tr -d '"')` reads the
    # rest of the body as its operands, and a program built by one could not be told apart.
    risks = []
    for seg in parsed.segments:
        text = seg.text
        for body in parsed.substitutions:
            text = text.replace(body, _SUBSTITUTED)
        risks.append(segment_risk(text))
    risks += [awk_risk(body) for body in parsed.substitutions]
    found = [r for r in risks if r]
    return next((r for r in found if r[0] == "deny"), found[0] if found else None)
