"""The one table of secret paths, and the three deny lists rendered from it.

`secret_paths.json` beside this module declares each secret once, in every dialect that
refuses it: `bash_re` fragments for `deny.SECRET_PATHS` (the Bash tool), `case_arms` and a
`message` for protect-secrets.sh (Read, Edit, Write and NotebookEdit), and `read_globs` and
`edit_globs` for the Read()/Edit() denies in settings.permissions.json. An entry may leave a
dialect empty; an empty dialect is a gap to see in one place, not a fourth list.

deny.py reads the table at import. The other two consumers are not: the hook stays a
jq-only script, and its arms live in the hook file, under the ask-listed `~/.claude/hooks/**`
rather than in this package, which nothing protects from an Edit. The settings template is
parsed as JSON by claude-guard's own tests once its comments are stripped, so it cannot
carry a template loop. Both files hold their entries as a generated block between markers,
written by:

    python -m claude_guard.secret_table          # rewrite both blocks from the table
    python -m claude_guard.secret_table --check  # exit 1 if either block has drifted

Run it from the chezmoi source tree; the deployed package has no hook or template beside it.
"""

import json
import sys
from pathlib import Path

TABLE = Path(__file__).with_name("secret_paths.json")
# home/ in the chezmoi source tree: claude_guard → claude-guard → share → dot_local → home.
SOURCE_HOME = Path(__file__).resolve().parents[4]
HOOK = SOURCE_HOME / "private_dot_claude" / "hooks" / "executable_protect-secrets.sh"
SETTINGS = SOURCE_HOME / ".chezmoitemplates" / "settings.permissions.json"

HOOK_BEGIN = "  # BEGIN secret arms, generated from claude_guard/secret_paths.json"
HOOK_END = "  # END secret arms"
SETTINGS_BEGIN = (
    "      {{/* BEGIN secret Read/Edit denies, generated from "
    "claude_guard/secret_paths.json by claude_guard.secret_table */}}"
)
SETTINGS_END = "      {{/* END secret Read/Edit denies */}}"
# A case pattern is written unquoted and a message inside double quotes, so neither may hold
# a character the shell would read as anything but text there.
_PATTERN_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-/*")
_MESSAGE_FORBIDDEN = frozenset('"$`\\\n')


def load() -> list[dict]:
    """The table's entries, in order. The order is the hook's arm order, so it matters."""
    return json.loads(TABLE.read_text())["entries"]


def deny_pattern(entries: list[dict] | None = None) -> str:
    """Every entry's `bash_re` fragments as one alternation group, for `deny.SECRET_PATHS`."""
    entries = load() if entries is None else entries
    return "(" + "|".join(f for e in entries for f in e["bash_re"]) + ")"


def hook_block(entries: list[dict]) -> str:
    """The generated case arms for protect-secrets.sh, markers included."""
    lines = [HOOK_BEGIN, "  # Edit the table and re-run claude_guard.secret_table, not these arms."]
    for e in entries:
        if not e.get("case_arms"):
            continue
        for pattern in e["case_arms"]:
            if not set(pattern) <= _PATTERN_CHARS:
                raise ValueError(f"{e['id']}: case pattern {pattern!r} needs quoting")
        if set(e["message"]) & _MESSAGE_FORBIDDEN:
            raise ValueError(f"{e['id']}: message holds a character the shell would expand")
        lines.append(f"  # {e['id']}: {e['why']}")
        lines.append(f"  {'|'.join(e['case_arms'])})")
        if e.get("read_exempts_env_templates"):
            lines.append("    is_env_template_read ||")
            lines.append(f'      deny "{e["message"]}"')
        else:
            lines.append(f'    deny "{e["message"]}"')
        lines.append("    ;;")
    lines.append(HOOK_END)
    return "\n".join(lines)


def settings_block(entries: list[dict]) -> str:
    """The generated deny rules for settings.permissions.json, markers included. Every rule
    ends in a comma, so the block must not be the last thing in the deny array."""
    lines = [SETTINGS_BEGIN]
    for e in entries:
        for tool, key in (("Read", "read_globs"), ("Edit", "edit_globs")):
            for glob in e[key]:
                rule = json.dumps(f"{tool}({glob})", ensure_ascii=False)
                if "{{" in rule or "}}" in rule:
                    raise ValueError(f"{e['id']}: {rule} would read as template syntax")
                lines.append(f"      {rule},")
    lines.append(SETTINGS_END)
    return "\n".join(lines)


def _splice(text: str, begin: str, end: str, block: str, name: str) -> str:
    if text.count(begin) != 1 or text.count(end) != 1:
        raise ValueError(f"{name}: expected one BEGIN and one END marker")
    head, rest = text.split(begin, 1)
    _old, tail = rest.split(end, 1)
    return head + block + tail


def render() -> dict[Path, str]:
    """Each consumer file's text with its block regenerated from the table."""
    entries = load()
    return {
        HOOK: _splice(HOOK.read_text(), HOOK_BEGIN, HOOK_END, hook_block(entries), HOOK.name),
        SETTINGS: _splice(
            SETTINGS.read_text(),
            SETTINGS_BEGIN,
            SETTINGS_END,
            settings_block(entries),
            SETTINGS.name,
        ),
    }


def main(argv: list[str]) -> int:
    check = argv == ["--check"]
    if argv and not check:
        print("usage: python -m claude_guard.secret_table [--check]", file=sys.stderr)
        return 2
    if not HOOK.exists():
        print(f"secret_table: {HOOK} not found; run from the chezmoi source tree", file=sys.stderr)
        return 2
    drifted = []
    for path, text in render().items():
        if path.read_text() == text:
            continue
        drifted.append(path)
        if not check:
            path.write_text(text)
    for path in drifted:
        verb = "out of date" if check else "rewrote"
        print(f"secret_table: {verb}: {path}", file=sys.stderr)
    return 1 if check and drifted else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
