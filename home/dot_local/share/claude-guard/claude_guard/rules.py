"""Permission rules read from the DEPLOYED settings files, as allow-compound-bash.sh reads them.

Scope asymmetry (allow-compound-bash.sh:13-26): a project's own settings may only TIGHTEN
what is auto-approved. deny and ask are read from every file in scope; allow comes from the
user-level settings ALONE. Otherwise any repo could ship a .claude/settings.json granting
itself whatever it liked, and opening it would turn those grants into unprompted approvals.

Two rule classes (:76-95): the extraction strips only a TRAILING wildcard, so a `*` still
present is interior or leading. Those deny/ask rules are globs (`git commit *--no-verify`,
`* | sh`). Allow rules never glob — activating their dead wildcards would WIDEN approval,
and widening is the owner's call.

Settings paths are overridable so tests can point at a temp HOME the way the node suites
do: CLAUDE_GUARD_SETTINGS_HOME beats HOME; CLAUDE_PROJECT_DIR names the project, as the
bash reads it (:22-26).
"""

import fnmatch
import json
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

USER_SETTINGS = ".claude/settings.json"
PROJECT_SETTINGS = (".claude/settings.json", ".claude/settings.local.json")


def _read_settings(path: Path) -> object:
    """The file's JSON, or None when it is missing or unparseable (jq's 2>/dev/null, :69)."""
    try:
        return json.loads(path.read_text())
    except OSError, ValueError:
        return None


def extract_bash_prefixes(settings: object, field: str) -> list[str]:
    """allow-compound-bash.sh:63-71, the jq filter, in order.

    Keep only `Bash(` entries, drop the wrapper and the closing paren, then strip a trailing
    `:*`, then a trailing ` *`, then a trailing `*`. Sequential, as jq's gsub chain is:
    `Bash(gh api *-f *)` ends as `gh api *-f`, with its interior wildcard intact.
    """
    if not isinstance(settings, dict):
        return []
    perms = settings.get("permissions")
    if not isinstance(perms, dict):
        return []
    entries = perms.get(field)
    if not isinstance(entries, list):
        return []
    out: list[str] = []
    for entry in entries:
        if not isinstance(entry, str) or not entry.startswith("Bash("):
            continue
        s = entry.removeprefix("Bash(").removesuffix(")")
        s = s.removesuffix(":*")
        s = s.removesuffix(" *")
        s = s.removesuffix("*")
        if s:
            out.append(s)
    return out


def matches_any(cmd: str, patterns: Iterable[str]) -> bool:
    """allow-compound-bash.sh:144-152: exact, or the prefix followed by a space or a slash."""
    return any(cmd == p or cmd.startswith(p + " ") or cmd.startswith(p + "/") for p in patterns)


def matches_glob(cmd: str, patterns: Iterable[str]) -> bool:
    """allow-compound-bash.sh:158-166: `[[ $cmd == $p || $cmd == $p* ]]`, the RHS a pattern."""
    return any(fnmatch.fnmatchcase(cmd, p) or fnmatch.fnmatchcase(cmd, p + "*") for p in patterns)


@dataclass(frozen=True, slots=True)
class Rules:
    allow: tuple[str, ...]
    deny: tuple[str, ...]
    deny_glob: tuple[str, ...]
    ask: tuple[str, ...]
    ask_glob: tuple[str, ...]

    def allows(self, segment: str) -> bool:
        return matches_any(segment, self.allow)

    def denies(self, segment: str) -> bool:
        return matches_any(segment, self.deny) or matches_glob(segment, self.deny_glob)

    def asks(self, segment: str) -> bool:
        return matches_any(segment, self.ask) or matches_glob(segment, self.ask_glob)

    def whole_glob_defer(self, command: str) -> bool:
        """:272-281. Glob rules are tested against the UNSPLIT command as well: the splitter
        consumes `|`, so a rule written across a pipe is only ever intact here."""
        return matches_glob(command, self.deny_glob) or matches_glob(command, self.ask_glob)


def _split_classes(prefixes: list[str]) -> tuple[tuple[str, ...], tuple[str, ...]]:
    plain = tuple(p for p in prefixes if "*" not in p)
    globs = tuple(p for p in prefixes if "*" in p)
    return plain, globs


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

    def gather(field: str, files: list[Path]) -> list[str]:
        out: list[str] = []
        for f in files:
            out += extract_bash_prefixes(_read_settings(f), field)
        return out

    allow = tuple(gather("allow", user_files))
    deny, deny_glob = _split_classes(gather("deny", all_files))
    ask, ask_glob = _split_classes(gather("ask", all_files))
    return Rules(allow, deny, deny_glob, ask, ask_glob)
