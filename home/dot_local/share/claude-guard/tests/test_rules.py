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


# --- extraction (allow-compound-bash.sh:63-71) --------------------------------------------


def test_extraction_strips_the_wrapper_and_a_trailing_wildcard_only():
    perms = {
        "permissions": {
            "allow": [
                "Bash(git status:*)",
                "Bash(pwd)",
                "Bash(rm -rf /*)",
                "Bash(gh api *-f *)",
                "Bash(* | sh*)",
                "Bash(frob * --safe)",
                "Read",
                "WebFetch(domain:github.com)",
            ]
        }
    }
    assert extract_bash_prefixes(perms, "allow") == [
        "git status",
        "pwd",
        "rm -rf /",
        "gh api *-f",
        "* | sh",
        "frob * --safe",
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
    write_settings(
        tmp_path,
        {
            "allow": ["Bash(ls:*)", "Bash(frob * --safe)"],
            "deny": ["Bash(rm:*)", "Bash(git commit *--no-verify)"],
            "ask": ["Bash(git push:*)", "Bash(gh api *-X DELETE)"],
        },
    )
    r = load_rules(home=str(tmp_path))
    assert r == Rules(
        allow=("ls", "frob * --safe"),
        deny=("rm",),
        deny_glob=("git commit *--no-verify",),
        ask=("git push",),
        ask_glob=("gh api *-X DELETE",),
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
    assert r == Rules((), (), (), (), ())


def test_home_comes_from_the_override_env_var_before_home(tmp_path):
    write_settings(tmp_path, {"allow": ["Bash(ls:*)"], "deny": [], "ask": []})
    r = load_rules(env={"CLAUDE_GUARD_SETTINGS_HOME": str(tmp_path), "HOME": "/nonexistent"})
    assert r.allows("ls")
