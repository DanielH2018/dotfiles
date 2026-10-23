import shlex

import pytest

from claude_guard.gitread import git_read


@pytest.mark.parametrize(
    "command",
    [
        "git symbolic-ref --short refs/remotes/origin/HEAD",
        "git -C /x --no-pager symbolic-ref -q HEAD",
        "git ls-remote --heads origin main",
        "git ls-remote --exit-code origin 'refs/pull/1/*'",
        "git range-diff a..b c..d",
        "git merge-base --is-ancestor a b",
        # #965: config reads, by action flag, by verb, and as a lone name.
        "git config --global --get-all rerere.autoupdate",
        "git config --get user.signingkey",
        "git config --global --type=bool --default false --get pull.rebase",
        "git config -l --show-origin",
        "git config get --all --global user.name",
        "git config list --local",
        "git config user.name",
    ],
)
def test_a_read_form_is_admitted(command):
    assert git_read(shlex.split(command))


@pytest.mark.parametrize(
    "command",
    [
        # symbolic-ref sets a ref with a second name, and -d / -m belong to the write forms.
        "git symbolic-ref HEAD refs/heads/x",
        "git symbolic-ref -d HEAD",
        "git symbolic-ref -m why HEAD refs/heads/x",
        # ls-remote runs the program --upload-pack names, under any abbreviation or alias.
        "git ls-remote --upload-pack=/tmp/x origin",
        "git ls-remote --up=/tmp/x origin",
        "git ls-remote --exec=/tmp/x origin",
        "git ls-remote 'ext::sh -c id' x",
        "git ls-remote -u /tmp/x origin",
        "git range-diff --output=/tmp/x a..b c..d",
        "git range-diff --outp=/tmp/x a..b c..d",
        # Config and the exec path can each make git run a program.
        "git -c core.pager=/tmp/x range-diff a..b c..d",
        "git --exec-path=/tmp merge-base a b",
        "git status",
        # #965: a config write, an editor, or a read of a file nothing vetted.
        "git config --global user.name x",
        "git config user.name x",
        "git config set user.name x",
        "git config --global --unset user.name",
        "git config unset user.name",
        "git config --global --edit",
        "git config --ed",
        "git config edit",
        "git config --add core.x y",
        "git config --file /tmp/f --list",
        "git config --blob HEAD:x --list",
        "git config --global",
    ],
)
def test_a_write_or_exec_form_is_refused(command):
    assert not git_read(shlex.split(command))
