"""Windows path spellings the judge must refuse, or accept, the way POSIX would.

Every test here drives a win32-only branch, so the module is skipped elsewhere. The refusal
tables are the point: a spelling that bash and ntpath read differently must never reach an
allow.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="exercises win32-only branches")

from claude_guard.checks.git_reset import _is_abs  # noqa: E402
from claude_guard.judge import _under_session_cwd, judge  # noqa: E402
from claude_guard.readonly import _resolve, classify  # noqa: E402
from claude_guard.rules import Rules, parse_rule  # noqa: E402

HEREDOC = "cat > {target} <<'EOF'\nhi\nEOF\n"


def _rules() -> Rules:
    return Rules(allow=(parse_rule("Bash(ls:*)"),), deny=(), ask=())


@pytest.fixture
def cwd(tmp_path: Path) -> str:
    (tmp_path / "sub").mkdir()
    return str(tmp_path)


@pytest.mark.parametrize(
    "path",
    [
        "/x",
        r"\x",
        "/c/Users/daniel/x",
        r"\\server\share\x",
        "//server/share/x",
        "C:x",
        "notes.txt:stream",
        "ab:stream",
        "../x",
        "sub/../../x",
        r"sub\notes.md",
        "~/x",
        "$HOME/x",
        "evil.lnk",
        "sub/evil.lnk",
    ],
)
def test_a_spelling_bash_and_ntpath_read_differently_is_refused(cwd, path):
    assert not _under_session_cwd(path, cwd)


def test_a_backslash_absolute_path_is_refused_but_its_forward_slash_form_is_not(cwd):
    posix = Path(cwd).as_posix()
    assert not _under_session_cwd(cwd + r"\notes.md", cwd)
    assert _under_session_cwd(f"{posix}/notes.md", cwd)


@pytest.mark.parametrize("path", ["notes.md", "sub/notes.md", "./notes.md"])
def test_a_plain_relative_path_under_the_cwd_is_allowed(cwd, path):
    assert _under_session_cwd(path, cwd)


def test_an_absolute_path_outside_the_cwd_is_refused(cwd):
    outside = Path(cwd).parent.as_posix()
    assert not _under_session_cwd(f"{outside}/notes.md", cwd)


@pytest.mark.parametrize("root_spelling", ["{d}/", "{d}\\", "{d}"])
@pytest.mark.parametrize("path", ["Users/daniel/.bashrc", "{d}/Users/daniel/.bashrc"])
def test_a_drive_root_cwd_confines_nothing(tmp_path, root_spelling, path):
    drive = tmp_path.drive
    cwd = root_spelling.format(d=drive)
    assert not _under_session_cwd(path.format(d=drive), cwd)


def test_the_judge_refuses_a_heredoc_write_when_the_cwd_is_a_drive_root(tmp_path):
    drive = tmp_path.drive
    for cwd in (f"{drive}/", f"{drive}\\"):
        for target in ("Users/daniel/.bashrc", f"{drive}/Users/daniel/.bashrc"):
            assert not judge(HEREDOC.format(target=target), _rules(), (), cwd).allow


def test_a_cwd_that_is_a_junction_to_a_drive_root_confines_nothing(tmp_path):
    link = tmp_path / "root"
    made = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), tmp_path.drive + "\\"],
        capture_output=True,
        check=False,
    )
    if made.returncode != 0:
        pytest.skip("cannot create a junction here")
    assert not _under_session_cwd("Users/daniel/.bashrc", str(link))


def test_a_system_attributed_component_is_refused(cwd):
    target = Path(cwd) / "sys.txt"
    target.write_text("x")
    assert _under_session_cwd("sys.txt", cwd)
    subprocess.run(["attrib", "+S", str(target)], check=True, capture_output=True)
    try:
        assert not _under_session_cwd("sys.txt", cwd)
    finally:
        subprocess.run(["attrib", "-S", str(target)], check=False, capture_output=True)


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/x", True),
        ("C:/x", True),
        (r"C:\x", True),
        ("c:/x", True),
        ("C:x", False),
        ("x", False),
        (r"\x", False),
        ("", False),
    ],
)
def test_the_git_reset_check_knows_an_absolute_path_on_windows(path, expected):
    assert _is_abs(path) is expected


# --- readonly: where a `cd` or `git -C` lands -------------------------------------------------


@pytest.fixture
def home(tmp_path: Path) -> Path:
    (tmp_path / "server" / "docs").mkdir(parents=True)
    return tmp_path


def ro(command: str, home: Path) -> str | None:
    return classify(command, str(home / "server"), str(home))


@pytest.mark.parametrize(
    "target",
    ["C:evil", "/Users/x", r"\x", "docs:s", "D:", "C:/a:b", "~user"],
)
def test_readonly_resolve_refuses_a_spelling_ntpath_and_bash_disagree_on(home, target):
    assert _resolve(target, str(home / "server"), str(home)) is None


def test_readonly_resolve_still_resolves_a_plain_relative_target_and_a_drive_path(home):
    base = str(home / "server")
    assert _resolve("docs", base, str(home)) == os.path.realpath(home / "server" / "docs")
    assert _resolve(home.as_posix(), base, str(home)) == os.path.realpath(home)


def test_a_drive_relative_cd_does_not_make_a_git_stage_read_only(home):
    assert ro("cd docs && git status", home) is not None
    assert ro("cd C:evil && git status", home) is None
    assert ro("git -C C:evil status", home) is None


def test_a_backslash_spelling_of_a_trusted_subdirectory_is_not_read_only(home):
    # shlex strips the unquoted backslashes, so bash reads C:Usersdanielserverdocs.
    path = str(home / "server" / "docs")
    assert ro(f"cd {path} && git status", home) is None
    assert ro(f"git -C {path} status", home) is None


def test_a_dotdot_after_a_junction_does_not_make_a_git_stage_read_only(home):
    # realpath collapses junc/.. to server as text; `cd -P` follows junc first and climbs
    # out of its target, so git would run outside the trusted repo.
    (home / "outside" / "deep").mkdir(parents=True)
    link = home / "server" / "junc"
    made = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(home / "outside" / "deep")],
        capture_output=True,
        check=False,
    )
    if made.returncode != 0:
        pytest.skip("cannot create a junction here")
    assert ro("cd -P junc/.. && git status", home) is None
    assert ro("git -C junc/.. status", home) is None
    assert ro("cd -P junc && git status", home) is None  # the target is outside home's repo
    assert ro("cd docs && git status", home) is not None


# --- Cygwin/MSYS symlinks: stored as `name.lnk`, followed by bash as `name` -------------------


def test_a_path_through_a_cygwin_lnk_symlink_is_refused(cwd):
    (Path(cwd) / "esclnk.lnk").write_text("x")
    assert not _under_session_cwd("esclnk/pwn.txt", cwd)
    assert not _under_session_cwd(f"{Path(cwd).as_posix()}/esclnk/pwn.txt", cwd)
    assert not judge(HEREDOC.format(target="esclnk/pwn.txt"), _rules(), (), cwd).allow
    assert _under_session_cwd("plain/pwn.txt", cwd)


def test_a_cd_through_a_cygwin_lnk_symlink_does_not_make_a_git_stage_read_only(home):
    (home / "server" / "esclnk.lnk").write_text("x")
    assert ro("cd docs && git status", home) is not None
    assert ro("cd esclnk && git status", home) is None
    assert ro("git -C esclnk status", home) is None


def test_a_target_outside_the_home_is_not_resolved_on_windows(home):
    assert _resolve("..", str(home / "server"), str(home)) == os.path.realpath(home)
    assert _resolve("../..", str(home / "server"), str(home)) is None


def test_the_read_only_agent_scratch_arm_fails_closed_on_windows():
    from claude_guard.checks.read_only_agents import _scratch

    # Git Bash's /tmp is %TEMP%, while Python's realpath("/tmp") is C:/tmp, another directory.
    assert _scratch("/tmp/x", ("/tmp",)) is False
