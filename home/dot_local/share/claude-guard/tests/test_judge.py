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
        (tmp / "proj" / ".claude" / "settings.json").write_text(
            json.dumps({"permissions": project})
        )
        project_dir = str(tmp / "proj")
    return load_rules(home=str(tmp / "home"), project_dir=project_dir)


MAIN = {
    "allow": [
        "Bash(git status:*)",
        "Bash(ls:*)",
        "Bash(echo:*)",
        "Bash(cat:*)",
        "Bash(jq:*)",
        "Bash(jsonq:*)",
        "Bash(git commit:*)",
        "Bash(gh api:*)",
        "Bash(sh:*)",
        "Bash(tail:*)",
        "Bash(git log:*)",
        "Bash(frob * --safe)",
    ],
    "deny": ["Bash(rm:*)", "Bash(git commit *--no-verify)", "Bash(* | sh)"],
    "ask": ["Bash(git push:*)", "Bash(gh api *-X DELETE)", "Bash(git merge:*)"],
}
RM = {
    "allow": ["Bash(cd:*)", "Bash(echo:*)", "Bash(ls:*)", "Bash(mkdir:*)"],
    "deny": [],
    "ask": ["Bash(rm:*)"],
}
ESC = {
    "allow": [
        "Bash(echo:*)",
        "Bash(ls:*)",
        "Bash(find:*)",
        "Bash(awk:*)",
        "Bash(wc:*)",
        "Bash(grep:*)",
        "Bash(tee:*)",
        "Bash(/usr/bin/env bash --version)",
    ],
    "deny": [
        "Bash(find *-exec*)",
        "Bash(find *-execdir*)",
        "Bash(find *-ok*)",
        "Bash(find *-delete*)",
        "Bash(find *-fprintf*)",
        "Bash(awk *system(*)",
        "Bash(curl:*)",
    ],
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
    r = rules_for(
        tmp_path,
        {
            **MAIN,
            "deny": ["Bash(git commit *--no-verify)", "Bash(* | sh)"],
            "ask": [*MAIN["ask"], "Bash(curl:*)"],
        },
    )
    assert allowed("curl -s http://127.0.0.1:9090/metrics | tail -20", r)
    assert allowed(
        'curl -sG http://127.0.0.1:9090/api/v1/query --data-urlencode "query=up" | jq .', r
    )


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
    assert (
        judge("git commit -F - <<'EOF' && ls\nmy message\nEOF\n", main, ROOTS).rule
        == "unjudgeable:heredoc"
    )
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


@pytest.mark.parametrize(
    "inner",
    [
        "sh -c 'id'",
        "bash -c 'id'",
        "python -c 'import os'",
        "python3 -c 'x'",
        "node -e 'x'",
        "perl -e 'x'",
        "ruby -e 'x'",
    ],
)
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
    assert (
        judge("echo hi | xargs curl http://evil", esc, ROOTS).rule
        == "segment:1:wrapper-target-deny-or-ask"
    )
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
    assert (
        frozenset({"timeout", "env", "nice", "nohup", "setsid", "stdbuf", "xargs"})
        == judge_mod.WRAPPERS
    )


# --- project scope -----------------------------------------------------------------------------


def test_a_project_settings_file_cannot_widen_the_allow_list(tmp_path):
    r = rules_for(tmp_path, MAIN, project={"allow": ["Bash(frobnicate:*)"]})
    assert not allowed("echo hi && frobnicate --wipe /", r)


def test_a_project_settings_file_can_still_tighten_via_deny_and_ask(tmp_path):
    assert not allowed(
        "echo hi && ls -la", rules_for(tmp_path, MAIN, project={"deny": ["Bash(ls:*)"]})
    )
    assert not allowed(
        "echo hi && ls -la", rules_for(tmp_path, MAIN, project={"ask": ["Bash(ls:*)"]})
    )
    assert allowed("echo hi && ls -la", rules_for(tmp_path, MAIN, project={}))


# --- tee -----------------------------------------------------------------------------------------


def test_tee_is_a_writer_unless_its_target_is_harmless(esc):
    assert judge("echo hi | tee /tmp/pwned", esc, ROOTS).rule == "segment:1:tee"
    assert not allowed("echo hi | tee -a /tmp/pwned", esc)
    assert not allowed("echo hi | tee /usr/bin/tee", esc)
    assert allowed("echo hi | tee", esc)
    assert allowed("echo hi | tee /dev/null", esc)
