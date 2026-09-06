# claude-guard slice 2: rules, judge, scratch and curl checks, PermissionRequest shim in shadow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `allow-compound-bash.sh`, `allow-safe-rm.sh` and `allow-safe-curl.sh` into the `claude_guard` package as `rules.py`, `judge.py`, `checks/scratch.py`, `checks/curl.py` and `tables.py`, expose them as a `permission-request` hook subcommand, and register that hook in SHADOW mode beside the bash hooks so several days of live agreement can be measured before slice 3 cuts over.

**Architecture:** `rules.py` reads the deployed settings files with the scope asymmetry the bash documents (allow from user scope only, deny and ask from every scope) and matches exactly as `matches_any`/`matches_glob` do. The two checks are pure functions from one segment to a bool. `judge.py` is a line-for-line port of the compound decision as the bash makes it TODAY: the literal `&&`/`;`/`|` eligibility gate, the whole-command glob defer, the unjudgeable cases (substitution, heredoc, `&` or newline separator), the per-segment redirect/tee/deny/ff-only/curl/rm/ask/allow/wrapper sequence. `hook.py` owns the stdin-to-stdout contract and shadow mode; `cli.py` grows `permission-request`, `shadow-report` and `replay --judge`. One bash shim registers the hook; in shadow it computes a verdict, runs the deployed bash chain on the same stdin, logs one JSON line, and prints nothing.

**Tech Stack:** Python 3.14 (uv-managed interpreter), stdlib only, pytest 8, `uv run --no-project`, node:test for the settings-shape guard, shellcheck for the shim, `bin/config-soak` for the hook-registration ledger.

**Spec:** `docs/specs/2026-09-06-claude-guard-design.md` — Architecture (`rules.py`, `judge.py`, `checks/`, `tables.py`, the shims), Decision flow, Failure contracts, Testing, Rollout row 2, Decisions.

## Global Constraints

- Python 3.14 syntax; stdlib only; no `from __future__`; no `noqa`.
- Edit only the chezmoi source under `home/` in the worktree `/home/ubuntu/.local/share/chezmoi/.claude/worktrees/claude-guard-2` (branch `worktree-claude-guard-2`), plus the repo-level tests, docs and ledger the tasks name. Never `cd` to `/home/ubuntu/.local/share/chezmoi` itself, never `git stash`, never `chezmoi apply`.
- Pytest, from the package directory `home/dot_local/share/claude-guard`: `PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q`.
- Ruff, from the package directory: `uv run --no-project --python 3.14 --with ruff ruff check .`.
- Node: `export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"` before any `node` command. Full suite: `git ls-files '*.test.js' '*.test.mjs' | xargs -r node --test`.
- Commits explain why. No `--no-verify`. Push only in the last task.
- A check that can only pass is not evidence: every rule ships as an `…_is_allowed` / `…_is_refused` pair.
- Ruff enforces `line-length = 100` on tests as well as code (`pyproject.toml`). Where a test line in this plan runs past 100 columns, wrap it: split the call across lines, or split a long string literal into two adjacent literals. Do not shorten a fixture command to fit.
- This slice is a PORT. Every decision `judge.py` makes is the one `executable_allow-compound-bash.sh` makes today, with the bash line cited. The #477 rules (newline as `;`, quoted-heredoc writes, `set -e`/`VAR=`/`timeout` stripping) and the spec's "a single segment is judged like a chain" decision are slice 3, not this one. Today the bash exits without a decision on a command containing none of `&&`, `;`, `|` (`allow-compound-bash.sh:57-59`), so a single segment is NOT judged here.

---

## File structure

| path (under the worktree) | responsibility |
|---|---|
| `home/dot_local/share/claude-guard/claude_guard/tables.py` | `SCRATCH_ROOTS`, `scratch_roots()`, `CURL_HOSTS`; nothing else yet |
| `home/dot_local/share/claude-guard/claude_guard/rules.py` | `Rules`, `load_rules()`, `extract_bash_prefixes()`, `matches_any()`, `matches_glob()` |
| `home/dot_local/share/claude-guard/claude_guard/checks/__init__.py` | empty package marker |
| `home/dot_local/share/claude-guard/claude_guard/checks/scratch.py` | `rm_confined()`: allow-safe-rm.sh ported |
| `home/dot_local/share/claude-guard/claude_guard/checks/curl.py` | `curl_safe()`: allow-safe-curl.sh ported |
| `home/dot_local/share/claude-guard/claude_guard/judge.py` | `Decision`, `judge()`, `judge_segment()`, `unwrap_wrapper()`: allow-compound-bash.sh ported |
| `home/dot_local/share/claude-guard/claude_guard/hook.py` | `permission_request()`: stdin JSON to decision JSON or None; shadow mode, bash chain, the log line |
| `home/dot_local/share/claude-guard/claude_guard/cli.py` (modify) | `permission-request`, `shadow-report`, `replay --judge [--compare-hooks DIR]`, `explain` prints the decision |
| `home/dot_local/share/claude-guard/claude_guard/__init__.py` (modify) | docstring names slice 2 |
| `home/dot_local/share/claude-guard/tests/test_rules.py` | loader and matching, scope asymmetry |
| `home/dot_local/share/claude-guard/tests/test_scratch.py` | `allow-safe-rm.test.js` ported case for case |
| `home/dot_local/share/claude-guard/tests/test_curl.py` | `allow-safe-curl.test.js` ported case for case |
| `home/dot_local/share/claude-guard/tests/test_judge.py` | `allow-compound-bash.test.js` ported case for case |
| `home/dot_local/share/claude-guard/tests/test_hook.py` | the shim end to end with a temp HOME: live, shadow, sampled, failure contract |
| `home/dot_local/share/claude-guard/tests/test_cli.py` (modify) | `replay --judge`, `shadow-report`, `explain` decision line |
| `home/private_dot_claude/hooks/executable_guard-permission-request.sh` | the PermissionRequest shim with the allow-path failure contract |
| `home/.chezmoitemplates/settings.base.json` (modify) | the registration beside the bash hooks; `CLAUDE_GUARD_SHADOW` in `env` |
| `tests/settings/settings-base-shape.test.js` (modify) | the registration and the env var are pinned while the bash hooks are still registered |
| `config-soak.json` (modify, via `node bin/config-soak land`) | the ledger acknowledgement a new hook needs |
| `home/dot_local/share/claude-guard/README.md` (modify) | the judge, shadow mode, `shadow-report`, `replay --judge` |

Why `hook.py` rather than everything in `cli.py`: the hook path has to be testable as a function with an injected stdin, env and hooks directory (the node suites inject HOME and CMDPARSE_LIB the same way), and it must never raise. Putting that contract in its own module keeps `cli.py` an argparse front and keeps subprocess and file-append code out of the judge. The shim still invokes it through `cli.py permission-request`, so there is one entry point as the spec says; argparse import cost is a few milliseconds against a bash chain that forks `jq` several times.

Two tokenizers, on purpose. `allow-safe-rm.sh:71-110` refuses `~` anywhere and refuses a backslash inside double quotes; `allow-safe-curl.sh:87-153` admits `~` mid-word and consumes bash's double-quote escapes. Merging them would change rm's decisions (`rm -rf "/tmp/a\ b"` is refused today). Each check keeps its own, cited, and the merge is a slice-3 policy call.

---

### Task 1: `tables.py` and `rules.py`: the settings loader and the two matchers

**Files:**
- Create: `home/dot_local/share/claude-guard/claude_guard/tables.py`
- Create: `home/dot_local/share/claude-guard/claude_guard/rules.py`
- Create: `home/dot_local/share/claude-guard/tests/test_rules.py`

**Interfaces:**
- Produces:
  - `tables.SCRATCH_ROOTS: tuple[str, ...]` = `("/tmp", "/var/tmp", "~/.claude/jobs", "~/.cache/claude")`; `tables.scratch_roots(home: str, tmpdir: str | None = None) -> tuple[str, ...]` expands `~` and applies the `$TMPDIR` rule; `tables.CURL_HOSTS: tuple[str, ...]`.
  - `rules.Rules(allow, deny, deny_glob, ask, ask_glob)`, frozen, each a `tuple[str, ...]`, with `allows(segment: str) -> bool`, `denies(segment: str) -> bool`, `asks(segment: str) -> bool`, `whole_glob_defer(command: str) -> bool`.
  - `rules.load_rules(home: str | None = None, project_dir: str | None = None, env: Mapping[str, str] | None = None) -> Rules`.
  - `rules.extract_bash_prefixes(settings: object, field: str) -> list[str]`, `rules.matches_any(cmd, patterns) -> bool`, `rules.matches_glob(cmd, patterns) -> bool`.

The reference is `executable_allow-compound-bash.sh:13-95` (scope and extraction), `:144-166` (the two matchers) and `:277-281` (the whole-command glob test).

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/claude-guard/tests/test_rules.py`:

```python
"""The settings loader and the two matchers, ported from allow-compound-bash.sh.

Fixture settings are written to a temp HOME the way tests/hooks/allow-compound-bash.test.js
writes them, so the file-reading path is what is tested, not a dict handed in.
"""

import json
from pathlib import Path

from claude_guard.rules import (
    Rules,
    extract_bash_prefixes,
    load_rules,
    matches_any,
    matches_glob,
)
from claude_guard.tables import CURL_HOSTS, SCRATCH_ROOTS, scratch_roots


def write_settings(root: Path, perms: dict, name: str = "settings.json") -> Path:
    (root / ".claude").mkdir(parents=True, exist_ok=True)
    p = root / ".claude" / name
    p.write_text(json.dumps({"permissions": perms}))
    return p


# --- tables ------------------------------------------------------------------------------

def test_scratch_roots_expand_home_and_keep_the_fixed_roots():
    assert SCRATCH_ROOTS == ("/tmp", "/var/tmp", "~/.claude/jobs", "~/.cache/claude")
    assert scratch_roots("/home/testuser") == (
        "/tmp", "/var/tmp", "/home/testuser/.claude/jobs", "/home/testuser/.cache/claude",
    )


def test_tmpdir_under_tmp_is_added_with_one_trailing_slash_stripped():
    assert scratch_roots("/h", "/tmp/x/")[-1] == "/tmp/x"


def test_tmpdir_outside_tmp_is_ignored():
    assert scratch_roots("/h", "/home/testuser") == scratch_roots("/h")
    assert scratch_roots("/h", "") == scratch_roots("/h")


def test_curl_hosts_are_the_six_exact_entries():
    assert CURL_HOSTS == ("localhost", "127.0.0.1", "[::1]", "10.0.0.161", "10.0.0.139", "10.0.0.215")


# --- extraction (allow-compound-bash.sh:63-71) --------------------------------------------

def test_extraction_strips_the_wrapper_and_a_trailing_wildcard_only():
    perms = {"permissions": {"allow": [
        "Bash(git status:*)", "Bash(pwd)", "Bash(rm -rf /*)", "Bash(gh api *-f *)",
        "Bash(* | sh*)", "Bash(frob * --safe)", "Read", "WebFetch(domain:github.com)",
    ]}}
    assert extract_bash_prefixes(perms, "allow") == [
        "git status", "pwd", "rm -rf /", "gh api *-f", "* | sh", "frob * --safe",
    ]


def test_extraction_of_a_missing_field_or_a_non_object_is_empty():
    assert extract_bash_prefixes({"permissions": {}}, "deny") == []
    assert extract_bash_prefixes({}, "deny") == []
    assert extract_bash_prefixes("not json", "deny") == []


# --- matching (allow-compound-bash.sh:144-166) --------------------------------------------

def test_prefix_match_is_exact_or_at_a_space_or_slash_boundary():
    assert matches_any("git status", ["git status"])
    assert matches_any("git status --short", ["git status"])
    assert matches_any("ls/", ["ls"])
    assert not matches_any("lsof -i", ["ls"])
    assert not matches_any("git statusfoo", ["git status"])
    assert not matches_any("ls", [])


def test_glob_match_is_a_bash_pattern_optionally_followed_by_anything():
    assert matches_glob("git commit -m x --no-verify", ["git commit *--no-verify"])
    assert matches_glob("git commit --no-verify -m x", ["git commit *--no-verify"])
    assert matches_glob("cat a.json | sh", ["* | sh"])
    assert not matches_glob("git commit -m x", ["git commit *--no-verify"])
    assert not matches_glob("gh api -X GET /r", ["gh api *-X DELETE"])


# --- the loader and the scope asymmetry (allow-compound-bash.sh:13-26, 73-95) -------------

def test_rules_are_split_into_prefix_and_glob_classes(tmp_path):
    write_settings(tmp_path, {
        "allow": ["Bash(ls:*)", "Bash(frob * --safe)"],
        "deny": ["Bash(rm:*)", "Bash(git commit *--no-verify)"],
        "ask": ["Bash(git push:*)", "Bash(gh api *-X DELETE)"],
    })
    r = load_rules(home=str(tmp_path))
    assert r == Rules(
        allow=("ls", "frob * --safe"),
        deny=("rm",), deny_glob=("git commit *--no-verify",),
        ask=("git push",), ask_glob=("gh api *-X DELETE",),
    )


def test_allow_never_globs_but_deny_and_ask_do(tmp_path):
    write_settings(tmp_path, {
        "allow": ["Bash(frob * --safe)"], "deny": ["Bash(* | sh)"], "ask": ["Bash(gh api *-X DELETE)"],
    })
    r = load_rules(home=str(tmp_path))
    assert not r.allows("frob x --safe")
    assert r.denies("cat a | sh")
    assert r.asks("gh api -X DELETE /r")
    assert not r.asks("gh api -X GET /r")


def test_whole_glob_defer_tests_the_unsplit_command(tmp_path):
    write_settings(tmp_path, {"allow": [], "deny": ["Bash(* | sh)"], "ask": []})
    r = load_rules(home=str(tmp_path))
    assert r.whole_glob_defer("echo hi && cat a.json | sh")
    assert not r.whole_glob_defer("echo hi && cat a.json")


def test_a_project_file_cannot_widen_allow(tmp_path):
    home = tmp_path / "home"
    proj = tmp_path / "proj"
    write_settings(home, {"allow": ["Bash(echo:*)"], "deny": [], "ask": []})
    write_settings(proj, {"allow": ["Bash(frobnicate:*)"]})
    r = load_rules(home=str(home), project_dir=str(proj))
    assert r.allows("echo hi")
    assert not r.allows("frobnicate --wipe /")


def test_a_project_file_can_tighten_via_deny_and_ask(tmp_path):
    home = tmp_path / "home"
    proj = tmp_path / "proj"
    write_settings(home, {"allow": ["Bash(ls:*)"], "deny": [], "ask": []})
    write_settings(proj, {"deny": ["Bash(ls:*)"]})
    write_settings(proj, {"ask": ["Bash(cat:*)"]}, name="settings.local.json")
    r = load_rules(home=str(home), project_dir=str(proj))
    assert r.denies("ls -la")
    assert r.asks("cat f")


def test_a_missing_or_unparseable_file_contributes_nothing(tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text("{ not json")
    r = load_rules(home=str(home), project_dir=str(tmp_path / "absent"))
    assert r == Rules((), (), (), (), ())


def test_home_comes_from_the_override_env_var_before_home(tmp_path):
    write_settings(tmp_path, {"allow": ["Bash(ls:*)"], "deny": [], "ask": []})
    r = load_rules(env={"CLAUDE_GUARD_SETTINGS_HOME": str(tmp_path), "HOME": "/nonexistent"})
    assert r.allows("ls")
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd home/dot_local/share/claude-guard
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_rules.py
```

Expected: `ModuleNotFoundError: No module named 'claude_guard.rules'`.

- [ ] **Step 3: Write `tables.py`**

`home/dot_local/share/claude-guard/claude_guard/tables.py`:

```python
"""The shared tables. One home for each; a check imports from here and defines none.

Slice 2 carries the two tables its checks need. TRUSTED_SSH_HOSTS and REMOTE_READONLY_VERBS
arrive with the remote check in a later slice.
"""

# allow-safe-rm.sh:44-49. An operand must sit strictly BELOW one of these; the root itself
# is refused by the check. `~` is the caller's HOME, expanded by scratch_roots().
SCRATCH_ROOTS: tuple[str, ...] = ("/tmp", "/var/tmp", "~/.claude/jobs", "~/.cache/claude")

# allow-safe-curl.sh:50-57. Exact hosts, matched whole: loopback plus the three machines
# in ~/.ssh/config. The cluster CIDR and domain arms are patterns, not entries, and stay
# in checks/curl.py where the bash keeps them (host_allowed, :168-177).
CURL_HOSTS: tuple[str, ...] = (
    "localhost",
    "127.0.0.1",
    "[::1]",
    "10.0.0.161",  # homelab / daniel-server
    "10.0.0.139",  # daniel-pi
    "10.0.0.215",  # daniel-box
)


def scratch_roots(home: str, tmpdir: str | None = None) -> tuple[str, ...]:
    """SCRATCH_ROOTS with `~` expanded, plus $TMPDIR when it is itself under /tmp.

    allow-safe-rm.sh:50-52: TMPDIR is read but only honoured under /tmp, so exporting it
    as a home path cannot move the boundary. One trailing slash is stripped (${TMPDIR%/}).
    """
    roots = [home + r[1:] if r.startswith("~/") else r for r in SCRATCH_ROOTS]
    if tmpdir and tmpdir.startswith("/tmp/"):
        roots.append(tmpdir.removesuffix("/"))
    return tuple(roots)
```

- [ ] **Step 4: Write `rules.py`**

`home/dot_local/share/claude-guard/claude_guard/rules.py`:

```python
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
    except (OSError, ValueError):
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
    return any(
        fnmatch.fnmatchcase(cmd, p) or fnmatch.fnmatchcase(cmd, p + "*") for p in patterns
    )


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
```

- [ ] **Step 5: Run the tests to verify they pass, then ruff**

Same pytest command. Expected: `15 passed`. Then `uv run --no-project --python 3.14 --with ruff ruff check .` — `All checks passed!`.

- [ ] **Step 6: Commit**

```bash
git add claude_guard/tables.py claude_guard/rules.py tests/test_rules.py
git commit -m "Port the settings loader and matchers from allow-compound-bash.sh

allow from the user scope alone, deny and ask from every scope, so a repo can
only tighten; a trailing wildcard is the only one stripped, so an interior one
routes the rule to glob matching. Same as the bash, lines cited in the module."
```

---

### Task 2: `checks/scratch.py`: the rm operand check

**Files:**
- Create: `home/dot_local/share/claude-guard/claude_guard/checks/__init__.py` (empty)
- Create: `home/dot_local/share/claude-guard/claude_guard/checks/scratch.py`
- Create: `home/dot_local/share/claude-guard/tests/test_scratch.py`

**Interfaces:**
- Consumes: `tables.scratch_roots`.
- Produces: `scratch.rm_confined(command: str, roots: tuple[str, ...]) -> bool` (True = allow, False = no decision); `scratch.tokenize(s: str) -> list[str] | None`; `scratch.under_scratch(path: str, roots) -> bool`; `scratch.BOOL_SHORT: frozenset[str]`; `scratch.LONG_OK: frozenset[str]`.

The reference is `executable_allow-safe-rm.sh`: tokenizer `:69-110`, `under_scratch` `:115-130`, the option loop and the guarded allow `:137-174`.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/claude-guard/tests/test_scratch.py`:

```python
"""tests/hooks/allow-safe-rm.test.js, case for case. HOME is /home/testuser as there."""

import pytest

from claude_guard.checks import scratch
from claude_guard.checks.scratch import rm_confined
from claude_guard.tables import scratch_roots

ROOTS = scratch_roots("/home/testuser")

ALLOW = [
    "rm -rf /tmp/scratch",
    "rm -f /tmp/claude-1000/session/x.json",
    "rm /tmp/a/b/c.txt",
    "rm -rf /var/tmp/build",
    "rm -rf /home/testuser/.claude/jobs/abc123/tmp",
    "rm -rf /home/testuser/.cache/claude/x",
    "rm -rfv /tmp/a /tmp/b",
    "rm --recursive --force /tmp/a",
    "rm -rf -- /tmp/a",
    'rm -rf "/tmp/a b"',
    "rm -rf '/tmp/a b'",
    "/usr/bin/rm -rf /tmp/a",
]

DEFER = [
    # The scratch roots themselves are not scratch.
    "rm -rf /tmp", "rm -rf /tmp/", "rm -rf /var/tmp", "rm -rf /home/testuser/.claude/jobs", "rm -rf /",
    # Traversal out of a root, lexically or quoted.
    "rm -rf /tmp/../etc", 'rm -rf "/tmp/../etc"', "rm -rf /tmp/a/../../etc",
    # One bad operand condemns the whole command.
    "rm -rf /tmp/a /etc/passwd", "rm -rf /tmp/a /home/testuser/.ssh",
    # Outside any root.
    "rm -rf /home/testuser/.ssh", "rm -rf /etc/passwd", "rm -rf /home/testuser/src/project",
    # Shell expansion happens after the decision, so none of it is readable here.
    "rm -rf /tmp/*", "rm -rf /tmp/?", "rm -rf /tmp/[ab]", "rm -rf $HOME/x", 'rm -rf "$HOME/x"',
    "rm -rf ~/scratch", "rm -rf `echo /tmp/a`", "rm -rf $(echo /tmp/a)", "rm -rf /tmp/a\\ b",
    # Relative paths: the cwd is unknown to a PermissionRequest hook.
    "rm -rf scratch", "rm -rf ./scratch", "rm -rf ../scratch",
    # Chaining, piping and redirection belong to the judge, not here.
    "rm -rf /tmp/a && rm -rf /etc", "rm -rf /tmp/a; rm -rf /etc", "rm -rf /tmp/a | tee /etc/x",
    "rm -rf /tmp/a > /etc/x",
    # The one option that would make every path check above a lie.
    "rm --no-preserve-root -rf /tmp/a",
    # Unnamed options are not decisions.
    "rm --unknown-flag /tmp/a", "rm -z /tmp/a", "rm -rz /tmp/a",
    # Not this hook's command, or no operand at all.
    "rm", "rm -rf", "rmdir /tmp/a", "srm -rf /tmp/a", "sudo rm -rf /tmp/a", "TMPDIR=/ rm -rf /tmp/a",
    # Collapsed separators: refuse rather than guess.
    "rm -rf /tmp//a",
    # Unterminated quote.
    'rm -rf "/tmp/a',
    # Empty command.
    "",
]


@pytest.mark.parametrize("command", ALLOW)
def test_a_delete_confined_to_a_scratch_root_is_allowed(command):
    assert rm_confined(command, ROOTS) is True


@pytest.mark.parametrize("command", DEFER)
def test_anything_not_provably_confined_is_refused(command):
    assert rm_confined(command, ROOTS) is False


def test_tmpdir_can_only_ever_narrow_never_widen():
    assert rm_confined("rm -rf /home/testuser/secrets", scratch_roots("/home/testuser", "/home/testuser")) is False
    assert rm_confined("rm -rf /home/testuser/secrets", scratch_roots("/home/testuser", "/tmp/x")) is False
    # A TMPDIR under /tmp is already covered by the /tmp root itself.
    assert rm_confined("rm -rf /tmp/x/a", scratch_roots("/home/testuser", "/tmp/x")) is True


# The structure block of the node suite, as assertions on the tables rather than on source.
def test_the_option_tables_stay_closed_allowlists():
    assert scratch.BOOL_SHORT == frozenset("rRfdvIi")
    assert "--no-preserve-root" not in scratch.LONG_OK
    assert scratch.LONG_OK == frozenset({
        "--recursive", "--force", "--dir", "--verbose", "--interactive",
        "--one-file-system", "--preserve-root",
    })


def test_allow_needs_a_confined_operand_not_just_clean_options():
    # The single allow site sits behind "we saw a confined operand" (allow-safe-rm.sh:174).
    assert rm_confined("rm -rf", ROOTS) is False
    assert rm_confined("rm -rf --", ROOTS) is False
```

- [ ] **Step 2: Run them to verify they fail**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_scratch.py
```

Expected: `ModuleNotFoundError: No module named 'claude_guard.checks'`.

- [ ] **Step 3: Write the check**

Create the empty `home/dot_local/share/claude-guard/claude_guard/checks/__init__.py` (zero bytes), then `home/dot_local/share/claude-guard/claude_guard/checks/scratch.py`:

```python
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
LONG_OK = frozenset({
    "--recursive", "--force", "--dir", "--verbose", "--interactive",
    "--one-file-system", "--preserve-root",
})

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
```

- [ ] **Step 4: Run the tests to verify they pass, then ruff**

Same command. Expected: all pass (12 allow, 50 defer, 3 more). `ruff check .` clean.

- [ ] **Step 5: Commit**

```bash
git add claude_guard/checks tests/test_scratch.py
git commit -m "Port allow-safe-rm.sh as checks/scratch.py

Same tokenizer, same lexical path check, same closed option table. The
node suite's case lists port one for one; its structure test becomes
assertions on the table constants."
```

---

### Task 3: `checks/curl.py`: the safe-curl check

**Files:**
- Create: `home/dot_local/share/claude-guard/claude_guard/checks/curl.py`
- Create: `home/dot_local/share/claude-guard/tests/test_curl.py`

**Interfaces:**
- Consumes: `tables.CURL_HOSTS`.
- Produces: `curl.curl_safe(command: str) -> bool`; `curl.tokenize(s) -> list[str] | None`; `curl.url_ok(url) -> bool`; `curl.host_allowed(host) -> bool`; the tables `BOOL_SHORT: str`, `VALUE_SHORT: str`, `LONG_BOOL: frozenset[str]`, `LONG_VALUE: frozenset[str]`.

The reference is `executable_allow-safe-curl.sh`: tables `:75-76`, tokenizer `:87-153`, `host_allowed` `:168-177`, `url_ok` `:182-202`, long tables `:204-224`, `check_value` `:235-259`, the option loop `:266-331`.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/claude-guard/tests/test_curl.py`:

```python
"""tests/hooks/allow-safe-curl.test.js, case for case."""

import string

import pytest

from claude_guard.checks import curl
from claude_guard.checks.curl import curl_safe

ALLOW = [
    "curl http://10.0.0.161:9090/metrics",
    "curl http://10.0.0.139/api",
    "curl https://10.0.0.215/",
    "curl http://localhost:8080/health",
    "curl http://127.0.0.1:8000/",
    'curl "http://[::1]:3000/x"',
    "curl HTTP://10.0.0.161/x",
    "curl http://LOCALHOST:8080/",
    "/usr/bin/curl -fsS http://127.0.0.1:8000/",
    "curl -sS http://localhost:8080/health",
    "curl -I https://10.0.0.215/",
    "curl -k https://10.0.0.161:8443/health",
    'curl -X GET -H "Accept: application/json" http://10.0.0.139/api',
    'curl -H"X-Token: 1" http://10.0.0.161/y',
    "curl --max-time=5 http://10.0.0.161/y",
    "curl -s --compressed --retry 3 http://10.0.0.161/y",
    'curl --url "http://10.0.0.161/x" -m 5',
    'curl "http://10.0.0.161:9090/api/v1/query?query=up&step=5m"',
    "curl 'http://10.0.0.161/a?b=1&c=2'",
    "curl http://10.43.39.218:9090/api/v1/query",
    "curl http://10.42.0.171:3000/health",
    "curl https://prometheus-k8s.local.daniel-hunter.com/api/v1/query",
    "curl -sS https://jellyfin.daniel-hunter.com/health",
    'curl -s -G http://127.0.0.1:9090/api/v1/query --data-urlencode "query=up"',
    'curl -sG --data-urlencode "query=up" http://10.43.39.218:9090/api/v1/query',
    'curl -s --get --data-urlencode "query=up" http://127.0.0.1:9090/api/v1/query',
    'curl -sS -w "%{http_code}" https://homepage.daniel-hunter.com/',
    'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9090/-/ready',
    'curl -so /dev/null -w "homepage=%{http_code}" https://homepage.daniel-hunter.com/',
    'curl --output /dev/null -w "%{http_code}" http://10.43.39.218:9090/-/ready',
    'curl --output=/dev/null -w "%{http_code}" http://127.0.0.1:9090/-/ready',
    'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:9090/-/ready',
    'curl -so /dev/null -w "homepage=%{http_code}\\n" https://homepage.daniel-hunter.com/',
    'curl -H "X-Literal: \\$HOME" http://10.0.0.161/x',
    'curl -w "\\`literal\\`" http://10.0.0.161/x',
]

DEFER = [
    "curl http://daniel-hunter.com.attacker.net/x",
    "curl http://evil-daniel-hunter.com/x",
    "curl http://notdaniel-hunter.com/x",
    "curl https://prometheus-k8s.local.daniel-hunter.com.evil.net/x",
    "curl http://10.43.39.218.evil.com/x",
    "curl http://10.44.0.1/x",
    "curl http://10.43.999.1/x",
    "curl http://10.43.0/x",
    'curl --data-urlencode "query=up" http://127.0.0.1:9090/api/v1/query',
    'curl -X POST --data-urlencode "q=1" http://127.0.0.1:9090/x',
    "curl -G --data-urlencode @/etc/passwd http://127.0.0.1:9090/x",
    "curl -o /home/ubuntu/.ssh/authorized_keys https://prometheus-k8s.local.daniel-hunter.com/x",
    "curl -o /tmp/x http://127.0.0.1:9090/metrics",
    "curl -so/tmp/x http://127.0.0.1:9090/metrics",
    "curl --output /tmp/x http://127.0.0.1:9090/metrics",
    "curl --output=/tmp/x http://127.0.0.1:9090/metrics",
    "curl -o /dev/null/../../tmp/x http://127.0.0.1:9090/metrics",
    'curl -o "/dev/null x" http://127.0.0.1:9090/metrics',
    "curl -O http://127.0.0.1:9090/metrics",
    "curl --output-dir /tmp -o /dev/null http://127.0.0.1:9090/metrics",
    'curl -H "X-Sub: $(whoami)" http://10.0.0.161/x',
    'curl -w "`whoami`" http://10.0.0.161/x',
    'curl "http://10.0.0.161/$PATH"',
    'curl "http://10.0.0.161/x\\"',
    'curl "http://10.0.0.161/x\\" -o /tmp/y',
    'curl "http://10.0.0.161/x\\\\" -o /tmp/y',
    'curl "http://10.0.0.161\\@evil.com/x"',
    "curl -L https://prometheus-k8s.local.daniel-hunter.com/x",
    "curl http://evil.com/x",
    "curl http://10.0.0.1610/x",
    "curl http://10.0.0.161.evil.com/x",
    "curl http://evil.com/10.0.0.161",
    "curl http://10.0.0.161@evil.com/x",
    "curl http://127.0.0.2/x",
    "curl http://10.0.0.16/x",
    "curl http://10.0.0.161:notaport/x",
    "curl http://10.0.0.161/x http://evil.com/y",
    "curl --url http://evil.com/x",
    "curl --url=http://evil.com/x",
    "curl file:///etc/shadow",
    "curl dict://10.0.0.161/x",
    "curl gopher://10.0.0.161/x",
    "curl -L http://10.0.0.161/x",
    "curl --location http://10.0.0.161/x",
    "curl --resolve 10.0.0.161:80:1.2.3.4 http://10.0.0.161/x",
    "curl --connect-to 10.0.0.161:80:evil.com:80 http://10.0.0.161/x",
    "curl -x http://evil.com http://10.0.0.161/x",
    "curl --proxy http://evil.com http://10.0.0.161/x",
    "curl --unix-socket /var/run/docker.sock http://localhost/containers/json",
    "curl -K /tmp/cfg http://10.0.0.161/x",
    "curl --config /tmp/cfg http://10.0.0.161/x",
    "curl http://10.0.0.161/x --next http://evil.com/y",
    "curl -o /tmp/x http://10.0.0.161/x",
    "curl -O http://10.0.0.161/x",
    "curl -sSo /tmp/x http://10.0.0.161/x",
    "curl --output-dir /tmp -O http://10.0.0.161/x",
    "curl --create-dirs -o /tmp/a/b http://10.0.0.161/x",
    "curl -D /tmp/h http://10.0.0.161/x",
    "curl --trace-ascii /tmp/t http://10.0.0.161/x",
    "curl --stderr /tmp/e http://10.0.0.161/x",
    'curl "http://10.0.0.161/x" "http://10.0.0.161/y" -o out',
    "curl -T /etc/passwd http://10.0.0.161/x",
    "curl -F file=@/etc/passwd http://10.0.0.161/x",
    "curl -d @/etc/passwd http://10.0.0.161/x",
    "curl --data-binary @/etc/passwd http://10.0.0.161/x",
    "curl -H @/etc/shadow http://10.0.0.161/x",
    "curl -w @/tmp/f http://10.0.0.161/x",
    "curl -b /etc/passwd http://10.0.0.161/x",
    "curl -u admin:pw http://10.0.0.161/x",
    "curl -X POST http://10.0.0.161/x",
    "curl -X DELETE http://10.0.0.161/x",
    "curl --request PUT http://10.0.0.161/x",
    "curl --request=POST http://10.0.0.161/x",
    "curl --zzz-unknown http://10.0.0.161/x",
    "curl -Z http://10.0.0.161/x",
    "curl -- http://10.0.0.161/x",
    "curl -m",
    "curl --header",
    "curl --header http://10.0.0.161/x",
    "curl http://10.0.0.161/x; id",
    'curl "http://10.0.0.161/x" && id',
    "curl http://10.0.0.161/x | tee /etc/passwd",
    "curl http://10.0.0.161/x > /etc/passwd",
    "curl http://10.0.0.161/x & id",
    "curl http://10.0.0.161/x\nid",
    "curl $URL",
    'curl "http://10.0.0.161/${HOME}"',
    'curl "http://10.0.0.161/$(id)"',
    "curl http://10.0.0.161/`id`",
    "curl http://10.0.0.161/a*",
    "curl http://[::1]:3000/x",
    "curl ~/x",
    'curl "http://10.0.0.161/x',
    "curl",
    "curl -sS",
    "curlie http://10.0.0.161/x",
    "env curl http://10.0.0.161/x",
    "sudo curl http://10.0.0.161/x",
    "wget http://10.0.0.161/x",
    "",
]


@pytest.mark.parametrize("command", ALLOW)
def test_a_plain_get_or_head_against_an_allowlisted_host_is_allowed(command):
    assert curl_safe(command) is True


@pytest.mark.parametrize("command", DEFER)
def test_any_other_host_option_or_method_is_refused(command):
    assert curl_safe(command) is False


INVENTED = ["--a", "--zz", "--out", "--data-raw", "--upload", "--socks5", "--proxy1.0", "--cert",
            "--engine", "--dump-header", "--remote-name", "--location-trusted", "--config-file",
            "--form-string", "--netrc-file"]


@pytest.mark.parametrize("opt", INVENTED)
def test_an_unnamed_long_option_is_refused(opt):
    assert curl_safe(f"curl {opt} http://10.0.0.161/x") is False


@pytest.mark.parametrize("c", [c for c in string.ascii_letters if c not in curl.BOOL_SHORT + curl.VALUE_SHORT])
def test_an_unnamed_short_option_is_refused(c):
    assert curl_safe(f"curl -{c} http://10.0.0.161/x") is False


def test_the_option_tables_stay_an_allowlist():
    shorts = curl.BOOL_SHORT + curl.VALUE_SHORT
    for c in "LOJdFTKbux":
        assert c not in shorts, c
    longs = curl.LONG_BOOL | curl.LONG_VALUE
    for opt in ["location", "location-trusted", "resolve", "connect-to", "proxy", "preproxy",
                "unix-socket", "abstract-unix-socket", "config", "next", "output-dir",
                "remote-name", "remote-header-name", "create-dirs", "dump-header", "trace",
                "trace-ascii", "stderr", "upload-file", "data", "data-binary", "data-raw", "form",
                "form-string", "cookie", "cookie-jar", "user", "netrc", "netrc-file"]:
        assert opt not in longs, opt
    # -o/--output is the ONE write primitive admitted, pinned to /dev/null (allow-safe-curl.sh:249-251).
    assert "o" in shorts and "output" in curl.LONG_VALUE
    assert curl_safe("curl -o /dev/null http://10.0.0.161/x") is True
    assert curl_safe("curl -o /dev/nul http://10.0.0.161/x") is False


def test_allow_needs_a_checked_url_not_just_clean_options():
    assert curl_safe("curl -sS") is False
    assert curl_safe("curl -sS -m 5") is False
```

- [ ] **Step 2: Run them to verify they fail**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_curl.py
```

Expected: `ModuleNotFoundError: No module named 'claude_guard.checks.curl'`.

- [ ] **Step 3: Write the check**

`home/dot_local/share/claude-guard/claude_guard/checks/curl.py`:

```python
"""A curl that is provably a plain GET/HEAD against an allowlisted host. allow-safe-curl.sh ported.

The option table is an ALLOWLIST (allow-safe-curl.sh:16-29): curl gains options every
release, so an option this module does not name, old or new, is not a decision. Absent on
purpose are --resolve, --connect-to, -x/--proxy, --unix-socket, -K/--config, --next,
-L/--location, every write primitive except `-o /dev/null`, and every read-a-file primitive.
-k/--insecure IS allowed: the host is already pinned and the homelab serves self-signed certs.
"""

import re

from claude_guard.tables import CURL_HOSTS

# :75-76. `o` is admitted ONLY for the literal /dev/null (check_value).
BOOL_SHORT = "sSfiIvkg46N#G"
VALUE_SHORT = "HAmwreXo"

# :204-224.
LONG_BOOL = frozenset({
    "silent", "show-error", "fail", "fail-early", "fail-with-body", "include", "head",
    "verbose", "insecure", "compressed", "globoff", "ipv4", "ipv6", "http1.0", "http1.1",
    "http2", "http2-prior-knowledge", "no-buffer", "no-progress-meter", "progress-bar",
    "raw", "tcp-nodelay", "no-keepalive", "path-as-is", "retry-all-errors",
    "retry-connrefused", "get",
})
LONG_VALUE = frozenset({
    "header", "user-agent", "referer", "max-time", "connect-timeout", "retry",
    "retry-delay", "retry-max-time", "range", "max-filesize", "write-out", "request",
    "url", "expect100-timeout", "happy-eyeballs-timeout-ms", "data-urlencode", "output",
})

# :107-108.
_SPECIAL = frozenset(";&|<>(){}$`\\*?[]\n\r")

# :173-175. Each octet checked numerically so `10.43.0.0.evil.com` cannot pass; the domain
# match is anchored to the END so `daniel-hunter.com.attacker.net` does not match.
_OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
_CLUSTER_RE = re.compile(rf"^10\.4[23]\.{_OCTET}\.{_OCTET}$")
_DOMAIN_SUFFIX = ".daniel-hunter.com"
_SCHEME_RE = re.compile(r"^[Hh][Tt][Tt][Pp][Ss]?://")


def tokenize(s: str) -> list[str] | None:
    """:87-153. Like scratch.tokenize, except `~` is refused only at the start of a word and
    a backslash inside double quotes escapes only $ ` " \\ and newline, as bash does."""
    tokens: list[str] = []
    state = ""
    cur = ""
    started = False
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        i += 1
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
            elif c in _SPECIAL:
                return None
            elif c == "~":
                if not started:
                    return None
                cur += c
            else:
                cur += c
                started = True
        elif state == "single":
            if c == "'":
                state = ""
            else:
                cur += c
        else:  # double, :120-144
            if c == '"':
                state = ""
            elif c in "$`":
                return None
            elif c == "\\":
                nxt = s[i] if i < n else ""
                if nxt and nxt in '$`"\\\n':
                    cur += nxt
                    i += 1
                else:
                    cur += c
            else:
                cur += c
    if state:
        return None
    if started:
        tokens.append(cur)
    return tokens


def host_allowed(candidate: str) -> bool:
    """:168-177."""
    if candidate in CURL_HOSTS:
        return True
    if _CLUSTER_RE.match(candidate):
        return True
    return candidate.endswith(_DOMAIN_SUFFIX)


def url_ok(url: str) -> bool:
    """:182-202. Authority is everything after the scheme and before the first /?#; any
    userinfo is refused rather than skipped."""
    if not _SCHEME_RE.match(url):
        return False
    rest = url.split("://", 1)[1]
    authority = re.split(r"[/?#]", rest, maxsplit=1)[0]
    if not authority or "@" in authority:
        return False
    if authority.startswith("["):
        host = authority.split("]", 1)[0] + "]"
    else:
        host = authority.split(":", 1)[0]
    port = authority[len(host):]
    if port:
        if not port.startswith(":"):
            return False
        if not re.fullmatch(r"[0-9]+", port[1:]):
            return False
    return host_allowed(host.lower())


def curl_safe(command: str) -> bool:
    """:266-331. True only when a URL was checked and every option was named."""
    if not command:
        return False
    tokens = tokenize(command)
    if tokens is None or len(tokens) <= 1:
        return False
    if tokens[0].rsplit("/", 1)[-1] != "curl":
        return False

    saw_url = False
    saw_get = False
    saw_data = False

    def check_value(name: str, value: str) -> bool:
        # :235-259. A value starting with @ makes curl read a FILE; refused everywhere.
        nonlocal saw_url, saw_data
        if value.startswith("@"):
            return False
        if name in ("request", "X"):
            return value in ("GET", "HEAD", "get", "head")
        if name == "url":
            if not url_ok(value):
                return False
            saw_url = True
        elif name in ("output", "o"):
            if value != "/dev/null":
                return False
        elif name == "data-urlencode":
            saw_data = True
        return True

    i = 1
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        i += 1
        if tok == "--":
            return False
        if tok.startswith("--") and len(tok) > 2 and "=" in tok[3:]:  # --?*=*
            name, value = tok[2:].split("=", 1)
            if name not in LONG_VALUE or not check_value(name, value):
                return False
        elif tok.startswith("--") and len(tok) > 2:  # --?*
            name = tok[2:]
            if name in LONG_BOOL:
                if name == "get":
                    saw_get = True
                continue
            if name not in LONG_VALUE or i >= n:
                return False
            value = tokens[i]
            i += 1
            if not check_value(name, value):
                return False
        elif tok.startswith("-") and len(tok) > 1:  # -?*
            cluster = tok[1:]
            j = 0
            while j < len(cluster):
                c = cluster[j]
                j += 1
                if c in BOOL_SHORT:
                    if c == "G":
                        saw_get = True
                    continue
                if c not in VALUE_SHORT:
                    return False
                value = cluster[j:]
                if not value:
                    if i >= n:
                        return False
                    value = tokens[i]
                    i += 1
                if not check_value(c, value):
                    return False
                break
        else:
            if not url_ok(tok):
                return False
            saw_url = True

    # :325-329. --data-* without -G is a POST body; this check only speaks for GET/HEAD.
    if saw_data and not saw_get:
        return False
    return saw_url
```

- [ ] **Step 4: Run the tests to verify they pass, then ruff**

Same command. Expected: all pass. If a case diverges, run the bash on it to confirm which side is right, e.g. `printf '{"tool_input":{"command":"curl -so/tmp/x http://127.0.0.1:9090/metrics"}}' | bash ../../../private_dot_claude/hooks/executable_allow-safe-curl.sh`, and fix the port, not the expectation. `ruff check .` clean.

- [ ] **Step 5: Commit**

```bash
git add claude_guard/checks/curl.py tests/test_curl.py
git commit -m "Port allow-safe-curl.sh as checks/curl.py

Same tokenizer with bash's double-quote escapes, same authority parse, same
closed option tables with -o pinned to /dev/null. Case lists port one for
one, including the letter sweep over every short option the tables omit."
```

---

### Task 4: `judge.py`: the compound decision as the bash makes it today

**Files:**
- Create: `home/dot_local/share/claude-guard/claude_guard/judge.py`
- Create: `home/dot_local/share/claude-guard/tests/test_judge.py`

**Interfaces:**
- Consumes: `segment.parse`, `rules.Rules`, `rules.load_rules`, `checks.scratch.rm_confined`, `checks.curl.curl_safe`, `tables.scratch_roots`.
- Produces:
  - `judge.Decision(allow: bool, rule: str, reasons: tuple[str, ...])`, frozen. `rule` is the one word the shadow log records: `allow`, `not-compound`, `whole-glob`, `unreadable:<reason>`, `unjudgeable:substitution`, `unjudgeable:heredoc`, `unjudgeable:separator`, or `segment:<n>:<reason>` for a per-segment refusal. `reasons` is one string per judged segment for `explain`.
  - `judge.judge(command: str, rules: Rules, roots: tuple[str, ...]) -> Decision`.
  - `judge.judge_segment(part: str, rules: Rules, roots) -> tuple[bool, str]`: `(True, "allow-list" | "ff-only" | "curl-check" | "rm-check" | "wrapper:<target>")` or `(False, "redirect" | "tee" | "deny" | "ask" | "wrapper-unreadable" | "unlisted" | "wrapper-target-deny-or-ask" | "wrapper-target-unlisted")`.
  - `judge.unwrap_wrapper(segment: str) -> str | None`; `judge.WRAPPERS: frozenset[str]`.

The reference is `executable_allow-compound-bash.sh`: eligibility gate `:51-59`, `trim` `:137-142`, `unwrap_wrapper` `:181-270`, whole-glob `:277-281`, `judge()` `:286-395`, the decision block `:402-438`.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/claude-guard/tests/test_judge.py`:

```python
"""tests/hooks/allow-compound-bash.test.js, case for case, against the same four fixtures.

Each fixture is written to a temp HOME and read back through load_rules, so the loader is
in the loop the way the bash reads settings.json. The three content guards on the REAL
allow list at the end of that suite test settings.permissions.json, not the hook, and stay
in node.
"""

import json
from pathlib import Path

import pytest

from claude_guard import judge as judge_mod
from claude_guard.judge import Decision, judge, unwrap_wrapper
from claude_guard.rules import Rules, load_rules
from claude_guard.tables import scratch_roots

ROOTS = scratch_roots("/home/testuser")


def rules_for(tmp: Path, perms: dict, project: dict | None = None) -> Rules:
    (tmp / "home" / ".claude").mkdir(parents=True, exist_ok=True)
    (tmp / "home" / ".claude" / "settings.json").write_text(json.dumps({"permissions": perms}))
    project_dir = None
    if project is not None:
        (tmp / "proj" / ".claude").mkdir(parents=True, exist_ok=True)
        (tmp / "proj" / ".claude" / "settings.json").write_text(json.dumps({"permissions": project}))
        project_dir = str(tmp / "proj")
    return load_rules(home=str(tmp / "home"), project_dir=project_dir)


MAIN = {
    "allow": ["Bash(git status:*)", "Bash(ls:*)", "Bash(echo:*)", "Bash(cat:*)", "Bash(jq:*)",
              "Bash(jsonq:*)", "Bash(git commit:*)", "Bash(gh api:*)", "Bash(sh:*)", "Bash(tail:*)",
              "Bash(git log:*)", "Bash(frob * --safe)"],
    "deny": ["Bash(rm:*)", "Bash(git commit *--no-verify)", "Bash(* | sh)"],
    "ask": ["Bash(git push:*)", "Bash(gh api *-X DELETE)", "Bash(git merge:*)"],
}
RM = {"allow": ["Bash(cd:*)", "Bash(echo:*)", "Bash(ls:*)", "Bash(mkdir:*)"], "deny": [], "ask": ["Bash(rm:*)"]}
ESC = {
    "allow": ["Bash(echo:*)", "Bash(ls:*)", "Bash(find:*)", "Bash(awk:*)", "Bash(wc:*)", "Bash(grep:*)",
              "Bash(tee:*)", "Bash(/usr/bin/env bash --version)"],
    "deny": ["Bash(find *-exec*)", "Bash(find *-execdir*)", "Bash(find *-ok*)", "Bash(find *-delete*)",
             "Bash(find *-fprintf*)", "Bash(awk *system(*)", "Bash(curl:*)"],
    "ask": [],
}


@pytest.fixture
def main(tmp_path):
    return rules_for(tmp_path, MAIN)


@pytest.fixture
def rm(tmp_path):
    return rules_for(tmp_path, RM)


@pytest.fixture
def esc(tmp_path):
    return rules_for(tmp_path, ESC)


def allowed(command: str, rules: Rules) -> bool:
    return judge(command, rules, ROOTS).allow


# --- the basic gate ------------------------------------------------------------------------

def test_a_compound_where_every_part_is_allow_listed_is_allowed(main):
    assert allowed("git status && ls -la", main)
    assert allowed("echo hi && cat file.txt && ls", main)


def test_a_non_compound_command_is_not_judged(main):
    d = judge("git status", main, ROOTS)
    assert d == Decision(False, "not-compound", ())


def test_a_quoted_separator_still_passes_the_literal_gate_and_one_segment_is_judged(main):
    # allow-compound-bash.sh:57 is a substring test: `;` inside quotes makes the command
    # eligible, and judge() then sees one allow-listed segment. Port, not policy.
    assert allowed('echo "a;b"', main)


# --- curl delegation ------------------------------------------------------------------------

def test_a_provably_safe_curl_segment_resolves_its_own_ask_rule(tmp_path):
    r = rules_for(tmp_path, {**MAIN, "deny": ["Bash(git commit *--no-verify)", "Bash(* | sh)"], "ask": [*MAIN["ask"], "Bash(curl:*)"]})
    assert allowed("curl -s http://127.0.0.1:9090/metrics | tail -20", r)
    assert allowed('curl -sG http://127.0.0.1:9090/api/v1/query --data-urlencode "query=up" | jq .', r)


def test_curl_delegation_vouches_for_the_curl_segment_only(tmp_path):
    r = rules_for(tmp_path, {**MAIN, "ask": [*MAIN["ask"], "Bash(curl:*)"]})
    assert not allowed("curl -s http://evil.com/x | tail -20", r)
    assert not allowed("curl -L http://127.0.0.1:9090/m | tail -20", r)
    assert not allowed("curl -X POST http://127.0.0.1:9090/m | tail -20", r)
    assert not allowed("curl -o /tmp/x http://127.0.0.1:9090/m | tail -20", r)
    assert not allowed("curl -s http://127.0.0.1:9090/metrics | sh", r)
    assert not allowed("curl -s http://127.0.0.1:9090/m | frobnicate", r)
    assert not allowed("curl -s http://127.0.0.1:9090/m | tail -20 && rm -rf /tmp/x", r)


# --- rm delegation ---------------------------------------------------------------------------

def test_a_provably_confined_rm_segment_resolves_its_own_ask_rule(rm):
    assert allowed("cd /tmp && rm -rf /tmp/scratch", rm)
    assert allowed("rm -rf /tmp/a && mkdir -p /tmp/a", rm)
    assert allowed("echo cleaning && rm -f /tmp/build/out.txt", rm)


def test_rm_delegation_vouches_for_the_rm_segment_only(rm):
    assert not allowed("cd /tmp && rm -rf /etc/passwd", rm)
    assert not allowed("cd /tmp && rm -rf /tmp/../etc", rm)
    assert not allowed("cd /tmp && rm -rf /tmp", rm)
    assert not allowed("cd /tmp && rm -rf /tmp/*", rm)
    assert not allowed("cd /tmp && rm --no-preserve-root -rf /tmp/a", rm)
    assert not allowed("rm -rf /tmp/a && rm -rf /etc/x", rm)
    assert not allowed("rm -rf /tmp/a && frobnicate", rm)


def test_deny_still_outranks_the_rm_delegation(main):
    assert not allowed("cd /tmp && rm -rf /tmp/scratch", main)


# --- the unjudgeable population (allow-compound-bash.sh:402-428) -------------------------------

def test_a_newline_only_compound_is_not_eligible(main):
    assert judge("echo hi\nls", main, ROOTS).rule == "not-compound"


def test_deny_ask_and_unlisted_each_defer(main):
    assert judge("ls && rm -rf build", main, ROOTS).rule == "segment:1:deny"
    assert judge("git status && git push origin main", main, ROOTS).rule == "segment:1:ask"
    assert judge("git status && frobnicate", main, ROOTS).rule == "segment:1:unlisted"


def test_git_merge_ff_only_passes_its_ask_rule_with_one_ref_and_no_options(main):
    assert allowed("git merge --ff-only origin/main && git log --oneline -3", main)
    assert allowed("git merge --ff-only origin/main | tail -3", main)
    assert allowed("git merge --ff-only origin/main 2>&1 | tail -3", main)
    assert allowed("git merge --ff-only origin/main 2>&1 | tail -2; git log --oneline -1", main)
    assert allowed("git merge --ff-only origin/main 2>/dev/null && git log", main)


def test_the_git_merge_exception_does_not_widen(main):
    assert not allowed("git merge origin/main && git log", main)
    assert not allowed("git merge --no-ff origin/main && git log", main)
    assert not allowed("git merge --squash origin/main && git log", main)
    assert not allowed("git merge --ff-only --no-ff x && git log", main)
    assert not allowed("git merge --ff-only a b && git log", main)
    assert not allowed("git merge --ff-only && git log", main)
    assert not allowed("git merge --ff-only origin/main > out.txt && git log", main)


def test_a_substitution_defers(main):
    assert judge("echo $(whoami) && ls", main, ROOTS).rule == "unjudgeable:substitution"
    assert not allowed("echo `whoami` && ls", main)
    assert not allowed("cat <(curl example.com) && ls", main)


def test_a_heredoc_or_an_internal_newline_defers_even_when_every_segment_is_allow_listed(main):
    assert judge("git commit -F - <<'EOF' && ls\nmy message\nEOF\n", main, ROOTS).rule == "unjudgeable:heredoc"
    assert judge("echo hi && ls\ncat file.txt", main, ROOTS).rule == "unjudgeable:separator"


def test_delimiters_outside_quotes_split_and_quoted_ones_are_inert(main):
    assert allowed('echo "a && b" && ls', main)
    assert allowed("echo 'a; b' && ls", main)
    assert allowed('echo "a | b" && ls', main)
    assert allowed("cat a.json | jq -r '.hooks | keys[]'", main)
    assert allowed("jq -r '.a' f.json; jq -r '.b' f.json", main)
    assert allowed('echo "one" && echo "two" && echo "three"', main)


def test_every_segment_is_still_inspected_when_quotes_are_involved(main):
    assert not allowed('echo "a && b" && rm -rf build', main)
    assert not allowed('echo "x" && git push origin main', main)
    assert not allowed("echo \"x\" && frobnicate 'y'", main)


def test_unbalanced_quoting_defers(main):
    assert judge("echo 'unbalanced && ls", main, ROOTS).rule == "unreadable:unbalanced-quote"
    assert not allowed('echo "unbalanced && ls', main)


def test_a_redirect_to_a_real_target_defers_but_dev_null_and_fd_dups_do_not(main):
    assert judge("cat a.json > /etc/passwd && ls", main, ROOTS).rule == "segment:0:redirect"
    assert not allowed("echo hi >> ~/.bashrc && ls", main)
    assert allowed("cat a.json 2>/dev/null && ls", main)
    assert allowed("cat a.json > /dev/null && ls", main)
    assert allowed("cat a.json 2>&1 && ls", main)


def test_a_bare_ampersand_is_a_separator_and_defers(main):
    assert not allowed("git status && ls & frobnicate", main)
    assert not allowed("git status; echo hi & rm -rf build", main)
    assert not allowed("ls & git status", main)
    assert allowed("cat a.json 2>&1 && ls", main)
    assert allowed('echo "a & b" && ls', main)
    assert judge("git status && ls & echo hi", main, ROOTS).rule == "unjudgeable:separator"


def test_an_allow_prefix_matches_only_at_a_command_boundary(main):
    assert not allowed("lsof -i && ls", main)
    assert not allowed("git statusfoo && ls", main)
    assert not allowed("echoes hi && ls", main)


def test_deny_and_ask_rules_with_an_interior_wildcard_are_globs(main):
    assert not allowed("git status && git commit -m x --no-verify", main)
    assert not allowed("git status && git commit --no-verify -m x", main)
    assert not allowed("ls && gh api -X DELETE /repos/o/r", main)


def test_pipe_spanning_deny_globs_apply_to_the_whole_command(main):
    assert judge("cat a.json | sh", main, ROOTS).rule == "whole-glob"
    assert not allowed("echo hi && cat a.json | sh", main)


def test_interior_wildcard_rules_do_not_over_match(main):
    assert allowed("git status && git commit -m x", main)
    assert allowed("git status && gh api /repos/o/r", main)
    assert allowed("git status && gh api -X GET /repos/o/r", main)


def test_interior_wildcards_in_allow_rules_stay_inert(main):
    assert not allowed("ls && frob x --safe", main)


# --- the interpreter-escape family and wrappers ----------------------------------------------

def test_deny_globs_cover_the_execution_forms_of_allow_listed_spawners(esc):
    assert not allowed("echo hi && find . -maxdepth 0 -exec id \\;", esc)
    assert not allowed("echo hi && find . -execdir id \\;", esc)
    assert not allowed("echo hi && find . -ok rm {} \\;", esc)
    assert not allowed("echo hi && find . -delete", esc)
    assert not allowed("echo hi && find . -fprintf /tmp/x %p", esc)
    assert not allowed("echo hi && awk 'BEGIN{system(\"id\")}'", esc)


def test_deny_globs_leave_the_everyday_form_of_each_spawner_allowed(esc):
    assert allowed("echo hi && find . -name '*.ts'", esc)
    assert allowed("echo hi && find . -type f -maxdepth 2", esc)
    assert allowed("echo hi && awk '{print $1}' f.txt", esc)


def test_a_wrapper_is_judged_on_the_command_it_will_actually_run(esc):
    assert allowed("echo hi | xargs wc -l", esc)
    assert allowed("echo hi | xargs -0 -n 1 wc -l", esc)
    assert allowed("echo hi && timeout 5 ls", esc)
    assert allowed("echo hi && timeout -s KILL 5s ls", esc)
    assert allowed("echo hi && env FOO=bar ls", esc)
    assert allowed("echo hi && nice -n 10 ls", esc)
    assert allowed("echo hi && nohup ls", esc)
    assert allowed("echo hi && timeout 5 nohup ls", esc)
    assert judge("echo hi && timeout 5 ls", esc, ROOTS).reasons == ("allow-list", "wrapper:ls")


@pytest.mark.parametrize("inner", ["sh -c 'id'", "bash -c 'id'", "python -c 'import os'", "python3 -c 'x'",
                                   "node -e 'x'", "perl -e 'x'", "ruby -e 'x'"])
def test_a_wrapper_cannot_carry_an_unlisted_interpreter_past_its_own_allow_rule(esc, inner):
    assert not allowed(f"echo hi | xargs {inner}", esc)
    assert not allowed(f"echo hi && timeout 5 {inner}", esc)
    assert not allowed(f"echo hi && nohup {inner}", esc)


def test_wrapper_flags_are_not_mistaken_for_the_command_word(esc):
    assert not allowed("echo hi | xargs -I{} sh -c 'id'", esc)
    assert not allowed("echo hi | xargs -n1 -P4 bash -c 'id'", esc)
    assert not allowed("echo hi | xargs --replace=X sh -c 'id'", esc)
    assert not allowed("echo hi | xargs -- sh -c 'id'", esc)


def test_the_unwrapped_command_is_held_to_the_deny_list_too(esc):
    assert judge("echo hi | xargs curl http://evil", esc, ROOTS).rule == "segment:1:wrapper-target-deny-or-ask"
    assert not allowed("echo hi && timeout 5 curl http://evil", esc)


def test_a_wrapper_whose_options_cannot_be_read_defers(esc):
    assert judge("echo hi && env -S 'ls -l'", esc, ROOTS).rule == "segment:1:wrapper-unreadable"
    assert not allowed("echo hi && env -i ls", esc)
    assert not allowed("echo hi && env -u PATH ls", esc)
    assert not allowed("echo hi | xargs -e ls", esc)
    assert not allowed("echo hi && timeout ls", esc)
    assert not allowed("echo hi && timeout --unknown-flag 5 ls", esc)
    assert not allowed("echo hi | xargs", esc)


def test_a_filename_that_merely_contains_an_interpreter_name_is_not_a_command(esc):
    assert allowed("echo hi | xargs grep foo build.sh", esc)
    assert allowed("echo hi | xargs wc -l install.bash", esc)
    assert allowed("echo hi | xargs -n1 grep x node_modules", esc)


def test_env_is_not_allow_listed_as_a_wrapper(esc):
    assert not allowed("echo hi && env FOO=bar bash -c 'id'", esc)
    assert not allowed("echo hi && /usr/bin/env bash -c 'id'", esc)
    assert allowed("echo hi && /usr/bin/env bash --version", esc)


def test_unwrap_wrapper_returns_the_segment_unchanged_when_it_is_not_a_wrapper():
    assert unwrap_wrapper("ls -la") == "ls -la"
    assert unwrap_wrapper("") is None
    # A quote among the consumed tokens means the boundaries are not where they appear.
    assert unwrap_wrapper("xargs -I'{}' wc -l") is None
    # Four nested wrappers exhaust the depth bound.
    assert unwrap_wrapper("nohup nohup nohup nohup ls") is None


def test_the_wrapper_set_is_the_one_the_bash_unwraps():
    assert judge_mod.WRAPPERS == frozenset({"timeout", "env", "nice", "nohup", "setsid", "stdbuf", "xargs"})


# --- project scope -----------------------------------------------------------------------------

def test_a_project_settings_file_cannot_widen_the_allow_list(tmp_path):
    r = rules_for(tmp_path, MAIN, project={"allow": ["Bash(frobnicate:*)"]})
    assert not allowed("echo hi && frobnicate --wipe /", r)


def test_a_project_settings_file_can_still_tighten_via_deny_and_ask(tmp_path):
    assert not allowed("echo hi && ls -la", rules_for(tmp_path, MAIN, project={"deny": ["Bash(ls:*)"]}))
    assert not allowed("echo hi && ls -la", rules_for(tmp_path, MAIN, project={"ask": ["Bash(ls:*)"]}))
    assert allowed("echo hi && ls -la", rules_for(tmp_path, MAIN, project={}))


# --- tee -----------------------------------------------------------------------------------------

def test_tee_is_a_writer_unless_its_target_is_harmless(esc):
    assert judge("echo hi | tee /tmp/pwned", esc, ROOTS).rule == "segment:1:tee"
    assert not allowed("echo hi | tee -a /tmp/pwned", esc)
    assert not allowed("echo hi | tee /usr/bin/tee", esc)
    assert allowed("echo hi | tee", esc)
    assert allowed("echo hi | tee /dev/null", esc)
```

- [ ] **Step 2: Run them to verify they fail**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_judge.py
```

Expected: `ModuleNotFoundError: No module named 'claude_guard.judge'`.

- [ ] **Step 3: Write the judge**

`home/dot_local/share/claude-guard/claude_guard/judge.py`:

```python
"""The compound decision, ported from allow-compound-bash.sh as it decides TODAY.

A chain is allowed when every segment is allow-listed or passes a check, and no segment
matches deny or ask. Everything that makes the bash defer makes this defer, in the same
order, with the bash line cited beside it. This is a PORT: the #477 rules (a newline as
`;`, a quoted-heredoc write, `set -e`/`VAR=`/`timeout` stripping) and the spec's "a single
segment is judged like a chain" are slice 3. Today a command containing none of `&&`, `;`,
`|` gets no decision at all (:51-59), and this module keeps that.
"""

import re
from dataclasses import dataclass

from claude_guard.checks.curl import curl_safe
from claude_guard.checks.scratch import rm_confined
from claude_guard.rules import Rules
from claude_guard.segment import parse

# :191. Wrapper commands take another command as an ARGUMENT and exec it.
WRAPPERS = frozenset({"timeout", "env", "nice", "nohup", "setsid", "stdbuf", "xargs"})

_DEVNULL_REDIRECT = re.compile(r"[0-9]*>>?\s*/dev/null")
_FD_DUP = re.compile(r"[0-9]*>&[0-9-]")
_OPTION_WORD = re.compile(r"\s+-\S+")
_DEVNULL_WORD = re.compile(r"\s+/dev/null")


@dataclass(frozen=True, slots=True)
class Decision:
    allow: bool
    rule: str
    reasons: tuple[str, ...]


def _trim(s: str) -> str:
    """:137-142. Spaces and tabs only."""
    return s.strip(" \t")


def _first_word(s: str) -> str:
    """`${s%%[[:space:]]*}`: everything before the first whitespace character."""
    return re.split(r"\s", s, maxsplit=1)[0]


def _basename(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def unwrap_wrapper(segment: str) -> str | None:
    """:181-270. Resolve a segment to the command that will actually execute.

    A segment that is not a wrapper comes back unchanged. None means the argument shape
    could not be read with confidence; the caller MUST defer, never fall back to the
    wrapper's own allow entry. The flag tables are closed: an unknown option is a refusal.
    """
    s = segment
    depth = 0
    while depth < 4:  # `timeout 5 nohup nice cmd` nests; a bound stops a cycle
        depth += 1
        t = s.split()
        n = len(t)
        if n == 0:
            return None
        w = _basename(t[0])
        if w not in WRAPPERS:
            return s
        i = 1
        if w in ("nohup", "setsid"):
            pass
        elif w == "nice":
            while i < n:
                tok = t[i]
                if tok == "-n":
                    i += 2
                    continue
                numeric = len(tok) > 1 and tok[0] == "-" and tok[1].isdigit()
                if numeric or tok.startswith("--adjustment="):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None
                break
        elif w == "timeout":
            while i < n:
                tok = t[i]
                if tok in ("--preserve-status", "--foreground", "-v", "--verbose"):
                    i += 1
                    continue
                if tok in ("-s", "-k"):
                    i += 2
                    continue
                if tok.startswith("--signal=") or tok.startswith("--kill-after="):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None
                break
            # :218-224. The duration is positional and mandatory.
            if i >= n or not t[i][:1].isdigit():
                return None
            i += 1
        elif w == "env":
            # :225-235. Only the plain `env VAR=VALUE... cmd` shape; every option refused.
            while i < n:
                tok = t[i]
                if tok.startswith("-"):
                    return None
                if "=" in tok:
                    i += 1
                    continue
                break
        elif w == "stdbuf":
            while i < n:
                tok = t[i]
                if (len(tok) > 2 and tok[0] == "-" and tok[1] in "ioe") or tok.startswith(
                    ("--input=", "--output=", "--error=")
                ):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None  # includes the separated `-o L` form
                break
        elif w == "xargs":
            while i < n:
                tok = t[i]
                if tok in ("-0", "-r", "-t", "-x", "-p", "--null", "--no-run-if-empty",
                           "--verbose", "--interactive"):
                    i += 1
                    continue
                if tok in ("-n", "-I", "-P", "-d", "-a", "-L", "-s", "-E"):
                    i += 2
                    continue
                if len(tok) > 2 and tok[0] == "-" and tok[1] in "nIPdaLsE":
                    i += 1
                    continue
                if tok.startswith(("--max-args=", "--replace=", "--max-procs=", "--delimiter=",
                                   "--arg-file=", "--max-lines=", "--max-chars=", "--eof=")):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None  # -e and -l carry OPTIONAL arguments; arity is unknowable
                break
            if i >= n:
                return None  # bare xargs runs echo; there is no command word to judge
        if i >= n:
            return None
        # :262-266. Word splitting above is naive, so a quote among the consumed tokens
        # means the real boundaries are not where they appear. Refuse rather than guess.
        if any("'" in tok or '"' in tok for tok in t[:i]):
            return None
        s = " ".join(t[i:])
    return None


def judge_segment(part: str, rules: Rules, roots: tuple[str, ...]) -> tuple[bool, str]:
    """:286-395, one iteration of the loop. (ok, reason)."""
    # :293-300. Redirection turns an allow-listed reader into a writer. /dev/null and fd
    # dups are the harmless cases and are everywhere in diagnostics.
    redir = _FD_DUP.sub("", _DEVNULL_REDIRECT.sub("", part))
    if ">" in redir:
        return False, "redirect"

    # :302-313. tee writes every path it is handed. Judge the command WORD, not a glob
    # over the segment: `tee /usr/bin/tee` must not look harmless.
    teed = _DEVNULL_WORD.sub("", _OPTION_WORD.sub("", part))
    teecmd = _first_word(teed)
    if _basename(teecmd) == "tee" and teed != teecmd:
        return False, "tee"

    # :315-319. Deny → defer. No exception below reaches past this.
    if rules.denies(part):
        return False, "deny"

    # :321-341. The one ask-listed segment named as safe here: `git merge --ff-only <ref>`
    # with exactly one ref that does not look like an option, read off the
    # redirect-stripped form because nearly every real call carries `2>&1`.
    if part.startswith("git merge --ff-only "):
        ffref = _trim(redir.removeprefix("git merge --ff-only "))
        if ffref and not ffref.startswith("-") and not re.search(r"\s", ffref):
            return True, "ff-only"

    # :343-357. A provably-safe curl or a confined rm resolves its own ask rule. After
    # deny, before ask: where the standalone hooks sit relative to this one.
    word = _basename(_first_word(part))
    if word == "curl" and curl_safe(part):
        return True, "curl-check"
    if word == "rm" and rm_confined(part, roots):
        return True, "rm-check"

    # :359-363.
    if rules.asks(part):
        return False, "ask"

    # :365-372. Honour the allow list as written before unwrapping, or a narrowed rule
    # such as `/usr/bin/env bash --version` becomes unreachable.
    if rules.allows(part):
        return True, "allow-list"

    # :374-378.
    target = unwrap_wrapper(part)
    if target is None:
        return False, "wrapper-unreadable"
    if target == part:
        return False, "unlisted"

    # :380-387. The unwrapped command earns the same deny/ask scrutiny.
    if rules.denies(target) or rules.asks(target):
        return False, "wrapper-target-deny-or-ask"
    if not rules.allows(target):
        return False, "wrapper-target-unlisted"
    return True, f"wrapper:{target}"


def judge(command: str, rules: Rules, roots: tuple[str, ...]) -> Decision:
    # :51-59. Only a compound command is eligible: a literal substring test, deliberately.
    if "&&" not in command and ";" not in command and "|" not in command:
        return Decision(False, "not-compound", ())

    # :277-281.
    if rules.whole_glob_defer(command):
        return Decision(False, "whole-glob", ())

    # :402-403. The segmenter's refusal is a refusal, never a skip.
    parsed = parse(command)
    if not parsed.ok:
        return Decision(False, parsed.status, ())

    # :404-428. Two things stay conservative on purpose: a substitution's content is an
    # opaque atom this judge cannot vet, and a heredoc body is never scanned for one; a
    # bare `&` or a newline separator never reached judge() under the old splitter.
    if parsed.substitutions:
        return Decision(False, "unjudgeable:substitution", ())
    last = len(parsed.segments) - 1
    for i, seg in enumerate(parsed.segments):
        if any(seg.heredocs):
            return Decision(False, "unjudgeable:heredoc", ())
        if i < last and seg.sep in ("&", "newline"):
            return Decision(False, "unjudgeable:separator", ())

    reasons: list[str] = []
    for i, seg in enumerate(parsed.segments):
        part = _trim(seg.text)
        if not part:
            continue
        ok, reason = judge_segment(part, rules, roots)
        reasons.append(reason)
        if not ok:
            return Decision(False, f"segment:{i}:{reason}", tuple(reasons))
    return Decision(True, "allow", tuple(reasons))
```

- [ ] **Step 4: Run the tests to verify they pass, then ruff**

Same command. Expected: all pass. On a divergence, drive the bash on the same input with the same fixture: write the fixture to a temp HOME and run `printf '%s' '{"tool_input":{"command":"…"}}' | HOME=/tmp/that CMDPARSE_LIB=$PWD/../../../private_dot_claude/hooks/executable_cmdparse.sh bash ../../../private_dot_claude/hooks/executable_allow-compound-bash.sh`; fix the port. `ruff check .` clean.

- [ ] **Step 5: Commit**

```bash
git add claude_guard/judge.py tests/test_judge.py
git commit -m "Port allow-compound-bash.sh's decision as judge.py

The literal eligibility gate, the whole-command glob defer, the four
unjudgeable shapes and the per-segment order (redirect, tee, deny, ff-only,
curl, rm, ask, allow, unwrap) are the bash's, line-cited. The node suite's
cases port one for one against the same four settings fixtures. No policy
moves here: the #477 rules and single-segment judging are slice 3."
```

---

### Task 5: `hook.py` and the `permission-request` subcommand, with shadow mode and `shadow-report`

**Files:**
- Create: `home/dot_local/share/claude-guard/claude_guard/hook.py`
- Modify: `home/dot_local/share/claude-guard/claude_guard/cli.py` (docstring, two new subparsers, `build_parser`)
- Create: `home/dot_local/share/claude-guard/tests/test_hook.py` (function-level tests in this task; the shim tests are appended in Task 6)

**Interfaces:**
- Consumes: `judge.judge`, `judge.Decision`, `rules.load_rules`, `tables.scratch_roots`, `cli.build_parser`, `cli.main`.
- Produces:
  - `hook.permission_request(stdin_text: str, env: Mapping[str, str], hooks_dir: Path | None = None, log_dir: Path | None = None) -> str | None`: the JSON line to print, or None for no decision. Never raises.
  - `hook.ALLOW_JSON: str`, `hook.BASH_CHAIN: tuple[str, ...]`, `hook.LOG_NAME = "claude-guard-shadow.jsonl"`.
  - `hook.shadow_mode(env) -> tuple[bool, bool]` = `(shadow, log_this_call)`.
  - `hook.bash_chain_allows(hooks_dir: Path, stdin_text: str, env: Mapping[str, str]) -> str | None`: the name of the first bash hook that printed an allow, or None.
  - `hook.shadow_record(command: str, decision: Decision, bash_hook: str | None) -> dict` with keys `ts`, `cmd_sha`, `python`, `bash`, `rule`, `bash_hook`.
  - `hook.summarize(lines: Iterable[str]) -> dict` and the `claude-guard shadow-report [--log PATH]` subcommand that prints it.
  - The env contract: `CLAUDE_GUARD_SHADOW=1` means never decide; within shadow, `CLAUDE_GUARD_SHADOW_SAMPLE=N` logs 1 in N calls (`CLAUDE_GUARD_SHADOW_ROLL` overrides the draw, a test seam) and no `SAMPLE` logs every call. `CLAUDE_GUARD_BASH_HOOKS_DIR` (default `$HOME/.claude/hooks`) is where the bash chain lives; `CLAUDE_SHADOW_LOG_DIR` (default `$HOME/.claude/logs`, the same variable `block-dangerous-bash.sh:526` reads) is where the log goes.

Why the sampling knob governs LOGGING and not deciding: the census idiom in `block-dangerous-bash.sh:423-435` samples which calls write a row, while the decision path is unaffected. Here the decision path is what shadow suppresses, so a sampled miss must still decide nothing in slice 2. Two knobs, one meaning each.

- [ ] **Step 1: Write the failing tests**

`home/dot_local/share/claude-guard/tests/test_hook.py`:

```python
"""The PermissionRequest contract: stdin JSON in, a decision line or nothing out.

Function-level here; Task 6 appends the tests that drive the shim as a subprocess with a
temp HOME the way tests/hooks/allow-compound-bash.test.js drives the bash hook.
"""

import json
import shutil
from pathlib import Path

import pytest

from claude_guard import hook
from claude_guard.hook import ALLOW_JSON, LOG_NAME, permission_request, shadow_mode, summarize
from claude_guard.judge import Decision

PKG_DIR = Path(__file__).resolve().parents[1]
HOOKS = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks"

skip_no_bash = pytest.mark.skipif(
    not (shutil.which("bash") and shutil.which("jq") and (HOOKS / "executable_allow-compound-bash.sh").exists()),
    reason="bash chain unavailable",
)

PERMS = {"allow": ["Bash(git status:*)", "Bash(ls:*)", "Bash(echo:*)"], "deny": ["Bash(rm:*)"], "ask": []}


def home_with(tmp_path: Path, perms: dict = PERMS) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({"permissions": perms}))
    return home


def payload(command: str) -> str:
    return json.dumps({"tool_input": {"command": command}})


def env_for(home: Path, **extra: str) -> dict[str, str]:
    return {"HOME": str(home), "PATH": "/usr/bin:/bin", **extra}


# --- live mode -----------------------------------------------------------------------------

def test_live_mode_prints_the_allow_line_for_an_allowed_chain(tmp_path):
    home = home_with(tmp_path)
    assert permission_request(payload("git status && ls"), env_for(home, CLAUDE_GUARD_SHADOW="0")) == ALLOW_JSON


def test_live_mode_prints_nothing_for_a_refused_chain(tmp_path):
    home = home_with(tmp_path)
    assert permission_request(payload("git status && rm -rf /"), env_for(home, CLAUDE_GUARD_SHADOW="0")) is None


def test_malformed_or_command_less_stdin_is_no_decision(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="0")
    assert permission_request("{ not json", env) is None
    assert permission_request(json.dumps({"tool_input": {}}), env) is None
    assert permission_request(json.dumps({"tool_input": {"command": 5}}), env) is None
    assert permission_request("", env) is None


# --- the env contract ----------------------------------------------------------------------

def test_shadow_mode_is_off_unless_the_variable_is_exactly_1():
    assert shadow_mode({}) == (False, False)
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "0"}) == (False, False)
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "1"}) == (True, True)


def test_sampling_governs_logging_only_and_the_roll_seam_picks_the_branch():
    on = {"CLAUDE_GUARD_SHADOW": "1", "CLAUDE_GUARD_SHADOW_SAMPLE": "10"}
    assert shadow_mode({**on, "CLAUDE_GUARD_SHADOW_ROLL": "0"}) == (True, True)
    assert shadow_mode({**on, "CLAUDE_GUARD_SHADOW_ROLL": "3"}) == (True, False)
    # A malformed denominator falls back to logging every call, never to deciding.
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "1", "CLAUDE_GUARD_SHADOW_SAMPLE": "x"}) == (True, True)


# --- shadow mode ---------------------------------------------------------------------------

@skip_no_bash
def test_shadow_mode_prints_nothing_and_logs_one_line_that_agrees_with_the_bash_chain(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(HOOKS))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    lines = (log_dir / LOG_NAME).read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["python"] == "allow" and rec["bash"] == "allow"
    assert rec["bash_hook"] == "allow-compound-bash.sh"
    assert rec["rule"] == "allow"
    assert len(rec["cmd_sha"]) == 16 and rec["ts"].endswith("Z")


@skip_no_bash
def test_shadow_mode_logs_a_refusal_both_sides_agree_on(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(HOOKS))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && rm -rf /"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == ("none", "none", None)
    assert rec["rule"] == "segment:1:deny"


def test_shadow_log_records_a_disagreement_so_the_comparison_can_go_red(tmp_path):
    # A fake bash chain that allows everything: python says none, bash says allow.
    fake = tmp_path / "hooks"
    fake.mkdir()
    for name in hook.BASH_CHAIN:
        p = fake / name
        p.write_text('#!/bin/bash\ncat >/dev/null\nprintf \'{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}\\n\'\n')
        p.chmod(0o755)
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && frobnicate"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == ("none", "allow", "allow-compound-bash.sh")


def test_the_shadow_log_never_carries_the_command(tmp_path):
    fake = tmp_path / "hooks"
    fake.mkdir()  # no hooks at all: bash side is "none"
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    permission_request(payload("git status && ls /very/secret/path"), env, log_dir=log_dir)
    text = (log_dir / LOG_NAME).read_text()
    assert "secret" not in text
    assert set(json.loads(text)) == {"ts", "cmd_sha", "python", "bash", "rule", "bash_hook"}


def test_a_sampled_miss_still_decides_nothing_and_writes_nothing(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_SHADOW_SAMPLE="10",
                  CLAUDE_GUARD_SHADOW_ROLL="7", CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    assert not (log_dir / LOG_NAME).exists()


def test_an_unwritable_log_dir_is_swallowed(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path))
    blocked = tmp_path / "file-not-dir"
    blocked.write_text("")
    assert permission_request(payload("git status && ls"), env, log_dir=blocked / "logs") is None


# --- shadow-report -------------------------------------------------------------------------

def test_summarize_counts_agreement_and_names_the_rules_behind_each_disagreement():
    rows = [
        {"python": "allow", "bash": "allow", "rule": "allow", "bash_hook": "allow-compound-bash.sh"},
        {"python": "none", "bash": "none", "rule": "segment:1:deny", "bash_hook": None},
        {"python": "none", "bash": "allow", "rule": "segment:0:redirect", "bash_hook": "allow-safe-curl.sh"},
        {"python": "allow", "bash": "none", "rule": "allow", "bash_hook": None},
        {"python": "allow", "bash": "none", "rule": "allow", "bash_hook": None},
    ]
    s = summarize(json.dumps(r) for r in rows)
    assert s["records"] == 5
    assert s["agree"] == 2 and s["agree_allow"] == 1 and s["agree_none"] == 1
    assert s["python_only"] == 2 and s["bash_only"] == 1
    assert s["python_only_rules"] == {"allow": 2}
    assert s["bash_only_rules"] == {"segment:0:redirect (allow-safe-curl.sh)": 1}


def test_summarize_skips_an_unparseable_line_and_reports_it():
    s = summarize(["{ nope", json.dumps({"python": "none", "bash": "none", "rule": "x", "bash_hook": None})])
    assert s["records"] == 1 and s["unparseable"] == 1


def test_shadow_record_shape():
    rec = hook.shadow_record("ls; pwd", Decision(True, "allow", ("allow-list", "allow-list")), None)
    assert rec["python"] == "allow" and rec["bash"] == "none" and rec["rule"] == "allow"
    assert rec["cmd_sha"] == hook.command_sha("ls; pwd")
```

- [ ] **Step 2: Run them to verify they fail**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_hook.py
```

Expected: `ModuleNotFoundError: No module named 'claude_guard.hook'`.

- [ ] **Step 3: Write `hook.py`**

`home/dot_local/share/claude-guard/claude_guard/hook.py`:

```python
"""The PermissionRequest hook: stdin JSON in, one allow line or nothing out.

Failure contract (spec, *Failure contracts*, allow path): cannot run or cannot parse → emit
nothing, so the prompt stands. permission_request() therefore never raises.

Shadow mode (spec, *Rollout* row 2): with CLAUDE_GUARD_SHADOW=1 the judge's verdict is
computed, the deployed bash chain is run on the same stdin the way the harness would (any
allow wins), one JSON line is appended to the shadow log, and NOTHING is printed. The log
carries a hash of the command, never the command. `claude-guard shadow-report` reads it.

Sampling: within shadow, CLAUDE_GUARD_SHADOW_SAMPLE=N logs 1 in N calls, chosen fresh each
call; CLAUDE_GUARD_SHADOW_ROLL overrides the draw for tests. Same idiom as the M02 census in
block-dangerous-bash.sh:423-435, except that here sampling governs LOGGING only: a sampled
miss still decides nothing, because deciding is what shadow suppresses.
"""

import hashlib
import json
import random
import subprocess
import time
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path

from claude_guard.judge import Decision, judge
from claude_guard.rules import load_rules
from claude_guard.tables import scratch_roots

ALLOW_JSON = (
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
)
# The deployed hooks this one shadows, in registration order (settings.base.json,
# PermissionRequest). allow-readonly-remote.sh and allow-daniel-server.sh are not ported in
# this slice and are not compared.
BASH_CHAIN = ("allow-compound-bash.sh", "allow-safe-rm.sh", "allow-safe-curl.sh")
LOG_NAME = "claude-guard-shadow.jsonl"
_HOOK_TIMEOUT = 3.0


def read_command(stdin_text: str) -> str | None:
    try:
        data = json.loads(stdin_text)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command")
    return command if isinstance(command, str) else None


def decide(command: str, env: Mapping[str, str]) -> Decision:
    rules = load_rules(env=env)
    roots = scratch_roots(env.get("HOME", ""), env.get("TMPDIR"))
    return judge(command, rules, roots)


def shadow_mode(env: Mapping[str, str]) -> tuple[bool, bool]:
    """(shadow, log_this_call)."""
    if env.get("CLAUDE_GUARD_SHADOW", "") != "1":
        return False, False
    sample = env.get("CLAUDE_GUARD_SHADOW_SAMPLE", "")
    if not (sample.isdigit() and int(sample) > 0):
        return True, True
    roll = env.get("CLAUDE_GUARD_SHADOW_ROLL", "")
    draw = int(roll) if roll.isdigit() else random.randrange(int(sample))
    return True, draw == 0


def resolve_hook(hooks_dir: Path, name: str) -> Path | None:
    """Deployed name first, then the chezmoi source name, as allow-compound-bash.sh:115-116."""
    for candidate in (hooks_dir / name, hooks_dir / f"executable_{name}"):
        if candidate.is_file():
            return candidate
    return None


def bash_chain_allows(hooks_dir: Path, stdin_text: str, env: Mapping[str, str]) -> str | None:
    child_env = dict(env)
    for lib, var in (("cmdparse.sh", "CMDPARSE_LIB"), ("hook-input.sh", "HOOK_INPUT_LIB")):
        found = resolve_hook(hooks_dir, lib)
        if found is not None:
            child_env.setdefault(var, str(found))
    for name in BASH_CHAIN:
        path = resolve_hook(hooks_dir, name)
        if path is None:
            continue
        try:
            r = subprocess.run(
                ["bash", str(path)], input=stdin_text, capture_output=True, text=True,
                env=child_env, timeout=_HOOK_TIMEOUT, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if '"allow"' in r.stdout:
            return name
    return None


def command_sha(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8", "surrogateescape")).hexdigest()[:16]


def shadow_record(command: str, decision: Decision, bash_hook: str | None) -> dict:
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cmd_sha": command_sha(command),
        "python": "allow" if decision.allow else "none",
        "bash": "allow" if bash_hook else "none",
        "rule": decision.rule,
        "bash_hook": bash_hook,
    }


def append_log(log_dir: Path, record: dict) -> None:
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / LOG_NAME).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        return


def permission_request(
    stdin_text: str,
    env: Mapping[str, str],
    hooks_dir: Path | None = None,
    log_dir: Path | None = None,
) -> str | None:
    try:
        command = read_command(stdin_text)
        if command is None:
            return None
        decision = decide(command, env)
        shadow, log_this = shadow_mode(env)
        if not shadow:
            return ALLOW_JSON if decision.allow else None
        if log_this:
            home = Path(env.get("HOME", ""))
            hooks = hooks_dir or Path(env.get("CLAUDE_GUARD_BASH_HOOKS_DIR") or home / ".claude" / "hooks")
            logs = log_dir or Path(env.get("CLAUDE_SHADOW_LOG_DIR") or home / ".claude" / "logs")
            bash_hook = bash_chain_allows(hooks, stdin_text, env)
            append_log(logs, shadow_record(command, decision, bash_hook))
        return None
    except Exception:
        return None


def summarize(lines: Iterable[str]) -> dict:
    """Counts only: agree / python-only / bash-only and the rules behind each disagreement."""
    records = 0
    unparseable = 0
    agree_allow = agree_none = python_only = bash_only = 0
    python_only_rules: Counter[str] = Counter()
    bash_only_rules: Counter[str] = Counter()
    for line in lines:
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            unparseable += 1
            continue
        records += 1
        py, sh = rec.get("python"), rec.get("bash")
        if py == sh:
            if py == "allow":
                agree_allow += 1
            else:
                agree_none += 1
        elif py == "allow":
            python_only += 1
            python_only_rules[str(rec.get("rule"))] += 1
        else:
            bash_only += 1
            bash_only_rules[f"{rec.get('rule')} ({rec.get('bash_hook')})"] += 1
    return {
        "records": records,
        "unparseable": unparseable,
        "agree": agree_allow + agree_none,
        "agree_allow": agree_allow,
        "agree_none": agree_none,
        "python_only": python_only,
        "bash_only": bash_only,
        "python_only_rules": dict(python_only_rules),
        "bash_only_rules": dict(bash_only_rules),
    }
```

- [ ] **Step 4: Wire the two subcommands into `cli.py`**

Replace the module docstring of `home/dot_local/share/claude-guard/claude_guard/cli.py` with:

```python
"""claude-guard command line.

    claude-guard permission-request        # hook entry: hook JSON on stdin, allow line or
                                            # nothing on stdout; shadow when CLAUDE_GUARD_SHADOW=1
    claude-guard shadow-report [--log P]   # agree / python-only / bash-only counts from the log
    claude-guard segment --json            # decomposition of the command on stdin,
                                            # cmdparse.sh's shape
    claude-guard explain "<command>"       # the segments, and the decision with its rule
    claude-guard replay <jsonl> --compare-bash <cmdparse.sh>
                                            # parity of every {command, cwd} record
                                            # against the bash segmenter
    claude-guard replay <jsonl> --judge [--compare-hooks DIR]
                                            # allow count and the allowed commands; with
                                            # --compare-hooks, agreement with the bash chain

`segment --json` exists for tests and the parity gate, never for the hook path. The
`pre-tool-use` entry point arrives with deny.py in slice 4.
"""
```

Add these imports beside the existing ones:

```python
import os

from claude_guard.hook import LOG_NAME, permission_request, summarize
```

Add these two functions above `build_parser`:

```python
def cmd_permission_request(args: argparse.Namespace) -> int:
    # The allow-path failure contract: nothing on stdout, exit 0, whatever happens.
    try:
        out = permission_request(sys.stdin.read(), os.environ)
    except Exception:
        return 0
    if out:
        print(out)
    return 0


def cmd_shadow_report(args: argparse.Namespace) -> int:
    default_dir = Path(os.environ.get("CLAUDE_SHADOW_LOG_DIR") or Path.home() / ".claude" / "logs")
    log = Path(args.log) if args.log else (default_dir / LOG_NAME)
    if not log.exists():
        print(f"no shadow log at {log}")
        return 1
    s = summarize(log.read_text().splitlines())
    print(f"records {s['records']} (unparseable {s['unparseable']})")
    print(f"agree {s['agree']} (allow {s['agree_allow']}, none {s['agree_none']})")
    print(f"python-only {s['python_only']}")
    for rule, n in sorted(s["python_only_rules"].items(), key=lambda kv: -kv[1]):
        print(f"  {rule}: {n}")
    print(f"bash-only {s['bash_only']}")
    for rule, n in sorted(s["bash_only_rules"].items(), key=lambda kv: -kv[1]):
        print(f"  {rule}: {n}")
    return 0
```

And in `build_parser`, before the `segment` subparser:

```python
    p = sub.add_parser("permission-request", help="PermissionRequest hook entry (stdin JSON)")
    p.set_defaults(fn=cmd_permission_request)

    sr = sub.add_parser("shadow-report", help="summarise the shadow log; counts, never commands")
    sr.add_argument("--log", default=None, help=f"path to the log (default: $CLAUDE_SHADOW_LOG_DIR/{LOG_NAME})")
    sr.set_defaults(fn=cmd_shadow_report)
```

- [ ] **Step 5: Append the CLI-level tests to `tests/test_cli.py`**

```python
def test_permission_request_prints_the_allow_line_in_live_mode(tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(ls:*)", "Bash(pwd)"], "deny": [], "ask": []}})
    )
    r = subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", "permission-request"],
        input=json.dumps({"tool_input": {"command": "ls; pwd"}}), capture_output=True, text=True,
        cwd=PKG_DIR, env={"PYTHONPATH": str(PKG_DIR), "PATH": "/usr/bin:/bin", "HOME": str(home),
                          "CLAUDE_GUARD_SHADOW": "0"},
    )
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"] == "allow"


def test_permission_request_prints_nothing_and_exits_zero_on_garbage(tmp_path):
    r = subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", "permission-request"],
        input="{ nope", capture_output=True, text=True, cwd=PKG_DIR,
        env={"PYTHONPATH": str(PKG_DIR), "PATH": "/usr/bin:/bin", "HOME": str(tmp_path),
             "CLAUDE_GUARD_SHADOW": "0"},
    )
    assert (r.returncode, r.stdout) == (0, "")


def test_shadow_report_prints_counts_and_never_a_command(tmp_path):
    log = tmp_path / "claude-guard-shadow.jsonl"
    log.write_text(
        json.dumps({"python": "allow", "bash": "allow", "rule": "allow", "bash_hook": "allow-compound-bash.sh"}) + "\n"
        + json.dumps({"python": "none", "bash": "allow", "rule": "segment:1:ask", "bash_hook": "allow-safe-rm.sh"}) + "\n"
    )
    r = run("shadow-report", "--log", str(log))
    assert r.returncode == 0, r.stderr
    assert "records 2" in r.stdout
    assert "agree 1 (allow 1, none 0)" in r.stdout
    assert "bash-only 1" in r.stdout
    assert "segment:1:ask (allow-safe-rm.sh): 1" in r.stdout


def test_shadow_report_exits_nonzero_when_there_is_no_log(tmp_path):
    r = run("shadow-report", "--log", str(tmp_path / "absent.jsonl"))
    assert r.returncode == 1
```

- [ ] **Step 6: Run both files, then ruff**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_hook.py tests/test_cli.py
uv run --no-project --python 3.14 --with ruff ruff check .
```

Expected: all pass, none skipped on daniel-box (bash, jq and the source hooks are present). Ruff clean.

- [ ] **Step 7: Commit**

```bash
git add claude_guard/hook.py claude_guard/cli.py tests/test_hook.py tests/test_cli.py
git commit -m "Add the permission-request entry point with a shadow mode

Live mode prints the allow line or nothing and never raises. Shadow mode
computes the verdict, runs the deployed bash chain on the same stdin, logs
one hashed line, and decides nothing, so several days of agreement can be
read from shadow-report before slice 3 cuts over. Sampling governs the log
write only: a sampled miss must still decide nothing."
```

---

### Task 6: The PermissionRequest shim, its registration in shadow, the ledger, the README

**Files:**
- Create: `home/private_dot_claude/hooks/executable_guard-permission-request.sh`
- Modify: `home/.chezmoitemplates/settings.base.json` (the `env` block near line 113, and the `PermissionRequest` block at line 504)
- Modify: `tests/settings/settings-base-shape.test.js` (append one test)
- Modify: `home/dot_local/share/claude-guard/tests/test_hook.py` (append the shim tests)
- Modify: `config-soak.json` (via `node bin/config-soak land`)
- Modify: `home/dot_local/share/claude-guard/README.md`
- Modify: `home/dot_local/share/claude-guard/claude_guard/__init__.py` (docstring)

**Interfaces:**
- Consumes: `cli.py permission-request`, the env contract from Task 5.
- Produces: `~/.claude/hooks/guard-permission-request.sh` on a deployed machine; the `CLAUDE_GUARD_SHADOW` setting in the generated `settings.json`.

How env reaches a hook here: the existing registrations carry no per-hook env. `CMDPARSE_SHADOW_SAMPLE` is set in the top-level `"env"` block of `settings.base.json` (line 113) and read by `block-dangerous-bash.sh`, a hook, so that block is the lever. Belt and braces: the shim also defaults `CLAUDE_GUARD_SHADOW` to `1` when the variable is absent, so a machine whose `settings.json` has not been regenerated yet cannot run this hook live by accident. Slice 3 flips both the `env` entry and the shim default in one PR.

- [ ] **Step 1: Append the failing shim tests to `tests/test_hook.py`**

```python
# --- the shim, driven as the harness drives it ---------------------------------------------

SHIM = HOOKS / "executable_guard-permission-request.sh"
BASH = shutil.which("bash") or "/bin/bash"
skip_no_uv = pytest.mark.skipif(not shutil.which("uv"), reason="uv unavailable")


def run_shim(stdin_text: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [BASH, str(SHIM)], input=stdin_text, capture_output=True, text=True, env=env
    )


def shim_env(home: Path, **extra: str) -> dict[str, str]:
    return {
        "HOME": str(home), "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "CLAUDE_GUARD_HOME": str(PKG_DIR), "CLAUDE_GUARD_BASH_HOOKS_DIR": str(HOOKS), **extra,
    }


@skip_no_uv
def test_shim_prints_the_allow_line_when_told_to_run_live(tmp_path):
    home = home_with(tmp_path)
    r = run_shim(payload("git status && ls"), shim_env(home, CLAUDE_GUARD_SHADOW="0"))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"] == "allow"


@skip_no_uv
def test_shim_defaults_to_shadow_when_the_variable_is_absent(tmp_path):
    home = home_with(tmp_path)
    r = run_shim(payload("git status && ls"), shim_env(home, CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs")))
    assert (r.returncode, r.stdout) == (0, "")
    assert (tmp_path / "logs" / LOG_NAME).exists()


@skip_no_uv
def test_shim_in_shadow_prints_nothing_for_an_allowed_chain(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")
    rec = json.loads((tmp_path / "logs" / LOG_NAME).read_text())
    assert rec["python"] == "allow"


def test_shim_prints_nothing_and_exits_zero_without_an_interpreter(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="0", PATH="/nonexistent")
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")


def test_shim_prints_nothing_and_exits_zero_when_the_package_is_missing(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="0", CLAUDE_GUARD_HOME=str(tmp_path / "nowhere"))
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")
```

These use `subprocess` and `os`: add `import os` and `import subprocess` to the import block at the top of `tests/test_hook.py` (ruff `I001` orders them).

- [ ] **Step 2: Run to verify they fail**

Same pytest command on `tests/test_hook.py`. Expected: the five new tests fail because the shim file does not exist (`FileNotFoundError` from `subprocess.run` or bash reporting "No such file").

- [ ] **Step 3: Write the shim**

`home/private_dot_claude/hooks/executable_guard-permission-request.sh`:

```bash
#!/usr/bin/env bash
# guard-permission-request.sh — PermissionRequest/Bash shim for the claude-guard package.
#
# Failure contract (spec docs/specs/2026-09-06-claude-guard-design.md, "Failure contracts",
# allow path): cannot run or cannot parse → emit NOTHING, exit 0, and the prompt stands. So
# a missing uv, a missing managed 3.14, a missing package, or a Python error all end here
# silently; this is an allow-only hook and silence is its safe state.
#
# Shadow (spec "Rollout" row 2): with CLAUDE_GUARD_SHADOW=1 the Python side computes its
# verdict, runs the deployed bash chain on the same stdin, appends one hashed line to
# ~/.claude/logs/claude-guard-shadow.jsonl and prints nothing. settings.base.json sets the
# variable in its env block; the default below is the belt to that brace, so a settings.json
# not yet regenerated cannot run this hook live. Slice 3 flips both in one PR.
#
# `--no-project` matters: without it, `uv python find` run inside a uv project answers with
# that project's venv. `-S` skips site-packages; the package is stdlib-only.
set -u
: "${CLAUDE_GUARD_SHADOW:=1}"
export CLAUDE_GUARD_SHADOW
SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[ -f "$SHARE/claude_guard/cli.py" ] || exit 0
PY=$(uv python find --no-project --managed-python 3.14 2>/dev/null) || exit 0
[ -x "$PY" ] || exit 0
PYTHONPATH="$SHARE" "$PY" -S -m claude_guard.cli permission-request
exit 0
```

```bash
chmod +x home/private_dot_claude/hooks/executable_guard-permission-request.sh
shellcheck home/private_dot_claude/hooks/executable_guard-permission-request.sh
```

Expected: shellcheck silent.

- [ ] **Step 4: Run the shim tests to verify they pass**

Same pytest command on `tests/test_hook.py`. Expected: all pass, none skipped.

- [ ] **Step 5: Register the hook and the env var in `settings.base.json`**

In the `"env"` block, directly after the line `"CMDPARSE_SHADOW_SAMPLE": "10",` (line 113), add:

```json
    {{/* claude-guard shadow (docs/specs/2026-09-06-claude-guard-design.md, Rollout row 2).
         guard-permission-request.sh is registered beside the bash PermissionRequest hooks
         below. With this set to 1 it computes its verdict, runs allow-compound-bash.sh,
         allow-safe-rm.sh and allow-safe-curl.sh on the same stdin, appends one hashed line
         to ~/.claude/logs/claude-guard-shadow.jsonl, and decides NOTHING. Read the log with
         `claude-guard shadow-report`. Slice 3 sets this to 0 and removes the three bash
         hooks in the same PR; the shim also defaults to 1 when the variable is absent, so a
         stale settings.json cannot run it live. CLAUDE_GUARD_SHADOW_SAMPLE=N would sample
         the log write 1-in-N; unset, every call logs, which is what a several-day
         agreement census wants. */}}
    "CLAUDE_GUARD_SHADOW": "1",
```

In the `PermissionRequest` block, directly after the `allow-safe-rm.sh` entry (the closing `},` of that object, before the `auto-approve-remote-ssh.sh used to be registered here` comment), add:

```json
          {{/* The Python port of the three hooks above, in SHADOW: it logs what it would
               have decided and decides nothing (env.CLAUDE_GUARD_SHADOW above). It stays
               beside them until shadow-report shows several days of agreement; then slice
               3 removes allow-compound-bash.sh, allow-safe-curl.sh and allow-safe-rm.sh and
               this entry becomes the decision. Contract: cannot run → emits nothing. */}}
          {
            "type": "command",
            "command": "~/.claude/hooks/guard-permission-request.sh",
            "timeout": 10
          },
```

- [ ] **Step 6: Pin the registration in the settings-shape suite**

Append to `tests/settings/settings-base-shape.test.js`, using the file's `render()` helper the way its "the rendered base template is valid JSON" test does:

```js
// claude-guard slice 2: the Python PermissionRequest hook runs beside the bash hooks it
// shadows, and the env block keeps it in shadow. Slice 3 changes all three assertions in
// one PR; until then, losing any one of them is a half-cutover.
test('claude-guard runs beside the bash PermissionRequest hooks, in shadow', { skip }, () => {
  const s = JSON.parse(render());
  const entry = s.hooks.PermissionRequest.find((e) => e.matcher === 'Bash');
  const cmds = entry.hooks.map((h) => h.command);
  assert.ok(cmds.includes('~/.claude/hooks/guard-permission-request.sh'), cmds.join(', '));
  for (const shadowed of ['allow-compound-bash.sh', 'allow-safe-rm.sh', 'allow-safe-curl.sh']) {
    assert.ok(cmds.includes(`~/.claude/hooks/${shadowed}`), `${shadowed} still registered`);
  }
  assert.strictEqual(s.env.CLAUDE_GUARD_SHADOW, '1');
});
```

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
node --test tests/settings/settings-base-shape.test.js 2>&1 | tail -6
```

Expected: `fail 0`, the new test passing.

- [ ] **Step 7: Acknowledge the ledger**

`config-soak` tracks every file under `home/private_dot_claude/hooks/` and the settings templates (`node bin/config-soak list`), so both edits need landing:

```bash
node bin/config-soak land home/private_dot_claude/hooks/executable_guard-permission-request.sh \
  home/.chezmoitemplates/settings.base.json
node bin/config-soak status | tail -3
```

Expected: `landed 2 change(s)` and no `GATE FAIL` line.

- [ ] **Step 8: README and package docstring**

Replace the first paragraph of `home/dot_local/share/claude-guard/README.md` with:

```markdown
One Python package for Claude Code Bash permission decisions. Slice 1 shipped the segmenter
and the CLI; slice 2 ships the settings loader, the compound judge, the scratch-rm and safe-curl
checks, and the PermissionRequest hook in shadow. The deny rules and the cutover are later
slices of the spec in `docs/specs/2026-09-06-claude-guard-design.md` (dotfiles repo).
```

Append to the README, before `## Tests`:

```markdown
## The judge

`claude_guard.judge.judge(command, rules, roots)` is `allow-compound-bash.sh`'s decision,
ported line for line. It allows a chain when every segment is allow-listed or passes a check
(`checks/scratch.py` for a confined `rm`, `checks/curl.py` for a plain GET/HEAD against an
allowlisted host, the `git merge --ff-only <ref>` exception) and no segment matches deny or
ask. A command containing none of `&&`, `;`, `|` gets no decision, as today. `rules.py` reads
the deployed settings with the scope asymmetry the bash documents: allow from
`~/.claude/settings.json` alone, deny and ask from that file plus the project's
`.claude/settings.json` and `settings.local.json`.

    claude-guard explain 'git status && timeout 5 ls'      # segments, then the decision and rule

## The hook, and shadow mode

`~/.claude/hooks/guard-permission-request.sh` runs `claude-guard permission-request` on the
PermissionRequest event. Cannot run or cannot parse → it prints nothing and the prompt stands.

With `CLAUDE_GUARD_SHADOW=1` (set in `settings.json`'s `env`, and the shim's default) it decides
nothing: it computes its verdict, runs the three bash hooks it will replace on the same stdin,
and appends one line to `~/.claude/logs/claude-guard-shadow.jsonl`:

    {"bash": "allow", "bash_hook": "allow-compound-bash.sh", "cmd_sha": "…16 hex…",
     "python": "allow", "rule": "allow", "ts": "2026-09-06T12:00:00Z"}

The command itself is never written. `CLAUDE_GUARD_SHADOW_SAMPLE=N` samples the log write
1-in-N; it never changes what is decided.

    claude-guard shadow-report                              # agree / python-only / bash-only, and the rules
    claude-guard replay commands.jsonl --judge              # allow count and the allowed commands
    claude-guard replay commands.jsonl --judge --compare-hooks ~/.claude/hooks
                                                            # agreement with the bash chain per record

The exit criterion for this slice is several days of `shadow-report` agreement; the cutover
is slice 3.
```

Replace the docstring of `home/dot_local/share/claude-guard/claude_guard/__init__.py` with:

```python
"""claude-guard: one Python package for Claude Code Bash permission decisions.

Slice 1 shipped the segmenter (`segment`) and the CLI. Slice 2 ships the settings loader
(`rules`), the compound judge (`judge`), the scratch-rm and safe-curl checks (`checks`), the
shared tables (`tables`) and the PermissionRequest entry (`hook`), registered in shadow.
The deny rules, the cutover and the homelab package are later slices; see
docs/specs/2026-09-06-claude-guard-design.md in the dotfiles repo.
"""
```

- [ ] **Step 9: Lint the shim and the template, then commit**

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
bin/lint-sh-templates && bin/lint-bsd-portability
node --test tests/lint-gate-coverage.test.js tests/settings/settings-base-shape.test.js 2>&1 | tail -4
git add home/private_dot_claude/hooks/executable_guard-permission-request.sh home/.chezmoitemplates/settings.base.json \
        tests/settings/settings-base-shape.test.js home/dot_local/share/claude-guard/tests/test_hook.py \
        home/dot_local/share/claude-guard/README.md home/dot_local/share/claude-guard/claude_guard/__init__.py \
        config-soak.json
git commit -m "Register the claude-guard PermissionRequest shim in shadow

Beside the three bash hooks it ports, deciding nothing: CLAUDE_GUARD_SHADOW=1
in the env block and as the shim's own default, so a stale settings.json
cannot run it live. The shim carries the allow-path failure contract: no
interpreter, no package or no parse all print nothing and exit 0. The
settings-shape test pins the three facts slice 3 changes together."
```

---

### Task 7: `replay --judge [--compare-hooks DIR]` and the decision line in `explain`

**Files:**
- Modify: `home/dot_local/share/claude-guard/claude_guard/cli.py` (`cmd_explain`, `cmd_replay`, `build_parser`)
- Modify: `home/dot_local/share/claude-guard/tests/test_cli.py` (append)

**Interfaces:**
- Consumes: `judge.judge`, `rules.load_rules`, `tables.scratch_roots`, `hook.bash_chain_allows`.
- Produces: `claude-guard replay <jsonl> --judge` prints one `ALLOW: <command head>` line per allowed record and a final `ALLOW n/N`; with `--compare-hooks DIR` it also runs the bash chain per record with `CLAUDE_PROJECT_DIR` set to the record's `cwd`, prints `MISMATCH: <head> python=<allow|none> bash=<allow|none> rule=<rule>` per disagreement and a final `AGREE k/N`, exit 1 on any mismatch. `--compare-bash` (slice 1) stays; the two modes are mutually exclusive. `explain` prints a last line `decision: allow|defer rule=<rule>` and, per judged segment, ` -> <reason>`.

The judge reads the REAL settings for the environment it runs in (`HOME`, `CLAUDE_PROJECT_DIR`), which is what makes replay the cutover gate rather than a fixture test. The record's `cwd` becomes `CLAUDE_PROJECT_DIR` for both sides, so project-scope deny/ask apply identically.

- [ ] **Step 1: Append the failing tests to `tests/test_cli.py`**

```python
HOOKS_DIR = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks"


def home_with_allow(tmp_path: Path, *rules: str) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": list(rules), "deny": [], "ask": ["Bash(rm:*)"]}})
    )
    return home


def run_home(home: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", *args],
        capture_output=True, text=True, cwd=PKG_DIR,
        env={"PYTHONPATH": str(PKG_DIR), "PATH": "/usr/bin:/bin", "HOME": str(home)},
    )


def test_explain_prints_the_decision_and_the_rule_per_segment(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    r = run_home(home, "explain", "ls; timeout 5 pwd")
    assert r.returncode == 0, r.stderr
    assert r.stdout.splitlines()[-1] == "decision: allow rule=allow"
    assert "[1] sep=eof heredocs=0: timeout 5 pwd -> wrapper:pwd" in r.stdout


def test_explain_names_the_refusing_segment(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)")
    r = run_home(home, "explain", "ls && frobnicate")
    assert r.stdout.splitlines()[-1] == "decision: defer rule=segment:1:unlisted"


def test_replay_judge_prints_the_allowed_commands_and_the_count(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(
        json.dumps({"command": "ls; pwd", "cwd": "/tmp"}) + "\n"
        + json.dumps({"command": "ls && frobnicate", "cwd": "/tmp"}) + "\n"
        + json.dumps({"command": "rm -rf /tmp/x && ls", "cwd": "/tmp"}) + "\n"
    )
    r = run_home(home, "replay", str(corpus), "--judge")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.splitlines()
    assert lines[-1] == "ALLOW 2/3"
    assert "ALLOW: ls; pwd" in lines and "ALLOW: rm -rf /tmp/x && ls" in lines


def test_replay_judge_applies_the_records_cwd_as_the_project_scope(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    (proj / ".claude" / "settings.json").write_text(json.dumps({"permissions": {"deny": ["Bash(pwd)"]}}))
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls; pwd", "cwd": str(proj)}) + "\n")
    r = run_home(home, "replay", str(corpus), "--judge")
    assert r.stdout.splitlines()[-1] == "ALLOW 0/1"


@pytest.mark.skipif(not (HOOKS_DIR / "executable_allow-compound-bash.sh").exists(), reason="bash hooks not beside a deployed copy")
def test_replay_compare_hooks_reports_agreement_with_the_bash_chain(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(
        json.dumps({"command": "ls; pwd", "cwd": "/tmp"}) + "\n"
        + json.dumps({"command": "ls && frobnicate", "cwd": "/tmp"}) + "\n"
    )
    r = run_home(home, "replay", str(corpus), "--judge", "--compare-hooks", str(HOOKS_DIR))
    assert r.returncode == 0, r.stderr + r.stdout
    assert r.stdout.splitlines()[-1] == "AGREE 2/2"


def test_replay_compare_hooks_exits_nonzero_on_a_mismatch(tmp_path):
    # A fake chain that allows everything proves the comparison can go red.
    fake = tmp_path / "hooks"
    fake.mkdir()
    (fake / "allow-compound-bash.sh").write_text('#!/bin/bash\ncat >/dev/null\nprintf \'{"decision":{"behavior":"allow"}}\\n\'\n')
    (fake / "allow-compound-bash.sh").chmod(0o755)
    home = home_with_allow(tmp_path, "Bash(ls:*)")
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls && frobnicate", "cwd": "/tmp"}) + "\n")
    r = run_home(home, "replay", str(corpus), "--judge", "--compare-hooks", str(fake))
    assert r.returncode == 1
    assert "MISMATCH: ls && frobnicate python=none bash=allow rule=segment:1:unlisted" in r.stdout
    assert r.stdout.splitlines()[-1] == "AGREE 0/1"


def test_replay_refuses_both_modes_or_neither(tmp_path):
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls", "cwd": "/tmp"}) + "\n")
    assert run("replay", str(corpus)).returncode == 2
    assert run("replay", str(corpus), "--judge", "--compare-bash", "/x").returncode == 2
```

- [ ] **Step 2: Run to verify they fail**

Same pytest command on `tests/test_cli.py`. Expected: the new tests fail (`explain` has no decision line; `--judge` is an unrecognised argument, exit 2; the "both modes" test fails on the first assertion because a bare `replay` currently errors on the missing `--compare-bash` with exit 2 — that one may already pass, which is fine).

- [ ] **Step 3: Extend `cli.py`**

Add the imports:

```python
from claude_guard.hook import bash_chain_allows
from claude_guard.judge import judge
from claude_guard.rules import load_rules
from claude_guard.tables import scratch_roots
```

Replace `cmd_explain` with:

```python
def cmd_explain(args: argparse.Namespace) -> int:
    p = parse(args.command)
    print(f"status: {p.status}")
    rules = load_rules()
    roots = scratch_roots(os.environ.get("HOME", ""), os.environ.get("TMPDIR"))
    d = judge(args.command, rules, roots)
    reasons = iter(d.reasons)
    for i, seg in enumerate(p.segments):
        text = seg.text.strip()
        # judge() records one reason per non-empty segment, up to and including the one
        # that refused; segments after that carry none.
        reason = next(reasons, None) if text else None
        suffix = f" -> {reason}" if reason else ""
        print(f"[{i}] sep={seg.sep} heredocs={len(seg.heredocs)}: {text}{suffix}")
    for i, sub in enumerate(p.substitutions):
        print(f"sub[{i}]: {sub.strip()}")
    print(f"decision: {'allow' if d.allow else 'defer'} rule={d.rule}")
    return 0 if p.ok else 1
```

Replace `cmd_replay` with:

```python
def _records(path: str) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def _head(command: str) -> str:
    return command.replace("\n", "⏎")[:90]


def cmd_replay(args: argparse.Namespace) -> int:
    if args.judge == bool(args.compare_bash):
        print("replay: pass exactly one of --judge or --compare-bash", file=sys.stderr)
        return 2
    records = _records(args.corpus)
    if args.compare_bash:
        return _replay_compare_bash(records, Path(args.compare_bash))
    return _replay_judge(records, Path(args.compare_hooks) if args.compare_hooks else None)


def _replay_compare_bash(records: list[dict], cmdparse: Path) -> int:
    agree = 0
    for rec in records:
        command = rec["command"]
        mine_c = _comparable(to_json_shape(parse(command)))
        theirs_c = _comparable(bash_parse(cmdparse, command))
        if mine_c == theirs_c:
            agree += 1
            continue
        print(f"MISMATCH: {_head(command)}")
        for key in ("status", "seg", "sep", "heredoc", "subseg"):
            if mine_c[key] != theirs_c[key]:
                print(f"  {key}: python={mine_c[key]!r} bash={theirs_c[key]!r}")
    print(f"PARITY {agree}/{len(records)}")
    return 0 if agree == len(records) else 1


def _replay_judge(records: list[dict], hooks_dir: Path | None) -> int:
    home = os.environ.get("HOME", "")
    roots = scratch_roots(home, os.environ.get("TMPDIR"))
    allowed = 0
    agree = 0
    for rec in records:
        command = rec["command"]
        cwd = rec.get("cwd", "")
        env = {**os.environ, "CLAUDE_PROJECT_DIR": cwd}
        d = judge(command, load_rules(home=home, project_dir=cwd), roots)
        if d.allow:
            allowed += 1
            print(f"ALLOW: {_head(command)}")
        if hooks_dir is None:
            continue
        stdin_text = json.dumps({"tool_input": {"command": command}})
        bash_hook = bash_chain_allows(hooks_dir, stdin_text, env)
        if d.allow == bool(bash_hook):
            agree += 1
        else:
            py = "allow" if d.allow else "none"
            sh = "allow" if bash_hook else "none"
            print(f"MISMATCH: {_head(command)} python={py} bash={sh} rule={d.rule}")
    print(f"ALLOW {allowed}/{len(records)}")
    if hooks_dir is None:
        return 0
    print(f"AGREE {agree}/{len(records)}")
    return 0 if agree == len(records) else 1
```

In `build_parser`, replace the `replay` subparser block with:

```python
    r = sub.add_parser("replay", help="run a JSONL of {command, cwd} records")
    r.add_argument("corpus")
    r.add_argument("--compare-bash", default=None, metavar="CMDPARSE_SH",
                   help="path to cmdparse.sh; report segmentation parity")
    r.add_argument("--judge", action="store_true",
                   help="judge every record against the deployed settings; print the allowed ones")
    r.add_argument("--compare-hooks", default=None, metavar="DIR",
                   help="with --judge: run the bash chain in DIR per record and report agreement")
    r.set_defaults(fn=cmd_replay)
```

- [ ] **Step 4: Run the whole package suite, then ruff**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q
uv run --no-project --python 3.14 --with ruff ruff check .
```

Expected: all pass, none skipped on daniel-box; ruff clean. The slice-1 `--compare-bash` tests must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add claude_guard/cli.py tests/test_cli.py
git commit -m "Add replay --judge and the decision line to explain

replay --judge is this slice's gate: the deployed settings, the record's
cwd as the project scope, and with --compare-hooks the bash chain run per
record so equality is measured rather than assumed. The fake-chain test
proves the comparison can go red."
```

---

### Task 8: The slice-2 exit gate: replay equality on both corpora, full suite, draft PR

**Files:** none new. This task produces evidence and the PR.

- [ ] **Step 1: Obtain the prompted corpus**

`/tmp/prompted_inputs.jsonl` on daniel-box holds 677 `{command, cwd}` records: every Bash call that prompted in the seven days to 2026-09-06. If it is gone, regenerate it exactly as slice 1 did (otelq and jq are allow-listed):

```bash
otelq logs '{service_name="claude-code"} | event_name="tool_decision" | source=~"user_.*"' \
  --stream --since 7d --limit 5000 > /tmp/prompted.json
jq -c '.data.result[].stream | select(.tool_name=="Bash") | {command: ((.tool_parameters|fromjson? // {}) | .full_command // ""), cwd: "/home/ubuntu/server"}' \
  /tmp/prompted.json > /tmp/prompted_inputs.jsonl
wc -l /tmp/prompted_inputs.jsonl
```

- [ ] **Step 2: Build the allowed corpus**

Thirty commands the deployed bash chain allows today under the real `~/.claude/settings.json`: chains of allow-listed programs (`ls`, `cat`, `grep`, `jq`, `git status`, `git log`, `git diff`, `head`, `tail`, `wc`, `sort`, `echo`, `find`, `awk`, `sed`, `cd`, `mkdir`, `tee` with no target), a scratch `rm` under the `Bash(rm:*)` ask rule, and a safe `curl` under `Bash(curl:*)`. `cwd` is `/tmp` so no project file is in scope and the test is about the user rules. Write `/tmp/allowed_inputs.jsonl`:

```bash
jq -nc --args '$ARGS.positional[] | {command: ., cwd: "/tmp"}' \
  'git status && ls -la' \
  'git status --short; git log --oneline -5' \
  'ls -la | head -20' \
  'cat README.md | head -40' \
  'grep -rn TODO scripts | wc -l' \
  'find . -name "*.py" | wc -l' \
  'find . -type f -maxdepth 2 | sort' \
  'git log --oneline -10 | tail -3' \
  'git diff --stat | tail -5' \
  'jq -r ".a" f.json; jq -r ".b" f.json' \
  'cat a.json | jq -r ".hooks | keys[]"' \
  'echo one && echo two && echo three' \
  'echo "a && b" && ls' \
  'ls /tmp 2>/dev/null && echo ok' \
  'cat a.json > /dev/null && ls' \
  'awk "{print \$1}" f.txt | sort | uniq -c' \
  'sed -n 1,20p f.txt | grep x' \
  'wc -l f.txt; wc -c f.txt' \
  'echo hi | tee' \
  'echo hi | tee /dev/null' \
  'cd /tmp && ls' \
  'mkdir -p /tmp/a && ls /tmp/a' \
  'echo hi | xargs wc -l' \
  'echo hi && timeout 5 ls' \
  'echo hi && nice -n 10 ls' \
  'cd /tmp && rm -rf /tmp/scratch' \
  'rm -rf /tmp/a && mkdir -p /tmp/a' \
  'echo cleaning && rm -f /tmp/build/out.txt' \
  'curl -s http://127.0.0.1:9090/metrics | tail -20' \
  'curl -sG http://127.0.0.1:9090/api/v1/query --data-urlencode "query=up" | jq .' \
  > /tmp/allowed_inputs.jsonl
wc -l /tmp/allowed_inputs.jsonl
```

Expected: `30`. If a command in this list turns out NOT to be allowed by the bash chain under the real settings (an allow rule renamed, a new ask rule), step 3 reports `ALLOW 29/30` with `AGREE 30/30`: both sides refuse it, so it is not a port bug, but it is not evidence either. Replace that command with another allow-listed chain rather than accepting the lower count; the requirement is thirty commands both sides allow.

- [ ] **Step 3: Run the gate against the SOURCE bash hooks**

```bash
export CLAUDE_GUARD_HOME=$PWD/home/dot_local/share/claude-guard
export CLAUDE_GUARD_BASH_HOOKS_DIR=$PWD/home/private_dot_claude/hooks
bash home/dot_local/bin/executable_claude-guard replay /tmp/prompted_inputs.jsonl --judge \
  --compare-hooks "$CLAUDE_GUARD_BASH_HOOKS_DIR" | tail -8
bash home/dot_local/bin/executable_claude-guard replay /tmp/allowed_inputs.jsonl --judge \
  --compare-hooks "$CLAUDE_GUARD_BASH_HOOKS_DIR" | tail -4
```

Expected, first run: `ALLOW 0/677` and `AGREE 677/677`, exit 0. Every one of these prompted, so the bash chain allows none; the point of running the chain per record is to prove the equality rather than assume the zero. A non-zero `ALLOW` with `AGREE 677/677` means the bash allows it too and the corpus is stale; report the count. Any `MISMATCH` line is a port bug: reproduce it in `test_judge.py` with the real rule that decided it, fix `judge.py`, and re-run.

Expected, second run: `ALLOW 30/30` and `AGREE 30/30`, exit 0.

Then run the same two commands against the DEPLOYED hooks (`CLAUDE_GUARD_BASH_HOOKS_DIR=$HOME/.claude/hooks`) and expect the same numbers; the deployed copies are what shadow mode compares against, and this catches a source/deployed drift before the census starts.

- [ ] **Step 4: Run the whole repo suite the way the pre-push gate does**

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
git ls-files '*.test.js' '*.test.mjs' | xargs -r node --test 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'
node bin/config-soak status | tail -3
```

Expected: `fail 0`; the package's pytest run inside `python-suites.test.js`; no `GATE FAIL`.

- [ ] **Step 5: Push and open the draft PR**

```bash
git push -u origin worktree-claude-guard-2
gh pr create --draft --title "Add the claude-guard judge and register its PermissionRequest hook in shadow" --body-file - <<'EOF'
## What changed, and why

Second slice of `docs/specs/2026-09-06-claude-guard-design.md`: `rules.py`, `judge.py`,
`checks/scratch.py`, `checks/curl.py`, `tables.py`, the `permission-request` entry with a
shadow mode, `shadow-report`, `replay --judge`, and the shim
`~/.claude/hooks/guard-permission-request.sh` registered beside the three bash hooks it
ports. It decides nothing: `CLAUDE_GUARD_SHADOW=1` in the env block, and the shim's own
default. Nothing changes for a session until slice 3.

This is a port. The literal `&&`/`;`/`|` gate, the unjudgeable shapes and the per-segment
order are `allow-compound-bash.sh`'s, line-cited in `judge.py`. The #477 rules and
single-segment judging are slice 3.

## Verification

- `test_scratch.py`, `test_curl.py`, `test_judge.py`: the three node suites ported case for
  case against the same fixtures.
- Replay of the 677 prompted commands from the week to 2026-09-06, bash chain run per record:

      ALLOW 0/677
      AGREE 677/677

- Replay of 30 chains the bash chain allows today:

      ALLOW 30/30
      AGREE 30/30

- `git ls-files '*.test.js' '*.test.mjs' | xargs -r node --test`: <paste the ℹ pass/fail lines>

## Exit criterion for this slice

Several days of `claude-guard shadow-report` showing no python-only and no bash-only rows.
That is the slice-3 gate, not this PR's.
EOF
```

Replace the `<paste …>` line with the real output before submitting.

---

## Self-review

**Spec coverage for slice 2 (Rollout row 2: `rules.py`, `judge.py`, scratch and curl checks, PermissionRequest shim in shadow).** `rules.py` with the scope asymmetry and prefix/glob matching: Task 1. `tables.py` with `SCRATCH_ROOTS` and `CURL_HOSTS`: Task 1. `checks/scratch.py` and `checks/curl.py` as pure functions from one segment to a verdict, each owning only its option allowlist: Tasks 2 and 3. `judge.py` allowing a chain when every segment is allow-listed or passes a check and none matches deny or ask: Task 4; the #477 rules and single-segment judging are deliberately NOT here (Global Constraints, spec *Decisions* say slice 3). `cli.py permission-request` reading hook JSON and printing a decision or nothing: Task 5. The shim resolving `uv python find --no-project --managed-python 3.14`, `-S`, and the allow-path failure contract "cannot run or cannot parse → emits nothing": Task 6, tested end to end with a temp HOME as the spec's *Testing* section asks. Shadow mode "registered beside the old ones, logs its verdict, decides nothing": Tasks 5 and 6; the spec names `bin/shadow-report` as the tooling, and this plan reuses its log-location and sampling conventions with a package-native `shadow-report` subcommand as the brief directs. `replay` printing the allow count and the allowed commands: Task 7. Unit tests as `…_is_allowed`/`…_is_refused` pairs, node suites ported to pytest, replay as a local tool over a transcript-derived corpus: Tasks 2 to 4, 7, 8. `explain` printing the rule that decided each segment (spec: "from slice 2"): Task 7. Docs: README and package docstring in Task 6; the spec's Architecture and Interpreter sections stay true. Not in this slice: `deny.py`, `pre-tool-use`, `checks/git_reset.py`, `checks/ansible.py`, `checks/remote.py`, the two open questions (the remote check's shape is decided when that check is written, which the rollout table places in slice 3 with the ansible rules; the rewriter ordering is slice 5).

**Placeholder scan.** The one intentional placeholder is the PR body's `<paste …>` line, which Task 8 step 5 instructs the executor to replace. Task 6 step 1 places two imports inline to mark where they are first needed and tells the executor to move them to the top; that is an instruction with its content present, not a gap.

**Type consistency.** `Rules(allow, deny, deny_glob, ask, ask_glob)` with `allows/denies/asks/whole_glob_defer` is used with those names in Tasks 1, 4, 5 and 7. `load_rules(home, project_dir, env)` is called with keyword arguments matching that signature in Tasks 1, 4, 5 and 7. `scratch_roots(home, tmpdir)` is called with those positions in Tasks 2, 4, 5 and 7. `rm_confined(command, roots)` and `curl_safe(command)` match between their definitions (Tasks 2, 3) and `judge_segment` (Task 4). `Decision(allow, rule, reasons)` is constructed and read with those fields in Tasks 4, 5 and 7; the `rule` vocabulary asserted in `test_judge.py` (`not-compound`, `whole-glob`, `unreadable:…`, `unjudgeable:substitution|heredoc|separator`, `segment:<n>:<reason>`, `allow`) is the vocabulary `judge()` emits. `permission_request(stdin_text, env, hooks_dir, log_dir)`, `bash_chain_allows(hooks_dir, stdin_text, env)`, `shadow_record(command, decision, bash_hook)`, `summarize(lines)`, `command_sha(command)` are defined in Task 5 with the signatures Tasks 5, 6 and 7 call. The log record's six keys (`ts`, `cmd_sha`, `python`, `bash`, `rule`, `bash_hook`) are the same in `shadow_record`, the README example and `test_the_shadow_log_never_carries_the_command`. The `replay` output vocabulary (`ALLOW: …`, `ALLOW n/N`, `MISMATCH: …`, `AGREE k/N`, `PARITY n/N`) matches between `cli.py` and `test_cli.py`.
