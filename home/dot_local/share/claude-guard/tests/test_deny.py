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


# --- the helper every family test uses -------------------------------------------------------


def kinds(commands: list[str]) -> list[str]:
    return [d.deny(c, "", ENV).kind for c in commands]


def rules(commands: list[str]) -> list[str]:
    return [d.deny(c, "", ENV).rule for c in commands]


# --- remote re-scan (:613-659) ------------------------------------------------------------------

REMOTE_DENY = [
    "ssh homelab 'sudo systemctl restart docker'",
    'ssh ubuntu@10.0.0.161 "sudo rm -rf /var/lib"',
    "ssh homelab 'rm -rf /'",
    'ssh homelab "rm -rf ~"',
    "ssh homelab 'su - root'",
    "ssh homelab 'chown -R root:root /etc'",
    "ssh homelab 'chmod 777 /etc/shadow'",
    "ssh homelab 'shutdown -r now'",
    "ssh homelab 'sudo reboot'",
    '/usr/bin/ssh homelab "sudo poweroff"',
    "hl sudo reboot",
    "hl rm -rf /",
    "hl chown -R root:root /etc",
    "TERM=x ssh homelab reboot",
    "command ssh homelab sudo reboot",
    '"ssh" homelab "sudo rm -rf /var/lib"',
    "FOO=1 BAR=2 hl chown -R root:root /etc",
    'ssh h "true;su - root -c whoami"',
    'SSH host "sudo apt update"',
]
REMOTE_ALLOW = [
    "ssh homelab 'cd ~/server/ansible && ansible-playbook deploy.yml'",
    "ssh homelab 'docker ps'",
    "ssh homelab 'systemctl status docker'",
    'ssh homelab "~/.local/bin/claude -p hello"',
    "ssh homelab 'rm -rf ./build'",
    "ssh-add -l",
    "sudo systemctl status ssh",
    "ps aux | grep ssh",
    "echo `su - root -c reboot`",
]


def test_remote_payloads_are_denied():
    assert kinds(REMOTE_DENY) == ["deny"] * len(REMOTE_DENY)
    assert rules(["ssh homelab 'su - root'", "hl rm -rf /"]) == ["remote-su", "remote-rm-root"]


def test_remote_reads_and_local_mentions_of_ssh_are_allowed():
    assert "deny" not in kinds(REMOTE_ALLOW)


def test_remote_rescan_is_whole_string_by_decision():
    # :629-642: the payload scan stays whole-string. Narrowing it is a deny-removing change
    # the census measured as worth nothing (0 of 11,483). Pinned so a "cleanup" shows here.
    assert d.deny("ssh h uptime; sudo apt update", "", ENV).rule == "remote-sudo"


# --- rm -rf on home or root (:573-599, :661-667) --------------------------------------------

RM_DENY = [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -r -f /",
    "rm -rf /*",
    'rm -rf "$HOME"',
    "rm -rf '$HOME'",
    f"rm -rf {HOME}",
    f"rm -rf {HOME}/",
    f"rm -rf {HOME}/*",
    "echo $(rm -rf /)",
    "echo `rm -rf /`",
    'echo "`rm -rf /`"',
]
RM_ALLOW = [
    "rm -rf ./build",
    f"rm -rf {HOME}/dev/build",
    f"rm -rf {HOME}/.cache/foo",
    "rm -rf /tmp/scratch",
    "rm -rf /var/log/old",
    'rm -rf "$HOME/dev/build"',
    "rm -rf $HOME/dev/build",
    "rm -rf ~/dev/build",
    "echo $(rm -rf /some/path)",
    "echo $(rm -rf $HOME/dev/build)",
    'git commit -m "fix: handle rm -rf edge case"',
]


def test_rm_of_home_or_root_is_denied():
    assert kinds(RM_DENY) == ["deny"] * len(RM_DENY)
    assert rules(["rm -rf /", "rm -r -f /"]) == ["rm-root", "rm-root-split-flags"]


def test_rm_of_a_path_below_home_is_allowed():
    assert "deny" not in kinds(RM_ALLOW)


# --- git push (:669-728) ---------------------------------------------------------------------

PUSH_DENY = [
    "git push --force origin main",
    "git push -f origin master",
    "git push origin +main",
    "git push origin HEAD:main",
    "git push origin mybranch:main",
    "git push origin refs/heads/x:refs/heads/main",
    "git push origin HEAD:master",
    "git push upstream main",
    "git push --delete origin main",
    "git push --force-with-lease origin main",
    "git push origin main",
    'bash -c "git push origin main"',
    'git push --force"" origin main',
    "git push --force '' origin main",
    'git push "--force" origin main',
    'git push origin +"main"',
    "x=`git push origin main`",
    "echo $(git push --force origin main)",
]
PUSH_ALLOW = [
    "git push origin feature-x",
    "git push -u origin claude/my-work",
    "git push origin main:feature",
    "git push origin my-main-branch",
    "git push origin feature/main-menu",
    "git fetch origin main",
    "git rebase origin/main",
    "git merge --ff-only origin/main",
    "cd /repo && git push -q -u origin feat/x 2>&1 | tail -2; "
    "gh pr create --title t --body b --base main",
    "git push -f origin feat/x; gh pr create --base main",
    "git checkout main && git push origin feat/x",
    "x=$(git push origin main:feature)",
]


def test_push_to_main_is_denied():
    assert kinds(PUSH_DENY) == ["deny"] * len(PUSH_DENY)
    assert rules(
        ["git push --force origin main", "git push origin +main", "git push origin HEAD:main"]
    ) == ["force-push-main", "force-push-refspec", "push-main"]


def test_push_to_a_feature_branch_is_allowed():
    assert "deny" not in kinds(PUSH_ALLOW)


def test_push_and_destination_must_share_a_segment():
    # :683-688, :721-724: the push and the word `main` from different commands is not a push
    # to main. With the parse refused, the pair rule reads the whole string (:313-317).
    assert d.deny("git push -f origin feat/x; gh pr create --base main", "", ENV).kind != "deny"
    assert d.deny('git push -f origin feat/x "; gh pr create --base main', "", ENV).kind == "deny"


# --- gh api (:730-766) -------------------------------------------------------------------------

GH_DENY = [
    "gh api --method=DELETE repos/o/r",
    "gh api -XDELETE repos/o/r",
    "gh api --method=POST repos/o/r/issues",
    "gh api -XPOST repos/o/r/issues",
    "gh api repos/o/r/issues --field title=x",
    "gh api repos/o/r/issues --raw-field title=x",
    "gh api repos/o/r/issues -f title=x",
    "gh api --input=body.json repos/o/r/issues",
    "gh api --hostname github.com graphql",
    'echo "`gh api -XPOST repos/o/r`"',
    "echo a\ngh api -XPOST /repos/o/r/issues",
    "echo one\necho two\ngh api -X POST /repos/o/r",
]
GH_ALLOW = [
    "gh api repos/o/r",
    "gh api repos/o/r --jq .name",
    "gh api --method=GET repos/o/r",
    "gh api -XGET repos/o/r",
    "gh api --paginate repos/o/r/issues",
    'gh api -H "Accept: application/vnd.github+json" repos/o/r',
    "gh pr list",
    "gh pr view 42 --json state",
]


def test_gh_api_mutation_is_denied():
    assert kinds(GH_DENY) == ["deny"] * len(GH_DENY)
    assert rules(GH_DENY[:1] + GH_DENY[4:5] + GH_DENY[6:9]) == [
        "gh-api-method",
        "gh-api-field-long",
        "gh-api-field-short",
        "gh-api-input",
        "gh-api-graphql",
    ]


def test_gh_api_read_is_allowed():
    assert "deny" not in kinds(GH_ALLOW)


# --- deny() itself ---------------------------------------------------------------------------


def test_deny_returns_none_for_an_empty_command():
    assert d.deny("", "", ENV) == d.NONE


def test_deny_reads_home_from_env_and_ignores_cwd():
    assert d.deny("rm -rf /home/other", "/anywhere", {"HOME": "/home/other"}).kind == "deny"
    assert d.deny("rm -rf /home/other", "/anywhere", {"HOME": "/home/tester"}).kind == "none"


def test_deny_the_first_matching_rule_wins_in_bash_order():
    # :700: the force rule runs before the plain push-to-main rule and keeps its message.
    assert d.deny("git push --force origin main", "", ENV).rule == "force-push-main"
