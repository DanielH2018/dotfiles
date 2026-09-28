"""Permission rules read from the DEPLOYED settings files, parsed the way Claude Code parses them.

Scope asymmetry (allow-compound-bash.sh:13-26): a project's own settings may only TIGHTEN
what is auto-approved. deny and ask are read from every file in scope; allow comes from the
user-level settings ALONE. Otherwise any repo could ship a .claude/settings.json granting
itself whatever it liked, and opening it would turn those grants into unprompted approvals.

The rule grammar is Claude Code's own (dotfiles #714), read from the 2.1.283 bundle rather
than from the retired bash hook. `parse_rule` and `_wildcard_regex` port the bundle's
rule-content parser (`bUe`/`Pjr`), its classifier (`Kmn`, with `Fye` and `k1r`) and its
wildcard compiler (`h6`, called for Bash as `h6(pattern, command, false, true)`):

- `Bash` bare, `Bash()` and `Bash(*)` cover every command.
- Content ending in `:*` is a PREFIX. The text before it is literal, a `*` in it included,
  and it matches the command itself or the command followed by a space.
- Otherwise content holding a `*` not escaped by a backslash is a WILDCARD. `*` matches any
  run of characters, newlines included; the match is anchored at both ends; `\\*` is a
  literal star and `\\\\` a literal backslash; `/**/` also matches a single `/`. A pattern
  whose only `*` is a trailing ` *` also matches the command without it. A `:*` that is
  not at the end is a wildcard with a literal `:`.
- Anything else is EXACT: the whole command, character for character.
- Prefix and wildcard matching collapse each run of spaces and tabs to one space, in the
  rule and the command both. Matching is case-sensitive.
- Claude Code also tests a prefix rule, and a deny/ask wildcard, against the command with
  a leading `xargs ` (the `xargs <rule>` arm of its Bash matcher `Fq`).

How each class uses that grammar is set by what a mismatch costs. This module feeds the
PermissionRequest judge, which only ever turns a prompt into an approval:

- deny and ask must match AT LEAST what Claude Code matches. A command Claude Code asks
  about that the guard's copy misses is one the judge can approve. Each deny/ask rule is
  therefore matched as Claude Code matches it, widened in three ways that only ever make
  the judge defer: an exact rule also matches as a prefix, a prefix also ends at a `/`,
  and a wildcard also matches when it matches the command's first N whole words. The last
  stands in for the redirection stripping Claude Code does before matching (`rve`), which
  the guard does not do: `find * -delete` must still catch `find . -delete 2>/dev/null`.
- allow must match AT MOST what Claude Code matches. Exact is exact, a prefix ends only at
  a space, and a wildcard counts only when its sole `*` is a trailing ` *`, where it is
  the same set as a prefix. Any other allow wildcard, and the `xargs <prefix>` arm, would
  widen what the judge approves beyond what the guard approved before, and widening is the
  owner's call; they are left unmatched.

Settings paths are overridable so tests can point at a temp HOME the way the node suites
do: CLAUDE_GUARD_SETTINGS_HOME beats HOME; CLAUDE_PROJECT_DIR names the project, as the
bash reads it (:22-26).
"""

import json
import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

USER_SETTINGS = ".claude/settings.json"
PROJECT_SETTINGS = (".claude/settings.json", ".claude/settings.local.json")

Kind = Literal["all", "exact", "prefix", "wildcard"]
Behavior = Literal["allow", "deny", "ask"]

# h6's placeholders, and the characters it backslash-escapes before compiling.
_ESC_STAR = "\x00ESCAPED_STAR\x00"
_ESC_BACKSLASH = "\x00ESCAPED_BACKSLASH\x00"
_GLOBSTAR = "\x00GLOBSTAR\x00"
_REGEX_SPECIAL = re.compile(r"""[.+?^${}()|\[\]\\'"]""")
_GLOBSTAR_RUN = re.compile(r"/(?:\*\*/)+")
_BLANKS = re.compile(r"[ \t]+")
# Fye's `^(.+):\*$`. A JS `.` stops at these four line terminators.
_PREFIX_FORM = re.compile("([^\n\r  ]+):\\*")


def _escaped(s: str, i: int) -> bool:
    """True when s[i] is preceded by an odd number of backslashes (the bundle's `wi`)."""
    n = 0
    j = i - 1
    while j >= 0 and s[j] == "\\":
        n += 1
        j -= 1
    return n % 2 == 1


def _has_unescaped_star(s: str) -> bool:
    return any(c == "*" and not _escaped(s, i) for i, c in enumerate(s))


def _collapse(s: str) -> str:
    return _BLANKS.sub(" ", s)


def _wildcard_regex(pattern: str) -> re.Pattern[str] | None:
    """h6's pattern compiler with whitespace collapsing on. None for a pattern holding NUL,
    which h6 refuses to match."""
    if "\x00" in pattern:
        return None
    d = _collapse(pattern.strip())
    p: list[str] = []
    i = 0
    while i < len(d):
        c = d[i]
        if c == "\\" and i + 1 < len(d) and d[i + 1] in "*\\":
            p.append(_ESC_STAR if d[i + 1] == "*" else _ESC_BACKSLASH)
            i += 2
            continue
        p.append(c)
        i += 1
    text = "".join(p)
    y = _REGEX_SPECIAL.sub(lambda m: "\\" + m.group(0), text)
    y = _GLOBSTAR_RUN.sub(_GLOBSTAR, y)
    y = y.replace("*", ".*").replace(_GLOBSTAR, "/(?:.*/)?")
    y = y.replace(_ESC_STAR, "\\*").replace(_ESC_BACKSLASH, "\\\\")
    if y.endswith(" .*") and text.count("*") == 1:
        y = y[:-3] + "( .*)?"
    return re.compile(y, re.DOTALL)


@dataclass(frozen=True, slots=True)
class Rule:
    """One Bash rule. `text` is the exact command, the prefix, or the wildcard pattern."""

    kind: Kind
    text: str
    _regex: re.Pattern[str] | None = field(default=None, compare=False, repr=False)
    _xargs_regex: re.Pattern[str] | None = field(default=None, compare=False, repr=False)

    @property
    def sole_trailing_space_star(self) -> bool:
        """A wildcard whose only `*` is a trailing ` *`: the same set as a prefix."""
        t = _collapse(self.text.strip())
        return self.kind == "wildcard" and t.endswith(" *") and t.count("*") == 1

    def cc_matches(self, cmd: str, behavior: Behavior) -> bool:
        """Claude Code's decision for one candidate command (the rule arm of `Fq`)."""
        if self.kind == "all":
            return True
        if self.kind == "exact":
            return cmd == self.text
        c = _collapse(cmd)
        if self.kind == "prefix":
            t = _collapse(self.text)
            x = "xargs " + t
            return c in (t, x) or c.startswith((t + " ", x + " "))
        if self._regex is None:
            return False
        if self._regex.fullmatch(c):
            return True
        # A5n: an allow wildcard takes the xargs arm only when it ends in an unescaped `*`.
        t = self.text.rstrip()
        if behavior == "allow" and not (t.endswith("*") and not _escaped(t, len(t) - 1)):
            return False
        return self._xargs_regex is not None and bool(self._xargs_regex.fullmatch(c))

    def covers(self, cmd: str) -> bool:
        """deny/ask: at least `cc_matches`. See the module docstring for the three widenings."""
        if self.kind == "all":
            return True
        c = _collapse(cmd)
        if self.kind in ("exact", "prefix"):
            t = _collapse(self.text)
            return any(
                c == s or c.startswith(s + " ") or c.startswith(s + "/") for s in (t, "xargs " + t)
            )
        # The command, and each of its leading runs of whole words: `find . -delete` out of
        # `find . -delete 2>/dev/null`. Never a cut inside a word, so `rm -rf / *` stays
        # clear of `rm -rf /home/x`. A regex that matches no leading slice at all
        # (`r.match`) cannot match a leading run of words, so it is ruled out first.
        live = [r for r in (self._regex, self._xargs_regex) if r is not None and r.match(c)]
        if not live:
            return False
        heads = [c[:i] for i, ch in enumerate(c) if ch == " "] + [c]
        return any(r.fullmatch(h) for r in live for h in heads)

    def grants(self, cmd: str) -> bool:
        """allow: at most `cc_matches`. See the module docstring for what is left out."""
        if self.kind == "all" or self.kind == "exact":
            return self.kind == "all" or cmd == self.text
        c = _collapse(cmd)
        if self.kind == "prefix":
            t = _collapse(self.text)
            return c == t or c.startswith(t + " ")
        return (
            self.sole_trailing_space_star
            and self._regex is not None
            and bool(self._regex.fullmatch(c))
        )


def parse_rule(content: str | None) -> Rule:
    """Claude Code's classification of a Bash rule's content (`Kmn`). None, "" and "*" are
    the tool-wide rule, as `Jn` reads them."""
    if content is None or content in ("", "*"):
        return Rule("all", "")
    m = _PREFIX_FORM.fullmatch(content)
    if m:
        return Rule("prefix", m.group(1))
    if not content.endswith(":*") and _has_unescaped_star(content):
        return Rule(
            "wildcard",
            content,
            _wildcard_regex(content),
            _wildcard_regex("xargs " + content),
        )
    return Rule("exact", content)


def bash_rule_content(entry: str) -> str | None | Literal[False]:
    """The content of a `Bash` rule string as `bUe` and `Pjr` read it: None for a bare
    `Bash`, False for anything that is not a well-formed Bash rule. `\\(` and `\\)` become
    parentheses, then `\\\\` becomes one backslash."""
    if entry == "Bash":
        return None
    open_at = next((i for i, c in enumerate(entry) if c == "(" and not _escaped(entry, i)), -1)
    close_at = max(
        (i for i, c in enumerate(entry) if c == ")" and not _escaped(entry, i)), default=-1
    )
    if open_at == -1 or close_at <= open_at or close_at != len(entry) - 1:
        return False
    if entry[:open_at] != "Bash":
        return False
    raw = entry[open_at + 1 : close_at]
    return raw.replace("\\(", "(").replace("\\)", ")").replace("\\\\", "\\")


def _read_settings(path: Path) -> object:
    """The file's JSON, or None when it is missing or unparseable (jq's 2>/dev/null, :69)."""
    try:
        return json.loads(path.read_text())
    except OSError, ValueError:
        return None


def extract_bash_rules(settings: object, field_name: str) -> list[Rule]:
    """Every Bash rule in `permissions.<field_name>`, parsed. Other tools' rules are skipped."""
    if not isinstance(settings, dict):
        return []
    perms = settings.get("permissions")
    if not isinstance(perms, dict):
        return []
    entries = perms.get(field_name)
    if not isinstance(entries, list):
        return []
    out: list[Rule] = []
    for entry in entries:
        if not isinstance(entry, str):
            continue
        content = bash_rule_content(entry)
        if content is not False:
            out.append(parse_rule(content))
    return out


def covered(cmd: str, rules: Iterable[Rule]) -> bool:
    return any(r.covers(cmd) for r in rules)


def granted(cmd: str, rules: Iterable[Rule]) -> bool:
    return any(r.grants(cmd) for r in rules)


@dataclass(frozen=True, slots=True)
class Rules:
    allow: tuple[Rule, ...]
    deny: tuple[Rule, ...]
    ask: tuple[Rule, ...]

    def allows(self, segment: str) -> bool:
        return granted(segment, self.allow)

    def denies(self, segment: str) -> bool:
        return covered(segment, self.deny)

    def asks(self, segment: str) -> bool:
        return covered(segment, self.ask)

    def whole_glob_defer(self, command: str) -> bool:
        """:272-281. Deny and ask wildcards are tested against the UNSPLIT command as well,
        as Claude Code tests them (`skipCompoundCheck` is true for both): the splitter
        consumes `|`, so a rule written across a pipe is only ever intact here."""
        return any(r.kind == "wildcard" and r.covers(command) for r in (*self.deny, *self.ask))


def load_rules(
    home: str | None = None,
    project_dir: str | None = None,
    env: Mapping[str, str] | None = None,
) -> Rules:
    e = os.environ if env is None else env
    if home is None:
        home = e.get("CLAUDE_GUARD_SETTINGS_HOME") or e.get("HOME", "")
    if project_dir is None:
        project_dir = e.get("CLAUDE_PROJECT_DIR", "")

    user_files = [Path(home) / USER_SETTINGS]
    all_files = list(user_files)
    if project_dir:
        all_files += [p for rel in PROJECT_SETTINGS if (p := Path(project_dir) / rel).is_file()]

    def gather(field_name: str, files: list[Path]) -> tuple[Rule, ...]:
        out: list[Rule] = []
        for f in files:
            out += extract_bash_rules(_read_settings(f), field_name)
        return tuple(out)

    return Rules(gather("allow", user_files), gather("deny", all_files), gather("ask", all_files))
