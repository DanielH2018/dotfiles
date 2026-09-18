"""tests/hooks/allow-compound-bash.test.js, case for case, against the same four fixtures.

Each fixture is written to a temp HOME and read back through load_rules, so the loader is
in the loop the way the bash reads settings.json. The three content guards on the REAL
allow list at the end of that suite test settings.permissions.json, not the hook, and stay
in node.
"""

import json
from pathlib import Path

import pytest
from test_git_reset import _make_repo

from claude_guard import judge as judge_mod
from claude_guard.judge import Decision, _first_word, _under_session_cwd, judge, unwrap_wrapper
from claude_guard.rules import Rules, load_rules
from claude_guard.tables import scratch_roots

ROOTS = scratch_roots("/home/testuser")
CWD = "/home/testuser"


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
    "allow": ["Bash(cd:*)", "Bash(echo:*)", "Bash(ls:*)", "Bash(mkdir:*)", "Bash(uv run:*)"],
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
    return judge(command, rules, ROOTS, CWD).allow


# --- the basic gate ------------------------------------------------------------------------


def test_a_compound_where_every_part_is_allow_listed_is_allowed(main):
    assert allowed("git status && ls -la", main)
    assert allowed("echo hi && cat file.txt && ls", main)


def test_a_single_allow_listed_segment_is_judged_like_a_chain_of_one(main):
    # D2 (docs/specs/2026-09-06-claude-guard-design.md, Decisions). judge() used to return
    # Decision(False, "not-compound", ()) for any command with none of `&&`/`;`/`|`; that
    # early return is gone (see the DECIDED marker at its old site in judge.py), so a bare
    # allow-listed command is judged the same way one segment of a chain would be.
    assert allowed("git status", main)


def test_a_single_confined_rm_is_now_allowed_where_it_used_to_read_not_compound(rm):
    # D2's pinning case from the brief: a bare `rm -f /tmp/x` now reaches rm_confined the
    # same way it would as one segment of a chain, instead of returning not-compound.
    assert allowed("rm -f /tmp/x", rm)


def test_a_single_segment_matching_no_check_or_rule_still_returns_no_opinion(main):
    # D2's other pinning case: removing the not-compound gate must never turn an unlisted
    # bare command into an allow. "No opinion" here is Decision.allow=False with a
    # segment-level reason, never "deny" — judge() never returns deny.
    d = judge("frobnicate", main, ROOTS, CWD)
    assert d == Decision(False, "segment:0:unlisted", ("unlisted",))


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


def test_a_delegate_and_cleanup_chain_is_allowed_end_to_end(rm):
    # The motivating shape for the rm delegation: a scratch script run then cleaned up in
    # the same chain. `uv run` is allow-listed in the `rm` fixture for exactly this test.
    assert allowed("uv run python /tmp/x.py && rm /tmp/x.py", rm)


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


# PR #477's eligibility widening (a newline-only command becomes eligible for judgment) was
# out of scope for Task 6 (it required deleting judge.py's not-compound gate) and is
# subsumed by D2's full deletion of that gate: with no substring pre-filter, parse() alone
# decides, and it already treats a bare newline as a separator equal to `;`.
def test_a_newline_only_compound_is_allowed_when_every_part_is_allow_listed(main):
    assert allowed("echo hi\nls", main)
    assert allowed("git status\ngit log --oneline -3\ncat file.txt", main)


def test_a_newline_only_compound_still_defers_when_denied_ask_or_unlisted(main):
    assert judge("ls\nrm -rf build", main, ROOTS, CWD).rule == "segment:1:deny"
    assert judge("git status\ngit push origin main", main, ROOTS, CWD).rule == "segment:1:ask"
    assert judge("git status\nfrobnicate", main, ROOTS, CWD).rule == "segment:1:unlisted"


def test_deny_ask_and_unlisted_each_defer(main):
    assert judge("ls && rm -rf build", main, ROOTS, CWD).rule == "segment:1:deny"
    assert judge("git status && git push origin main", main, ROOTS, CWD).rule == "segment:1:ask"
    assert judge("git status && frobnicate", main, ROOTS, CWD).rule == "segment:1:unlisted"


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
    assert judge("echo $(whoami) && ls", main, ROOTS, CWD).rule == "unjudgeable:substitution"
    assert not allowed("echo `whoami` && ls", main)
    assert not allowed("cat <(curl example.com) && ls", main)


def test_a_heredoc_that_is_not_the_cat_path_write_shape_defers(main):
    # PR #477. cmd_parse lifts a heredoc body out whole and never scans it for a
    # substitution, so an unquoted OR non-write heredoc could carry a live `$(...)` this
    # judge cannot see. The one carve-out — a `cat > path`/`cat >> path` write with a
    # QUOTED delimiter — is its own test group below; this is not that shape.
    assert (
        judge("git commit -F - <<'EOF' && ls\nmy message\nEOF\n", main, ROOTS, CWD).rule
        == "unjudgeable:heredoc"
    )


def test_an_internal_newline_inside_an_eligible_chain_is_judged_like_semicolon(main):
    # PR #477, judge.py:274 (was): an internal newline used to force a defer regardless of
    # content; now it is judged like `;` — allowed on the strength of every segment
    # earning its own allow entry, same as it would with `;` in its place.
    assert allowed("echo hi && ls\ncat file.txt", main)
    assert judge("echo hi && ls\nfrobnicate", main, ROOTS, CWD).rule == "segment:2:unlisted"


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
    assert judge("echo 'unbalanced && ls", main, ROOTS, CWD).rule == "unreadable:unbalanced-quote"
    assert not allowed('echo "unbalanced && ls', main)


def test_a_redirect_to_a_real_target_defers_but_dev_null_and_fd_dups_do_not(main):
    assert judge("cat a.json > /etc/passwd && ls", main, ROOTS, CWD).rule == "segment:0:redirect"
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
    assert judge("git status && ls & echo hi", main, ROOTS, CWD).rule == "unjudgeable:separator"


def test_an_allow_prefix_matches_only_at_a_command_boundary(main):
    assert not allowed("lsof -i && ls", main)
    assert not allowed("git statusfoo && ls", main)
    assert not allowed("echoes hi && ls", main)


def test_deny_and_ask_rules_with_an_interior_wildcard_are_globs(main):
    assert not allowed("git status && git commit -m x --no-verify", main)
    assert not allowed("git status && git commit --no-verify -m x", main)
    assert not allowed("ls && gh api -X DELETE /repos/o/r", main)


def test_pipe_spanning_deny_globs_apply_to_the_whole_command(main):
    assert judge("cat a.json | sh", main, ROOTS, CWD).rule == "whole-glob"
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
    assert allowed("echo hi && nice -n 10 ls", esc)
    assert allowed("echo hi && nohup ls", esc)
    assert allowed("echo hi && timeout 5 nohup ls", esc)
    assert judge("echo hi && timeout 5 ls", esc, ROOTS, CWD).reasons == ("allow-list", "wrapper:ls")


def test_g1_extended_env_cannot_carry_an_assignment_past_its_own_wrapper_grant(esc):
    # Found while verifying G1 (task-8-fix-1-brief.md) this fix round, not named in the
    # brief's text: `env`'s OWN wrapper-unwrap consumed `VAR=VALUE` tokens and handed the
    # bare command on to be judged alone, which is the identical hazard G1 closes for a
    # bare `VAR=value cmd` segment, reached through `env` instead. Unlike G1's own arm,
    # this one IS how the pre-cutover bash behaves today (origin/main's
    # allow-compound-bash.sh:225-235, confirmed against the real snapshot hook: it also
    # allows `echo hi && env PATH=/tmp ls -la`), so refusing it here is a narrowing
    # relative to the bash, never a widening — safe to fix in this round rather than file
    # separately, since G2's floor only guards against allowing MORE than the bash did.
    assert not allowed("echo hi && env PATH=/tmp ls -la", esc)
    assert not allowed("echo hi && env FOO=bar ls", esc)
    # A bare `env cmd`, with no assignment at all, carries nothing to smuggle and still
    # unwraps normally.
    assert allowed("echo hi && env ls", esc)


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
        judge("echo hi | xargs curl http://evil", esc, ROOTS, CWD).rule
        == "segment:1:wrapper-target-deny-or-ask"
    )
    assert not allowed("echo hi && timeout 5 curl http://evil", esc)


def test_a_wrapper_whose_options_cannot_be_read_defers(esc):
    assert (
        judge("echo hi && env -S 'ls -l'", esc, ROOTS, CWD).rule == "segment:1:wrapper-unreadable"
    )
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
    assert judge("echo hi | tee /tmp/pwned", esc, ROOTS, CWD).rule == "segment:1:tee"
    assert not allowed("echo hi | tee -a /tmp/pwned", esc)
    assert not allowed("echo hi | tee /usr/bin/tee", esc)
    assert allowed("echo hi | tee", esc)
    assert allowed("echo hi | tee /dev/null", esc)


def test_a_control_char_glued_to_a_tee_option_does_not_hide_the_target(esc):
    # Round-4 review. `_OPTION_WORD` ports sed's `[[:space:]]+-[^[:space:]]+`; written as
    # `[^{WS}]+` the complement was broader than bash's, so `-a\rfile` was one option word,
    # the strip left bare `tee`, and the write refusal compared equal strings. Bash's
    # `[^[:space:]]` stops at `\r`, so `file` survives the strip and the refusal fires.
    assert judge("tee -a\rfile", esc, ROOTS, CWD).rule == "segment:0:tee"
    assert judge("tee -a\x0bfile", esc, ROOTS, CWD).rule == "segment:0:tee"
    assert not allowed("tee -a file", esc)


def test_a_unicode_space_glued_to_a_tee_option_is_flagged(esc):
    # #512: the bash this ports ran under en_US.UTF-8, where `[[:space:]]` admits U+3000
    # and the other glibc Unicode spaces, so `-a　file` is two words to bash and `file`
    # must survive the option strip here too. Every member of the measured set, not just
    # the ideographic space, so a later edit that drops one from POSIX_SPACE fails here.
    for cp in (
        0x1680,
        *range(0x2000, 0x2007),
        *range(0x2008, 0x200B),
        0x2028,
        0x2029,
        0x205F,
        0x3000,
    ):
        assert judge(f"tee -a{chr(cp)}file", esc, ROOTS, CWD).rule == "segment:0:tee", hex(cp)
    # `_first_word` ports the same construct and reads the same constant.
    assert _first_word("tee　-a") == "tee"


def test_a_non_breaking_or_zero_width_space_is_clean_as_a_word_character(esc):
    # The other half of the #512 measurement: bash's class REFUSES U+00A0, U+2007, U+202F,
    # U+0085, U+200B and U+FEFF, so these stay glued into the option word exactly as the
    # bash did — Python's `str.isspace()` would split three of them, which is why the
    # constant is a literal and not that method. GNU tee's getopt rejects the glued token
    # (exit 1), so the allow is inert; pinned so the set cannot drift to `isspace()`.
    for cp in (0x0085, 0x00A0, 0x2007, 0x202F, 0x200B, 0xFEFF):
        assert allowed(f"tee -a{chr(cp)}file", esc), hex(cp)
        assert _first_word(f"tee{chr(cp)}-a") == f"tee{chr(cp)}-a", hex(cp)


# --- heredoc write parity (PR #477) -------------------------------------------------------------
#
# Task 6 prefixed every command below with `git status &&`/`;` because judge.py's
# not-compound gate (judge.py:253 at the time) made a bare heredoc-write line ineligible on
# its own. D2 removes that gate, so these are restored to #477's original single-segment
# form. The port checks BOTH confinement arms of allow-compound-bash.sh's heredoc_write_ok
# (:169-194) — a scratch root or the session's own cwd — so `CWD` below stands in for the
# session directory the way ROOTS stands in for SCRATCH_ROOTS; a case-by-case cwd is used
# only where the test is specifically about the cwd arm.


def test_a_cat_path_heredoc_write_with_a_quoted_delimiter_is_allowed_under_a_scratch_root(main):
    assert allowed("cat > /tmp/x.sh <<'EOF'\necho hi\nEOF\n", main)
    assert allowed('cat >> /tmp/x.sh <<"EOF"\nmore\nEOF\n', main)
    assert allowed("cat > /tmp/x.sh <<'EOF'\necho hi\nEOF\ngit status", main)


def test_a_cat_path_heredoc_write_with_a_quoted_delimiter_is_allowed_under_the_session_cwd(
    main, tmp_path
):
    # #477's heredoc_write_ok cwd arm (:183-191). roots=() here so the assertion can ONLY
    # pass through the cwd branch — if the scratch-root check alone were doing the work
    # this would misread allowed for the wrong reason (tmp_path is itself under /tmp, a
    # real scratch root, which is why the empty roots tuple is the control).
    cwd = str(tmp_path)
    assert judge("cat > notes.md <<'EOF'\nhi\nEOF\n", main, (), cwd).allow
    assert judge(f"cat > {cwd}/notes.md <<'EOF'\nhi\nEOF\n", main, (), cwd).allow


def test_a_cat_path_heredoc_write_through_a_symlinked_cwd_escape_is_refused(main, tmp_path):
    # Fix round 1, F2: _under_session_cwd used to compare LEXICALLY, where PR #477's bash
    # resolves the target with `realpath -m --`. A real symlink under cwd pointing outside
    # it let a quoted-delimiter heredoc write auto-approve a write far outside the session:
    # `escape/pwned` lexically starts with cwd, but realpath resolves it through the
    # symlink to a path that matches neither `cwd` nor `cwd/*`, and bash refuses it. roots=()
    # is the same control as the test above, isolating this to the cwd arm alone.
    outside = tmp_path / "outside"
    outside.mkdir()
    cwd = tmp_path / "proj"
    cwd.mkdir()
    (cwd / "escape").symlink_to(outside)
    assert not judge("cat > escape/pwned <<'EOF'\nhi\nEOF\n", main, (), str(cwd)).allow
    assert not judge(f"cat > {cwd}/escape/.bashrc <<'EOF'\nhi\nEOF\n", main, (), str(cwd)).allow


def test_a_heredoc_write_is_confined_when_the_session_cwd_is_itself_a_symlink(esc, tmp_path):
    # 8f91344 (bash, 2026-09-16): the harness's `.cwd` on macOS is a `/var/...` path whose
    # physical form is `/private/var/...`. The target resolves under the physical form and
    # so never prefix-matched the raw cwd; every legitimate write on that platform refused.
    # Reproduced here with a symlinked cwd on Linux, which fails the same way.
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real_dir)
    cmd = "cat > note.txt <<'EOF'\nhi\nEOF\n"
    assert judge(cmd, esc, (), str(link)).allow
    # Still refused: a target that resolves OUTSIDE both forms of the cwd.
    (real_dir / "out").symlink_to(tmp_path)
    assert not judge("cat > out/x <<'EOF'\nhi\nEOF\n", esc, (), str(link)).allow
    # And the cwd itself is never a write target (`/?*` in the bash).
    assert not _under_session_cwd(str(link), str(link))


def test_a_heredoc_body_containing_rm_rf_root_on_its_own_line_is_not_split_into_segments(main):
    # The body writes inert text — it is never executed — so even a body that reads like a
    # dangerous command is safe to write, and this only reads allowed if the segmenter kept
    # the whole body lifted out rather than splitting it into top-level segments.
    assert allowed("cat > /tmp/x.sh <<'EOF'\nrm -rf /\nEOF\n", main)


def test_a_non_write_heredoc_with_an_all_allow_listed_looking_body_still_defers(main):
    # The stronger discriminating case: a heredoc that is NOT the cat>path write shape
    # (`cat <<'EOF'` with no `>`) whose body is entirely allow-listed text. If the parser
    # ever mis-lifted the body into top-level segments, "echo hi" and "ls" would each earn
    # their own allow entry and this would misread allowed.
    d = judge("cat <<'EOF'\necho hi\nls\nEOF\ngit status", main, ROOTS, CWD)
    assert d.rule == "unjudgeable:heredoc"


def test_heredoc_write_parity_refuses_an_unquoted_delimiter_a_path_escape_or_an_unconfined_target(
    main,
):
    # Unquoted delimiter: body can carry a live $(...), stays unjudgeable regardless of path.
    assert not allowed("cat > /tmp/x.sh <<EOF\necho hi\nEOF\n", main)
    # `..`, a leading `~`, or a leading `$` — refused outright, scratch root or not.
    assert not allowed("cat > /tmp/../etc/x <<'EOF'\nhi\nEOF\n", main)
    assert not allowed("cat > ../etc/passwd <<'EOF'\nhi\nEOF\n", main)
    assert not allowed("cat > ~/.bashrc <<'EOF'\nhi\nEOF\n", main)
    assert not allowed("cat > $HOME/x <<'EOF'\nhi\nEOF\n", main)
    # Not under any scratch root, and CWD ("/home/testuser") doesn't confine it either.
    assert not allowed("cat > /etc/passwd <<'EOF'\nhi\nEOF\n", main)
    # The write earns its own segment's approval only — the rest of the chain still has to
    # clear the allow list on its own.
    assert not allowed("cat > /tmp/x.sh <<'EOF'\nhi\nEOF\nfrobnicate", main)


# --- J1/J2: a shell metacharacter in the heredoc target (task-8-fix-3-brief.md) -------------------
#
# `_HEREDOC_CAT_WRITE`'s path capture (`[^\s"']+`) admits any character that isn't
# whitespace or a quote — including every shell metacharacter. Both bugs measured ALLOW
# through the real entry point (live mode, cwd `/home/ubuntu/server`)
# before the `tokenize(hw_target) is None` gate closed them; reproduced here through
# `judge()` with the roots/cwd `rules_for`'s fixtures already use.


def test_j1_a_second_redirect_hidden_in_the_target_is_refused_on_the_cwd_arm(main, tmp_path):
    # Bash tokenizes `a>/etc/x` as TWO redirects (`>a` then `>/etc/x`), and the LAST one
    # wins — so the guard would be vetting `a>/etc/x` under cwd confinement while the
    # shell actually writes to `/etc/x`, entirely outside it. roots=() isolates this to
    # the cwd arm alone, the same control the parity tests above use.
    cwd = str(tmp_path)
    d = judge("cat > a>/etc/x <<'EOF'\nhi\nEOF\n", main, (), cwd)
    assert not d.allow
    assert d.rule == "segment:0:heredoc-write:special-char"
    # `<` carries the identical capture shape (lower impact: input redirect, not write).
    assert not judge("cat > a<b <<'EOF'\nhi\nEOF\n", main, (), cwd).allow
    # `>>` append and `>&` fd-dup forms measured ALLOW too.
    assert not judge("cat >> a>&/etc/x <<'EOF'\nhi\nEOF\n", main, (), cwd).allow


def test_j1_a_second_redirect_hidden_in_the_target_is_refused_on_the_scratch_arm(main):
    # Same defect, scratch-root arm: an absolute-looking prefix under a real scratch root
    # (`/tmp`) with a `>` hidden inside still must not confine on the PREFIX alone.
    d = judge("cat > /tmp/a>/etc/x <<'EOF'\nhi\nEOF\n", main, ROOTS, CWD)
    assert not d.allow
    assert d.rule == "segment:0:heredoc-write:special-char"


def test_j2_a_mid_word_parameter_expansion_in_the_target_is_refused(main, tmp_path):
    # `_under_session_cwd` used to refuse `$` only as the FIRST character of the target.
    # `${X:-.}` expands to `.` wherever it sits in the word, so `.${X:-.}/x` becomes
    # `../x` once bash expands it — a write one level above cwd that the old check never
    # saw, because the `$` here is not at position 0.
    cwd = str(tmp_path)
    d = judge("cat > .${X:-.}/x <<'EOF'\nhi\nEOF\n", main, (), cwd)
    assert not d.allow
    assert d.rule == "segment:0:heredoc-write:special-char"
    # A backtick command substitution embedded the same way.
    assert not judge("cat > a`b`c <<'EOF'\nhi\nEOF\n", main, (), cwd).allow


def test_j1_j2_control_a_plain_relative_heredoc_write_still_allows_on_both_arms(main, tmp_path):
    # The gate must not cost anything it wasn't scoped to: a plain path with none of the
    # refused characters still clears both arms exactly as before.
    cwd = str(tmp_path)
    assert judge("cat > note.txt <<'EOF'\nhi\nEOF\n", main, (), cwd).allow  # cwd arm
    assert judge("cat > /tmp/note.txt <<'EOF'\nhi\nEOF\n", main, ROOTS, CWD).allow  # scratch arm


# --- K1: a heredoc delimiter with a non-whitespace boundary character smuggles an
# unjudged command through (task-8-fix-4-brief.md) ------------------------------------
#
# `_HEREDOC_CAT_WRITE`'s tail (`\s*$`) and `segment.py`'s quoted-delimiter branch (no
# absorption loop past the closing quote) each independently treated a byte bash does
# NOT consider IFS whitespace — `\r`, or any Unicode whitespace like U+3000 — as if it
# ended the delimiter word. Bash disagrees: that byte is the LAST character of the real
# delimiter word, not a boundary after it, so bash closes the heredoc at the literal
# `EOF\r`/`EOF　` line while the unfixed python swallowed everything past the
# shorter, wrong delimiter — including a hidden command after the real terminator — into
# one heredoc body, and the unfixed regex still matched the resulting (truncated)
# segment text as a clean write, bypassing `unjudgeable:heredoc` entirely. Measured
# ALLOW, end to end, before this round.


def test_k1_a_cr_terminated_delimiter_no_longer_swallows_the_hidden_command(main, tmp_path):
    cwd = str(tmp_path)
    cmd = "cat > note.txt <<'EOF'\r\nhi\nEOF\r\nmkdir hidden-command-ran\n"
    d = judge(cmd, main, (), cwd)
    assert not d.allow
    assert d.rule == "unjudgeable:heredoc"


def test_k1_a_unicode_whitespace_terminated_delimiter_is_the_same_defect(main, tmp_path):
    # No CR needed: any byte outside `_DELIM_END`/`WS` reproduces it, including a
    # non-ASCII one.
    cwd = str(tmp_path)
    cmd = "cat > note.txt <<'EOF'　\nhi\nEOF　\nmkdir hidden-command-ran\n"
    d = judge(cmd, main, (), cwd)
    assert not d.allow
    assert d.rule == "unjudgeable:heredoc"


def test_k1_control_the_plain_terminated_form_still_allows(main, tmp_path):
    # The gate must not cost the ordinary case: a delimiter that really does end at a
    # newline still clears the carve-out exactly as before.
    cwd = str(tmp_path)
    assert judge("cat > note.txt <<'EOF'\nhi\nEOF\n", main, (), cwd).allow


# --- K2: an unanchored _FD_DUP lets a combined-stream redirect target escape cwd
# (task-8-fix-4-brief.md) --------------------------------------------------------------
#
# `_FD_DUP` matched only `>&<digit>`, not the whole word bash reads after `>&`. Bash
# tokenizes `>&1/../../x` as one word; since it is not purely digits, bash treats it as
# `> 1/../../x 2>&1` — a real write target, not a harmless fd dup. The unanchored regex
# stripped only the leading `>&1`, leaving `/../../x` with no `>` in the residue, so the
# redirect refusal never fired and the segment fell through to the plain allow list.


def test_k2_a_path_glued_onto_a_combined_stream_redirect_refuses(main):
    d = judge("ls >&1/../../canary.txt", main, ROOTS, CWD)
    assert not d.allow
    assert d.rule == "segment:0:redirect"


def test_k2_control_plain_fd_dups_still_allow(main):
    assert allowed("ls 2>&1", main)
    assert allowed("ls >&2", main)


# --- H1: a cd/pushd/popd relocates a confined heredoc write (task-8-fix-2-brief.md) --------------


def test_a_cd_before_a_heredoc_write_refuses_the_carve_out_on_both_arms(rm, tmp_path):
    # `rm` (the fixture) allow-lists `cd`, so segment 0 clears on its own the way the
    # brief's own repro does against the real settings — the defect this closes is that
    # the write used to ride through on that clearance.
    cwd = str(tmp_path)
    # The cwd arm: a RELATIVE target that would resolve under cwd if cwd hadn't moved —
    # this is the live repro, end to end, through judge() rather than judge_segment alone.
    d = judge("cd /tmp && cat > note.txt <<'EOF'\nhi\nEOF\n", rm, (), cwd)
    assert not d.allow
    assert d.rule == "segment:1:heredoc-write:cwd-changed"
    # The scratch-root arm with a RELATIVE target: `under_scratch` refuses it on its own,
    # so the flag is what refuses it here too. Rule pinned, not just the allow bit, so
    # the absolute exemption below can never widen to cover it.
    d2 = judge("cd /tmp && cat > note.txt <<'EOF'\nhi\nEOF\n", rm, ROOTS, cwd)
    assert not d2.allow
    assert d2.rule == "segment:1:heredoc-write:cwd-changed"


def test_an_absolute_scratch_heredoc_write_after_a_cd_is_clean(rm, tmp_path):
    # dotfiles #513: an absolute target does not depend on cwd, so a `cd` earlier in the
    # chain cannot relocate it. `/tmp` is a real scratch root (tables.SCRATCH_ROOTS). The
    # reason label is pinned so the census can attribute the row to this branch.
    d = judge("cd /tmp && cat > /tmp/note.txt <<'EOF'\nhi\nEOF\n", rm, ROOTS, str(tmp_path))
    assert d.allow
    assert d.reasons[1] == "heredoc-write:absolute-after-cd"


def test_an_absolute_heredoc_write_after_a_cd_is_flagged_outside_the_scratch_arm(rm):
    # The exemption is the SCRATCH arm only. `CWD` (/home/testuser) is under none of
    # `ROOTS` — `tmp_path` would be, since /tmp is a scratch root, and the scratch arm
    # would confine it legitimately. An absolute target under the session cwd clears
    # `_under_session_cwd` with no `cd` in the chain, and must not clear it after one —
    # the session cwd is exactly the value a `cd` makes stale.
    assert judge(f"cat > {CWD}/note.txt <<'EOF'\nhi\nEOF\n", rm, ROOTS, CWD).allow
    d = judge(f"cd /tmp && cat > {CWD}/note.txt <<'EOF'\nhi\nEOF\n", rm, ROOTS, CWD)
    assert not d.allow
    assert d.rule == "segment:1:heredoc-write:cwd-changed"
    # An absolute target outside every scratch root stays refused after a `cd`, on the
    # same label — the exemption is confinement-gated, not "any absolute path".
    d2 = judge("cd /tmp && cat > /etc/note.txt <<'EOF'\nhi\nEOF\n", rm, ROOTS, CWD)
    assert not d2.allow
    assert d2.rule == "segment:1:heredoc-write:cwd-changed"


def test_a_cd_after_a_heredoc_write_does_not_retroactively_refuse_it(rm, tmp_path):
    # The flag is set strictly AFTER a segment is judged `ok`, in chain order — a `cd`
    # later in the chain must not retroactively refuse a write that already happened
    # first, and the write itself must still clear confinement normally. No `&&`/`;`
    # between the heredoc terminator and `cd /tmp`: a bare newline there already acts as
    # the separator, the same shape `test_heredoc_write_parity_...`'s `frobnicate` case
    # above uses for the segment that follows a heredoc write.
    cwd = str(tmp_path)
    assert judge("cat > note.txt <<'EOF'\nhi\nEOF\ncd /tmp", rm, (), cwd).allow


def test_a_plain_confined_heredoc_write_with_no_cd_anywhere_in_the_chain_still_allows(rm, tmp_path):
    # Control for both tests above: remove the `cd` and the same write allows. `ls`, not
    # `cd`, precedes it — proves the gate is keyed on the command word, not "any earlier
    # segment at all".
    cwd = str(tmp_path)
    assert judge("ls && cat > note.txt <<'EOF'\nhi\nEOF\n", rm, (), cwd).allow


def test_pushd_and_popd_refuse_the_carve_out_the_same_way_cd_does(tmp_path):
    # `rm` (the shared fixture) allow-lists `cd` but not `pushd`/`popd` — using it here
    # would make segment 0 refuse as `unlisted` BEFORE the heredoc segment is ever
    # reached, so both asserts would pass without exercising `_changes_cwd` at all. A
    # dedicated ruleset that allow-lists all three closes that gap.
    rules = rules_for(
        tmp_path, {"allow": ["Bash(cd:*)", "Bash(pushd:*)", "Bash(popd:*)"], "deny": [], "ask": []}
    )
    cwd = str(tmp_path)
    d1 = judge("pushd /tmp && cat > note.txt <<'EOF'\nhi\nEOF\n", rules, (), cwd)
    assert not d1.allow
    assert d1.rule == "segment:1:heredoc-write:cwd-changed"
    d2 = judge("popd && cat > note.txt <<'EOF'\nhi\nEOF\n", rules, (), cwd)
    assert not d2.allow
    assert d2.rule == "segment:1:heredoc-write:cwd-changed"


def test_a_cd_hidden_behind_a_wrapper_still_refuses_the_heredoc_carve_out(rm, tmp_path):
    # Found via review after the brief's own text, not named in it: `judge_segment`
    # resolves `timeout 5 cd /tmp` through `unwrap_wrapper` to the allow-listed `cd /tmp`
    # and judges segment 0 "ok" on that path, but a check keyed only on the RAW segment's
    # first word (`timeout`) never saw the `cd` underneath — measured ALLOW end to end
    # through the real entry point before this re-check was added to `_changes_cwd`.
    cwd = str(tmp_path)
    assert not judge("timeout 5 cd /tmp && cat > note.txt <<'EOF'\nhi\nEOF\n", rm, (), cwd).allow
    # Control: the same wrapper shape over a command that is NOT cd-like must not trip
    # the flag — proves this is keyed on the unwrapped command word, not on "any wrapper".
    assert judge("timeout 5 ls /tmp && cat > note.txt <<'EOF'\nhi\nEOF\n", rm, (), cwd).allow


# --- H2: the heredoc carve-out no longer bypasses a deny rule (task-8-fix-2-brief.md) ------------


def test_a_deny_rule_matching_the_heredoc_write_segment_itself_wins_over_the_carve_out(tmp_path):
    # Before this fix, judge_segment returned `True, "heredoc-write"` before ever
    # consulting rules.denies(part) — a deny rule matching the exact write segment was
    # silently bypassed. The deny entry below is a PLAIN (non-glob) prefix that matches
    # this segment's text exactly, so it goes through `matches_any`, not a glob.
    rules = rules_for(
        tmp_path, {"allow": [], "deny": ["Bash(cat > /tmp/pwned <<'EOF')"], "ask": []}
    )
    d = judge("cat > /tmp/pwned <<'EOF'\nhi\nEOF\n", rules, ROOTS, CWD)
    assert not d.allow
    assert d.rule == "segment:0:deny"


# --- H4: an unanchored /dev/null match strips a near-miss target too (task-8-fix-2-brief.md) -----


def test_a_target_merely_starting_with_devnull_does_not_escape_the_redirect_refusal(main):
    # `_DEVNULL_REDIRECT` used to match `/dev/null` as a PREFIX with no terminator, so
    # `/dev/nullx` was stripped down to nothing and the blanket `>` refusal never fired.
    assert not allowed("ls > /dev/nullx", main)
    assert not allowed("git status > /dev/nullish", main)
    # Control: the real /dev/null is unaffected by the anchor.
    assert allowed("ls > /dev/null", main)


def test_a_target_merely_starting_with_devnull_does_not_escape_the_tee_refusal(esc):
    # The identical defect, one token over, in `_DEVNULL_WORD` — found while fixing H4,
    # not named in the brief. `tee:*` is allow-listed for real (settings.permissions.json),
    # so `tee /dev/nullx` stripped to the allow-listed bare `tee` and auto-approved an
    # arbitrary write target.
    assert not allowed("tee /dev/nullx", esc)
    # Control: a real /dev/null target is unaffected.
    assert allowed("tee /dev/null", esc)


# --- J5: Python \s is broader than bash's word boundary (task-8-fix-3-brief.md), conf. 30 --------


def test_a_trailing_cr_after_devnull_no_longer_reads_as_the_boundary(main):
    # `(?=\s|$)` used Python's `\s`, which admits `\r` where bash's real word boundary
    # after a redirect target is space or tab. `ls > /dev/null\r` measured ALLOW before
    # this fix: the lookahead treated the trailing CR as a boundary and stripped
    # "> /dev/null" as the harmless sink, while bash's actual filename is `/dev/nullCR` —
    # not the real device. `(?=[ \t]|$)` no longer treats CR as a boundary, so the `>`
    # survives the substitution and the blanket redirect refusal fires instead — deferring
    # rather than silently reading a made-up target as harmless.
    assert not allowed("ls > /dev/null\r", main)
    # Control: the real /dev/null (space-terminated, or end of segment) is unaffected.
    assert allowed("ls > /dev/null", main)


# No sibling test for `_DEVNULL_WORD` (judge.py:64): mutation-checked while writing this —
# reverting that one pattern's lookahead to bare `\s` does NOT flip any assertion. The
# lookahead never consumes what follows, so ANY trailing character survives into `teed`
# (judge_segment's `teed = _DEVNULL_WORD.sub(...)`) regardless of which class the
# lookahead accepts; the downstream `teed != teecmd` comparison — not this regex — is
# what actually refuses a target carrying trailing junk, `\r` included, and it does so
# either way. Fixed for parity with `_DEVNULL_REDIRECT` per the brief (one character
# class, harmless), not because it closes an independently observable gap here.


# --- benign prefixes (PR #477) -------------------------------------------------------------------


def test_set_options_are_stripped_and_the_rest_of_the_chain_is_judged_normally(main):
    assert allowed("set -e && git status && git log --oneline -1", main)
    assert allowed("set -euo pipefail && git status", main)
    assert allowed("set -o pipefail; git status", main)


def test_a_set_prefix_does_not_rescue_an_otherwise_denied_or_unlisted_segment(main):
    assert not allowed("set -e && frobnicate", main)
    assert not allowed("set -e && rm -rf build", main)


def test_g1_an_assignment_prefix_is_refused_not_stripped(main):
    # G1 (task-8-fix-1-brief.md): #477's strip-and-judge-what's-left arm is not ported.
    # Every segment whose first word is a `VAR=value` assignment refuses outright, with
    # its own distinct rule label, rather than being stripped and the remainder judged.
    assert not allowed("FOO=bar git status && git log --oneline -1", main)
    assert not allowed("FOO=bar BAZ=1 git status && git log", main)
    assert (
        judge("FOO=bar git status && git log --oneline -1", main, ROOTS, CWD).rule
        == "segment:0:assignment"
    )


def test_g1_red_proof_an_assignment_prefix_refuses_the_plain_form_still_allows(main):
    # The reviewer's own measured fail-open on 96da9d4: stripping `PATH=/tmp` turned
    # `PATH=/tmp ls -la` into `ls -la`, an allow-listed command — auto-approving a
    # command that actually resolves `ls` out of an attacker-writable /tmp. The plain
    # form, with no assignment prefix, must stay allowed; that's the rejecting half of
    # the pair, not an incidental fact.
    assert not allowed("PATH=/tmp ls -la", main)
    assert judge("PATH=/tmp ls -la", main, ROOTS, CWD).rule == "segment:0:assignment"
    assert allowed("ls -la", main)


def test_a_var_value_assignment_refuses_regardless_of_what_its_value_can_do(main):
    # Before G1, a value carrying a live $, backtick or `(` was left unstripped and judged
    # as itself, failing every check the same way an unlisted command would. Now every
    # assignment-prefixed segment refuses uniformly BEFORE any value-content reasoning
    # runs — except where the pre-existing global substitution gate (parsed.substitutions,
    # judged over the whole command before the per-segment loop starts) fires first, which
    # it still does for a real $(...) or backtick.
    assert (
        judge("FOO=$(whoami) git status && ls", main, ROOTS, CWD).rule == "unjudgeable:substitution"
    )
    assert (
        judge("FOO=`whoami` git status && ls", main, ROOTS, CWD).rule == "unjudgeable:substitution"
    )
    # A bare $VAR reference is not a substitution to the segmenter, so this one reaches
    # the per-segment loop — and is refused there as "assignment", not "unlisted" the way
    # it read before G1 (it still fails every check, just under the distinct label the
    # census needs to tell the two refusal reasons apart).
    assert judge("FOO=$BAR git status && ls", main, ROOTS, CWD).rule == "segment:0:assignment"


def test_a_bare_assignment_with_no_command_following_still_refuses(rm):
    # G1 removed stripping outright, including the "nothing left after stripping" shape
    # the old code read as a no-op and skipped. A standalone `VAR=value` segment with no
    # command after it persists in the CURRENT shell for a later segment in the same
    # chain — `PATH=/tmp; ls` is the `;`-separated sibling of `PATH=/tmp ls`, not a safer
    # shape — so it earns the same refusal the prefixed form does, and the chain never
    # reaches the later segment to find out whether that one alone would have been safe.
    assert judge("FOO=/tmp/scratch; rm -rf $FOO", rm, ROOTS, CWD).rule == "segment:0:assignment"


# --- single-segment check reachability (D2, Task 7) ---------------------------------------------
#
# Before D2, `curl`/`rm`/`remote`/`ansible`/`git_reset` were each individually correct but
# unreachable for a BARE command: judge() returned "not-compound" before any of them ever
# ran. These pin that each is now reachable on its own, not only as one segment of a chain
# — "the check exists" and "the check is reachable" are different claims.


def test_a_bare_safe_curl_is_now_reachable(main):
    assert allowed("curl http://127.0.0.1:8000/", main)


def test_a_bare_readonly_remote_command_is_now_reachable(main):
    # Fix round 1, F4: `ssh daniel-server true` (the original fixture here) satisfies
    # BOTH readonly_remote_safe (`true` is a REMOTE_READONLY_VERBS member) and
    # trusted_host_safe (`daniel-server` is a TRUSTED_SSH_HOSTS member) at once, so
    # deleting either check individually left this single fixture green -- the reviewer
    # mutation-proved it, 758 passed both ways. These two separate: neither host below is
    # trusted_host_safe-eligible (`hl` takes no host at all; daniel-box is not in
    # TRUSTED_SSH_HOSTS), so only readonly_remote_safe can be reaching them.
    #
    # Fix round 2, finding 6: pin the rule label too, not only the allow bit. The two
    # checks now return distinct rules (remote-readonly-check / trusted-host-check,
    # judge.py) so the shadow census can attribute a python_only row to the check that
    # produced it -- that's the entire point of finding 6, and without an assertion on
    # the label itself, collapsing the two rules back into one shared string goes green.
    assert allowed("hl uptime", main)
    assert allowed("ssh daniel-box uptime", main)
    assert judge("hl uptime", main, ROOTS, CWD).rule == "remote-readonly-check"


def test_a_bare_trusted_host_command_is_now_reachable(main):
    # The other half of F4's separation: `touch` is not in REMOTE_READONLY_VERBS, so only
    # trusted_host_safe (daniel-server is TRUSTED_SSH_HOSTS) can be reaching this one.
    assert allowed('ssh daniel-server "touch /tmp/pwned"', main)
    assert (
        judge('ssh daniel-server "touch /tmp/pwned"', main, ROOTS, CWD).rule == "trusted-host-check"
    )


def test_a_bare_readonly_ansible_check_is_now_reachable(main):
    assert allowed("ansible-playbook site.yml --check", main)


def test_ansible_check_survives_the_stdio_blocking_prefix_and_trailing_tail_pipe(main):
    # Fix round 1, F6: fixed by F0, verified here rather than patched separately. Before
    # F0, these were judged per-SEGMENT (judge()'s own segmenter splits the `| tail -3`
    # away from the `2>&1` ahead of it, leaving a bare `2>&1` that ansible_readonly_safe's
    # `_TRAILING` regex cannot match — it needs the pipe attached). The whole-command arm
    # hands ansible_readonly_safe the UNSPLIT command, exactly where its own leading/
    # trailing strips (stdio-blocking.py's fixup prefix, the tail-bounding suffix) expect
    # to find them. Both are the plan's named live production shape.
    assert allowed(
        "stdio-blocking; uv run ansible-playbook ansible/deploy.yml --tags karakeep --check"
        " 2>&1 | tail -3",
        main,
    )
    assert allowed("ansible-playbook site.yml --check 2>&1 | tail -3", main)


def test_a_bare_clean_git_reset_hard_is_now_reachable(main, tmp_path):
    work = _make_repo(tmp_path)
    assert judge("git reset --hard origin/master", main, ROOTS, work).allow


def test_a_chained_segment_does_not_earn_a_standalone_hooks_grace(main, tmp_path):
    # F0's REJECTING half. Every assertion above this one is an allow — none of them goes
    # red if the four checks are wired back into judge_segment as a per-segment arm
    # instead of a judge() whole-command arm. These three prove the rejection: each
    # chains a first segment that is allow-listed on its own ("git status", under MAIN)
    # with a second segment that the standalone hook it once delegated to would approve
    # in ISOLATION, but that the real allow-readonly-remote.sh/allow-daniel-server.sh/
    # allow-ansible-readonly.sh/allow-clean-reset.sh never sees as a segment of a chain —
    # each is a PermissionRequest hook judging the WHOLE raw command, and all four
    # self-refuse a compound shape (the comment above judge()'s whole-command arms). Put
    # the check back in judge_segment and segment 1 here earns its own "-check" reason
    # from the bare segment text alone, flipping the whole decision to allow.
    #
    # `_make_repo` gives a CLEAN repo: read the check without it and `clean_reset_safe`
    # returns False regardless of wiring (F1's empty/non-absolute cwd refusal doesn't
    # apply here, but a dirty or missing repo would make this assertion pass under both
    # wirings, proving nothing).
    #
    # server #1898 moved the two REMOTE checks to a per-segment arm as well (judge_segment,
    # `word in ("ssh", "hl")`), so the ssh line below is now an allow — that arm is what
    # replaced the server repo's own pipeline-walking PermissionRequest shim. The git-reset
    # and ansible lines keep F0's rejection: neither check has a per-segment twin.
    work = _make_repo(tmp_path)
    assert not judge("git status && git reset --hard origin/master", main, ROOTS, work).allow
    assert allowed("git status && ssh daniel-server uptime", main)
    assert not allowed("git status && ansible-playbook site.yml --check", main)


# server #1898: the per-segment remote arm. The shape the whole-command arms refuse and the
# retired server shim (`auto-approve-remote-ssh.sh`) allowed — an ssh stage inside a local
# pipeline — and the shapes that must stay refused around it.


def test_an_ssh_stage_in_a_local_pipeline_is_allowed_when_every_other_stage_is(main):
    # The payload docs/claude-shell-permissions.md measured the two hooks diverging on.
    d = judge("ssh daniel-server docker ps | tail -3", main, ROOTS, CWD)
    assert d.allow and d.reasons == ("remote-readonly-check", "allow-list")
    d = judge("hl journalctl -u docker -n 50 | tail -3", main, ROOTS, CWD)
    assert d.allow and d.reasons[0] == "remote-readonly-check"


def test_a_trusted_host_stage_in_a_local_pipeline_is_allowed_by_the_trusted_arm(main):
    d = judge('ssh daniel-server "cd /home/ubuntu/server; git status" | tail -3', main, ROOTS, CWD)
    assert d.allow and d.reasons == ("trusted-host-check", "allow-list")


def test_a_stderr_sink_word_on_the_ssh_stage_is_stripped_before_the_remote_checks(main):
    assert allowed("ssh daniel-server docker ps 2>&1 | tail -3", main)
    assert allowed("ssh daniel-server docker ps 2>/dev/null | tail -3", main)
    assert allowed("hl uptime 2> /dev/null | tail -1", main)


def test_a_stderr_sink_glued_to_the_verb_is_not_stripped(main):
    # `ping6>/dev/null` is the word `ping6` plus a redirect; stripping it would judge `ping`.
    assert not allowed("ssh 10.0.0.9 ping6>/dev/null | tail -1", main)


def test_a_real_redirect_on_the_ssh_stage_still_refuses(main):
    assert not allowed("ssh daniel-server docker ps > /tmp/out | tail -3", main)
    assert not allowed("ssh daniel-server docker ps 2>&1w | tail -3", main)


def test_an_unlisted_stage_beside_an_allowed_ssh_stage_still_refuses(main):
    d = judge("ssh daniel-server uptime && touch /tmp/pwned", main, ROOTS, CWD)
    assert not d.allow and d.rule == "segment:1:unlisted"


def test_an_untrusted_host_with_a_mutating_payload_gets_no_per_segment_grace(main):
    assert not allowed("ssh 10.0.0.9 docker rm web | tail -1", main)
    assert not allowed("ssh 10.0.0.9 uptime; ssh 10.0.0.9 docker rm web", main)
