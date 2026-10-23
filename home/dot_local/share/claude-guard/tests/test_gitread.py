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
    ],
)
def test_a_write_or_exec_form_is_refused(command):
    assert not git_read(shlex.split(command))


@pytest.mark.parametrize(
    "command",
    [
        "git config --global --get-all rerere.autoupdate",
        "git config --get user.signingkey",
        "git config --global --list --show-origin",
        "git config --get-regexp '^remote\\.' --name-only",
        "git config --type=bool --default=false --get core.bare",
        "git config get --global user.name",
        "git config list --local",
        "git -C /x config --get remote.origin.url",
    ],
)
def test_a_config_read_is_admitted(command):
    assert git_read(shlex.split(command))


@pytest.mark.parametrize(
    "command",
    [
        "git config --global user.name x",
        "git config set --global a.b c",
        # No mode: with one word git reads, but the same shape with two writes.
        "git config user.name",
        "git config --global --unset rerere.autoupdate",
        "git config --global --edit",
        "git config get --edit x",
        # An abbreviation of a write option, and the options that read any file.
        "git config --global --ed",
        "git config --file /tmp/c --list",
        "git config -f /tmp/c --list",
        "git config --blob HEAD:x --list",
        "git -c include.path=/tmp/x config --list",
    ],
)
def test_a_config_write_or_file_read_is_refused(command):
    assert not git_read(shlex.split(command))
