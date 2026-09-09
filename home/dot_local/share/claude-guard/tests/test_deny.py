"""block-dangerous-bash.sh, ported: every rule family as a denied/allowed pair.

The inline lists here are the ones in tests/hooks/block-dangerous-bash.test.js; the corpus
lives in tests/fixtures/block-dangerous-bash-vectors.json (Task 5). The normalisation
suite is tests/test_deny_normalization.py. HOME is pinned to a fake so the home-directory
anchors are deterministic; the bash gets the same value when it is run for comparison.
"""

from pathlib import Path

from claude_guard import deny as d
from claude_guard.deny import bdb_re, bdb_re_pair, bdb_rei, build_scan, normalize

REPO = Path(__file__).resolve().parents[5]
HOOKS = REPO / "home" / "private_dot_claude" / "hooks"
HOOK = HOOKS / "executable_block-dangerous-bash.sh"
FIXTURE = REPO / "tests" / "fixtures" / "block-dangerous-bash-vectors.json"
HOME = "/home/tester"
ENV = {"HOME": HOME}


# --- the matchers (:74-106, :326-335) ------------------------------------------------------


def test_bdb_re_anchors_at_the_start_of_every_line_is_matched():
    assert bdb_re("echo a\nterraform destroy", r"^terraform")


def test_bdb_re_a_match_never_crosses_a_newline_is_unmatched():
    assert not bdb_re("git\npush", r"git\s+push")


def test_bdb_re_translates_the_posix_classes_is_matched():
    assert bdb_re("gh  api", r"gh[[:space:]]+api")
    assert bdb_re("x-y", r"[^[:alnum:]_]")


def test_bdb_rei_folds_case_is_matched():
    assert bdb_rei("TERRAFORM APPLY", r"terraform\s+apply")
    assert not bdb_re("TERRAFORM APPLY", r"terraform\s+apply")


def test_bdb_re_pair_needs_both_patterns_on_one_line():
    assert bdb_re_pair("git push --force x main\nls", r"git\s+push", r"\bmain\b")
    split = "git push --force x\ngh pr create --base main"
    assert not bdb_re_pair(split, r"git\s+push", r"\bmain\b")


# --- normalisation (:216-236) -----------------------------------------------------------------


def test_normalize_drops_quotes_and_collapses_whitespace():
    assert normalize('rm -rf "$HOME"\n\t') == "rm -rf $HOME  "


def test_normalize_drops_an_escaped_separator_and_keeps_the_tokens_joined():
    assert normalize("grep 'a\\;b' f") == "grep ab f"


def test_normalize_an_escaped_backslash_leaves_the_separator_real():
    assert ";" in normalize("echo a\\\\; terraform apply")


def test_normalize_drops_a_quoted_separator():
    assert normalize('echo "step 1; terraform apply"') == "echo step 1 terraform apply"


def test_normalize_keeps_a_quoted_separator_when_an_interpreter_is_named():
    assert normalize('bash -c "echo a; terraform apply"') == "bash -c echo a; terraform apply"


def test_normalize_keeps_every_separator_when_a_quote_is_unbalanced():
    assert normalize('echo "unbalanced ; terraform apply') == "echo unbalanced ; terraform apply"


def test_normalize_an_escaped_quote_is_not_an_opener():
    assert ";" in normalize('echo \\" ; terraform apply')


def test_normalize_a_backslash_inside_single_quotes_escapes_nothing():
    assert ";" in normalize("echo 'a\\' ; terraform apply")


# --- the scan set (:238-317) -------------------------------------------------------------------


def test_build_scan_puts_scan_first_then_one_line_per_segment_and_substitution():
    sc = build_scan("echo a\nterraform destroy $(ls; pwd)")
    assert sc.parsed
    assert sc.scanset.split("\n")[0] == sc.scan
    assert "terraform destroy $(ls; pwd)" in sc.scanset.split("\n")
    assert "ls" in sc.scanset.split("\n")
    assert sc.scan not in sc.segset.split("\n")


def test_build_scan_degrades_to_scan_alone_when_the_parse_refuses():
    sc = build_scan('terraform destroy "unclosed')
    assert not sc.parsed
    assert sc.scanset == sc.scan == sc.segset


def test_rm_target_names_the_callers_home_when_given():
    assert bdb_re("rm -rf /home/tester", d.rm_target("/home/tester"))
    assert not bdb_re("rm -rf /home/tester/dev", d.rm_target("/home/tester"))
    assert bdb_re("rm -rf ~", d.rm_target(""))
