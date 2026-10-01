"""claude_guard.checks.worktree_escape: each rule as an _is_flagged / _is_clean pair.

Ported with server#2818 from the server repo's `block-protected-bash.py` arm 3 suite, every
case kept. The cases run through `cli pre-tool-use`, the entry the PreToolUse shim calls: a
test of `verdict()` alone would stay green if the hook stopped calling it.

The checkouts are built under tmp_path rather than read off this host's layout, so the cases
mean the same thing in CI, where nothing is under `.claude/worktrees/`, as on a host.
"""

import contextlib
import io
import json
import sys

import pytest

from claude_guard import cli, hook
from claude_guard.checks import worktree_escape

HEREDOC = "python3 - <<'EOF'\nopen('x','w').write('y')\nEOF"


def run_hook(command: str, cwd: str) -> dict | None:
    old_stdin = sys.stdin
    sys.stdin = io.StringIO(json.dumps({"tool_input": {"command": command}, "cwd": cwd}))
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            assert cli.main(["pre-tool-use"]) == 0
    finally:
        sys.stdin = old_stdin
    return json.loads(out.getvalue())["hookSpecificOutput"] if out.getvalue().strip() else None


def decision(command: str, cwd: str) -> str | None:
    """The hook's decision, counting only this check's: a readonly allow is no decision here."""
    d = run_hook(command, cwd)
    if not d or d.get("permissionDecision") == "allow":
        return None
    return d["permissionDecision"]


@pytest.fixture
def checkouts(tmp_path):
    """A primary checkout with a worktree under it, both real git checkouts on disk.

    Returns (worktree, primary). `primary/.git` is a directory and `worktree/.git` a file, the
    two shapes git itself uses, so the `.git` walk is exercised on both.
    """
    primary = tmp_path / "server"
    (primary / ".git").mkdir(parents=True)
    worktree = primary / ".claude" / "worktrees" / "agent-1"
    worktree.mkdir(parents=True)
    (worktree / ".git").write_text(f"gitdir: {primary}/.git/worktrees/agent-1\n")
    return str(worktree), str(primary)


def test_a_heredoc_carried_out_of_the_worktree_by_a_cd_is_flagged(checkouts):
    """The measured 2026-09-06 escape: the `cd` is the whole difference, and nothing saw it."""
    worktree, primary = checkouts
    d = run_hook(f"cd {primary} && {HEREDOC}", worktree)
    assert d and d["permissionDecision"] == "deny"
    assert "heredoc" in d["permissionDecisionReason"]


def test_the_same_heredoc_with_no_cd_is_clean(checkouts):
    worktree, _ = checkouts
    assert decision(HEREDOC, worktree) is None


def test_a_heredoc_after_a_cd_into_the_sessions_own_worktree_is_clean(checkouts):
    worktree, _ = checkouts
    assert decision(f"cd {worktree}/scripts && {HEREDOC}", worktree) is None


# The writer set server#1419 names: heredoc redirect, `sed -i`, `tee`, `>`, `>>`.
ESCAPING_WRITES = [
    "cd {primary} && cat > notes.md <<'EOF'\nhi\nEOF",
    "cd {primary} && sed -i s/a/b/ README.md",
    "echo x | tee {primary}/README.md",
    "echo x > {primary}/README.md",
    "echo x >> {primary}/README.md",
]

# Near misses, each one token from a case above. A `cd` outside is not itself a write, and a
# writer under a `cd` outside that names a scratch target is judged on the target.
CONTAINED_WRITES = [
    "echo x > README.md",
    "echo x > {worktree}/README.md",
    "sed -i s/a/b/ {worktree}/README.md",
    "cd {primary} && grep -rn token .",
    "cd {primary} && cat README.md > /tmp/copy.txt",
    "cd {primary}",
]


@pytest.mark.parametrize("template", ESCAPING_WRITES)
def test_a_write_escaping_the_worktree_is_flagged(checkouts, template):
    worktree, primary = checkouts
    command = template.format(primary=primary, worktree=worktree)
    assert decision(command, worktree) == "deny", f"should deny: {command}"


@pytest.mark.parametrize("template", CONTAINED_WRITES)
def test_a_write_that_stays_inside_the_worktree_is_clean(checkouts, template):
    worktree, primary = checkouts
    command = template.format(primary=primary, worktree=worktree)
    assert decision(command, worktree) is None, f"should not act on: {command}"


def test_the_check_is_inert_outside_an_isolated_session(checkouts):
    """The same escaping command from a session that is not worktree-isolated. Without this
    the check would deny every ordinary session's writes to its own checkout."""
    _, primary = checkouts
    assert decision(f"cd {primary} && {HEREDOC}", primary) is None


def test_the_check_is_inert_on_a_payload_with_no_cwd(checkouts):
    """`read_cwd` returns "" for a payload without `cwd`, which must read as "not isolated",
    never as the hook process's own directory."""
    _, primary = checkouts
    assert worktree_escape.verdict(f"cd {primary} && {HEREDOC}", "") is None


def test_the_interpreter_set_contains_the_incidents_own_command_word():
    """Non-vacuity. The set is the only thing standing between a target-less heredoc and a
    silent escape; a rename emptying it would leave every pair above green."""
    for word in ("python3", "bash", "uv"):
        assert word in worktree_escape.HEREDOC_INTERPRETERS


def test_a_redirect_inside_a_heredoc_body_is_clean(checkouts):
    """A Markdown blockquote inside a heredoc body is a bare `>`, not a redirect. The segmenter
    lifts the body off the segment text; without that this reads as writing `{primary}/quote`."""
    worktree, primary = checkouts
    assert decision(f"cat > notes.md <<'EOF'\n> {primary}/quote\nEOF", worktree) is None


def test_the_same_redirect_on_the_heredocs_opening_line_is_flagged(checkouts):
    """The near miss: the opening line is not body, so its `>` is a real target."""
    worktree, primary = checkouts
    assert decision(f"cat > {primary}/notes.md <<'EOF'\n> quote\nEOF", worktree) == "deny"


def test_a_cd_inside_quotes_does_not_move_the_carry(checkouts):
    """`echo 'x; cd {primary}'` is one word to the shell, so the `cd` never runs and the heredoc
    after `&&` runs in the worktree. The first case in this file is the other half: the same
    `cd`, unquoted, is denied."""
    worktree, primary = checkouts
    assert decision(f"echo 'x; cd {primary}' && {HEREDOC}", worktree) is None


def test_an_unreadable_command_asks_rather_than_denies(checkouts):
    """A non-ok parse is a refusal, never a skip, but the weaker refusal: an unbalanced quote is
    a typo, not evidence of an escape."""
    worktree, primary = checkouts
    reason = worktree_escape.verdict(f"echo 'oops > {primary}/README.md", worktree)
    assert reason and reason[0] == "ask"
    assert "unbalanced-quote" in reason[1]


def test_an_apostrophe_inside_a_heredoc_body_is_clean(checkouts):
    """The near miss for the ask above, and the most common command shape: a heredoc body is
    lifted whole, so a quote inside it is prose, not an unbalanced quote."""
    worktree, _ = checkouts
    assert decision("python3 - <<'PYEOF'\nprint(\"don't\")\nPYEOF", worktree) is None


def test_an_unreadable_command_with_no_writer_is_clean(checkouts):
    """The check only acts on a redirect, an in-place editor, `tee` or a heredoc, so text
    carrying none of those cannot be an escape however badly it parses."""
    worktree, _ = checkouts
    assert worktree_escape.verdict("echo 'oops", worktree) is None


def test_an_exception_in_the_check_fails_closed_to_ask(checkouts, monkeypatch):
    """It is a deny rule, so it shares the deny side's fail-closed try: a crash is an ask,
    never a silent allow of the write it exists to stop."""
    worktree, primary = checkouts

    def boom(command, cwd):
        raise RuntimeError("boom")

    monkeypatch.setattr(worktree_escape, "verdict", boom)
    stdin = json.dumps({"tool_input": {"command": f"cd {primary} && {HEREDOC}"}, "cwd": worktree})
    assert hook.pre_tool_use(stdin, {}) == hook.ASK_JSON
