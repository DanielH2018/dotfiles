"""The settings loader and the two matchers, ported from allow-compound-bash.sh.

Fixture settings are written to a temp HOME the way tests/hooks/allow-compound-bash.test.js
writes them, so the file-reading path is what is tested, not a dict handed in.
"""

import json
from pathlib import Path

import pytest

from claude_guard.rules import Rules, extract_bash_rules, load_rules, parse_rule
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
        "/tmp",
        "/var/tmp",
        "/home/testuser/.claude/jobs",
        "/home/testuser/.cache/claude",
    )


def test_tmpdir_under_tmp_is_added_with_one_trailing_slash_stripped():
    assert scratch_roots("/h", "/tmp/x/")[-1] == "/tmp/x"


def test_tmpdir_outside_tmp_is_ignored():
    assert scratch_roots("/h", "/home/testuser") == scratch_roots("/h")
    assert scratch_roots("/h", "") == scratch_roots("/h")


def test_curl_hosts_are_the_six_exact_entries():
    assert CURL_HOSTS == (
        "localhost",
        "127.0.0.1",
        "[::1]",
        "10.0.0.161",
        "10.0.0.139",
        "10.0.0.215",
    )


# --- the rule grammar (Claude Code 2.1.283's Kmn/h6, dotfiles #714) ---------------------------

# (class, rule content, command, Claude Code's decision, the guard's decision). The Claude
# Code column is what the bundle's own Kmn/h6/Fq code returns for that command, run under
# node. The guard column is `Rules.allows` for allow and `Rules.denies`/`asks` for deny/ask:
# allow may only be narrower than Claude Code, deny/ask only wider.
GRAMMAR = [
    # `:*` is a prefix ending at a space, never at a `/`, with runs of blanks collapsed.
    ("allow", "git status:*", "git status", True, True),
    ("allow", "git status:*", "git status  --short", True, True),
    ("allow", "git status:*", "git statusfoo", False, False),
    ("allow", "ls:*", "ls/", False, False),
    ("deny", "ls:*", "ls/", False, True),
    # Claude Code's `xargs <rule>` arm: honoured for deny/ask, not granted for allow.
    ("allow", "grep:*", "xargs grep x", True, False),
    ("ask", "rm:*", "xargs rm -rf", True, True),
    # A `*` before a trailing `:*` is literal.
    ("deny", "git config user.*:*", "git config user.email x", False, False),
    ("deny", "git config user.*:*", "git config user.* x", True, True),
    # A trailing ` *` as the only `*` also matches the bare command.
    ("allow", "fnm env *", "fnm env", True, True),
    ("allow", "fnm env *", "fnm env --shell zsh", True, True),
    ("allow", "fnm env *", "fnm envx", False, False),
    # A `*` after a non-space character expands inside the word (the #714 shape).
    ("deny", "git config user.*", "git config user.email x", True, True),
    ("deny", "git config user.*", "git config core.editor x", False, False),
    ("deny", "git push --force*", "git push --force-with-lease", True, True),
    ("ask", "npx --package=*", "npx --package=cowsay cowsay", True, True),
    ("ask", "gh api graphql*", "gh api graphql -f query=x", True, True),
    ("allow", "tool/*", "tool/run.sh x", True, False),
    # Interior wildcards are anchored at both ends.
    ("ask", "gh api *-X DELETE*", "gh api -X DELETE /r", True, True),
    ("ask", "gh api *-X DELETE*", "gh api -X GET /r", False, False),
    ("ask", "gh api *-f *", "gh api repos/o/r --jq .failure", False, False),
    ("deny", "git push * --force", "git push o --force", True, True),
    ("deny", "git push * --force", "git push o --force-with-lease", False, False),
    ("deny", "git push * -f", "git  push o   -f", True, True),
    ("deny", "git push * -f", "xargs git push o -f", True, True),
    # With several `*`, a trailing ` *` needs its space.
    ("deny", "git push * -f *", "git push o -f", False, False),
    ("deny", "git push * -f *", "git push o -f x", True, True),
    # A wildcard also covers the command's leading whole words, for a trailing redirect.
    ("deny", "find * -delete", "find . -delete 2>/dev/null", False, True),
    ("deny", "rm -rf / *", "rm -rf /home/x", False, False),
    # `?`, `[`, `]` and `.` are literal. A backslash escapes `*` and `\`.
    ("deny", "cat [x]*", "cat [x]y", True, True),
    ("deny", "cat [x]*", "cat xy", False, False),
    ("deny", "echo a?c*", "echo abc", False, False),
    ("deny", "echo \\**", "echo *foo", True, True),
    ("deny", "echo \\**", "echo foo", False, False),
    ("deny", "echo \\\\*", "echo \\x", True, True),
    # `/**/` also matches a single `/`.
    ("deny", "cat a/**/b", "cat a/b", True, True),
    ("deny", "cat a/**/b", "cat a/x/y/b", True, True),
    # A `:*` that is not at the end is a wildcard with a literal `:`.
    ("deny", "foo:*bar", "foo:xbar", True, True),
    ("deny", "foo:*bar", "foo xbar", False, False),
    # `*` crosses newlines.
    ("deny", "bash -c *", "bash -c 'a\nb'", True, True),
    # No `*` is an exact rule: whole command for allow, a prefix for deny/ask.
    ("allow", "git branch", "git branch", True, True),
    ("allow", "git branch", "git branch -D feat", False, False),
    ("deny", "git push -f", "git push -f origin feat", False, True),
    # `Bash(*)` is every command. The guard grants none of it in allow (#719).
    ("ask", "*", "anything at all", True, True),
    ("allow", "*", "anything at all", True, False),
]


@pytest.mark.parametrize(("cls", "content", "command", "cc", "guard"), GRAMMAR)
def test_the_parser_decides_each_row_as_claude_code_does(cls, content, command, cc, guard):
    assert parse_rule(content).cc_matches(command, cls) is cc


@pytest.mark.parametrize(("cls", "content", "command", "cc", "guard"), GRAMMAR)
def test_the_guard_reads_each_rule_shape_as_its_class_requires(
    tmp_path, cls, content, command, cc, guard
):
    # Written into the rule string the way Claude Code serialises content (`l`).
    escaped = content.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    write_settings(tmp_path, {"allow": [], "deny": [], "ask": [], cls: [f"Bash({escaped})"]})
    r = load_rules(home=str(tmp_path))
    decide = {"allow": r.allows, "deny": r.denies, "ask": r.asks}[cls]
    assert decide(command) is guard
    # The invariant the judge relies on: allow never wider, deny/ask never narrower.
    assert (guard <= cc) if cls == "allow" else (guard >= cc)


def test_the_rule_string_is_unwrapped_as_claude_code_reads_it():
    perms = {
        "permissions": {
            "allow": [
                "Bash(git status:*)",
                "Bash(awk *system(*)*)",
                "Bash(echo \\(x\\))",
                "Bash",
                "Bash()",
                "Read",
                "WebFetch(domain:github.com)",
                "Bash(unclosed",
            ]
        }
    }
    assert [(r.kind, r.text) for r in extract_bash_rules(perms, "allow")] == [
        ("prefix", "git status"),
        ("wildcard", "awk *system(*)*"),
        ("exact", "echo (x)"),
        ("all", ""),
        ("all", ""),
    ]


def test_extraction_of_a_missing_field_or_a_non_object_is_empty():
    assert extract_bash_rules({"permissions": {}}, "deny") == []
    assert extract_bash_rules({}, "deny") == []
    assert extract_bash_rules("not json", "deny") == []


# --- the loader and the scope asymmetry (allow-compound-bash.sh:13-26, 73-95) -------------


def test_rules_keep_each_class_in_settings_order(tmp_path):
    write_settings(
        tmp_path,
        {
            "allow": ["Bash(ls:*)", "Bash(frob * --safe)"],
            "deny": ["Bash(rm:*)", "Bash(git commit *--no-verify)"],
            "ask": ["Bash(git push:*)", "Bash(git stash clear)"],
        },
    )
    r = load_rules(home=str(tmp_path))
    assert r == Rules(
        allow=(parse_rule("ls:*"), parse_rule("frob * --safe")),
        deny=(parse_rule("rm:*"), parse_rule("git commit *--no-verify")),
        ask=(parse_rule("git push:*"), parse_rule("git stash clear")),
    )


def test_allow_never_globs_but_deny_and_ask_do(tmp_path):
    write_settings(
        tmp_path,
        {
            "allow": ["Bash(frob * --safe)"],
            "deny": ["Bash(* | sh)"],
            "ask": ["Bash(gh api *-X DELETE)"],
        },
    )
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
    assert r == Rules((), (), ())


def test_home_comes_from_the_override_env_var_before_home(tmp_path):
    write_settings(tmp_path, {"allow": ["Bash(ls:*)"], "deny": [], "ask": []})
    r = load_rules(env={"CLAUDE_GUARD_SETTINGS_HOME": str(tmp_path), "HOME": "/nonexistent"})
    assert r.allows("ls")
