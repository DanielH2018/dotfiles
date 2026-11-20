import os

import pytest

from claude_guard.protected_paths import writes_protected_path


@pytest.fixture
def home(tmp_path):
    home = tmp_path / "home"
    (home / ".claude" / "hooks").mkdir(parents=True)
    (home / ".local" / "bin").mkdir(parents=True)
    (home / "repo").mkdir()
    return str(home)


def test_a_write_through_a_link_on_disk_is_compared_at_its_target(home, tmp_path):
    link = tmp_path / "elsewhere"
    os.symlink(f"{home}/.claude/hooks", link)
    assert writes_protected_path(f"cp /tmp/x {link}/read-nudge.sh", f"{home}/repo", home)
    assert not writes_protected_path(f"cp /tmp/x {tmp_path}/other.sh", f"{home}/repo", home)


def test_a_protected_directory_that_is_a_link_is_protected_where_it_points(home, tmp_path):
    real = tmp_path / "real-bin"
    real.mkdir()
    os.rmdir(f"{home}/.local/bin")
    os.symlink(real, f"{home}/.local/bin")
    assert writes_protected_path(f"cp /tmp/x {real}/envq", f"{home}/repo", home)


@pytest.mark.parametrize(
    ("command", "cwd", "refused"),
    [
        ("cp /tmp/x .local/bin/envq", "", False),
        ("cp /tmp/x .local/bin/envq", "{home}", True),
        ("cp /tmp/x ../.local/bin/envq", "{home}/repo", True),
        ("cp /tmp/x .claude/hooks/tests/test_t.py", "{home}/repo", False),
        ("cp /tmp/x envq", "{home}/.local/bin", True),
        ("cd /tmp && cp /tmp/x envq", "{home}/.local/bin", False),
        ("ls -la", "{home}/.local/bin", False),
    ],
)
def test_a_relative_word_is_read_from_the_working_directory(home, command, cwd, refused):
    assert writes_protected_path(command, cwd.format(home=home), home) is refused


@pytest.mark.parametrize(
    "command",
    [
        "~/.local/bin/ghread pr view 1",
        "bash ~/.claude/hooks/session-context.sh",
        "python3 ~/.claude/hooks/prune-worktrees.py --check --all",
        "bin/deployed abc123 ~/.claude/settings.json",
        "chezmoi apply ~/.claude/settings.json",
        "ssh daniel-server 'cd ~/.local/share/chezmoi && chezmoi apply ~/.local/bin/ghread'",
        "source ~/.local/bin/env",
        'export PATH="$HOME/.local/bin:$PATH"',
        "test -x ~/.local/bin/uv && echo present",
        'ls ~/.local/bin | while read f; do echo "$f"; done',
        "git commit -m 'Refuse a cp onto ~/.local/bin/envq'",
        "tar -czf /tmp/backup.tgz ~/.claude",
        "cp notes.md ~/",
        "rsync -a ~/.claude/ /tmp/backup/",
        "cat > /tmp/notes.md <<'EOF'\ncp /tmp/x ~/.local/bin/envq is refused\nEOF\nruff format .",
        "~/.local/bin/uv run pytest -q; node --test tests/x.test.js",
        "uv run --python ~/.local/bin/python3.15 pytest -q",
        "python3 -c \"print(open('/tmp/notes.md').read())\" ~/notes.md",
        "python3 -m json.tool ~/.claude/settings.json",
        "python3 -c \"import os; os.environ['PATH'] = os.path.expanduser('~/.local/bin')\"",
        'c=$(ls ~/.local/bin/chezmoi); ln -sfn "$c" /tmp/chezmoi',
        "sed -n 's|~/.local/bin/||p' docs/tools.md",
    ],
)
def test_a_command_that_cannot_write_the_path_it_names_passes(home, command):
    assert not writes_protected_path(command, f"{home}/repo", home)
