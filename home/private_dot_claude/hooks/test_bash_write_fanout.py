#!/usr/bin/env python3
# python-suites: skip -- check()-style runner, no `OK N` count line; wiring it is #545
"""Standalone tests for bash-write-fanout.sh.

Run: python3 test_bash_write_fanout.py

The hook's job is to notice which files a Bash command wrote, so that the four
PostToolUse `Edit|Write` hooks run for a heredoc or a `sed -i` the same way they run for
a Write tool call. Extraction is therefore what these tests pin, via the hook's dry-run
seam: running the whole hook and reading its stdout cannot distinguish a correct
extraction from an empty one, because the downstream hooks stay silent on most inputs.

Both directions matter and the quiet one matters more. A missed write is the bug the
hook exists to fix; a spurious one runs a formatter and a linter over a file nobody
touched, at the end of a command that was only ever a read. `2>/dev/null` appears in a
large share of this config's read commands, so it gets its own case.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK = HERE / "executable_bash-write-fanout.sh"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "bash-write-fanout.sh"

failures = []


def check(name, condition):
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def extracted(command, cwd, env_extra=None):
    """The paths the hook would fan out for `command`, as basenames, sorted."""
    env = {
        **os.environ,
        "CLAUDE_BASH_WRITE_FANOUT_DRYRUN": "1",
        **(env_extra or {}),
    }
    result = subprocess.run(
        ["bash", str(HOOK)],
        cwd=cwd,
        input=json.dumps(
            {"session_id": "test", "cwd": str(cwd), "tool_input": {"command": command}}
        ),
        capture_output=True,
        text=True,
        env=env,
    )
    return sorted(Path(p).name for p in result.stdout.split())


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    for name in ("a.txt", "b.txt", "s.sh"):
        (root / name).write_text("x\n")
    (root / "sub").mkdir()
    (root / "sub" / "c.txt").write_text("x\n")

    # ── writes that must be caught ───────────────────────────────────────────────────

    check(
        "heredoc redirect",
        extracted("cat > a.txt <<'EOF'\nbody\nEOF", root) == ["a.txt"],
    )
    check("append redirect", extracted("printf x >> b.txt", root) == ["b.txt"])
    check("redirect with no space", extracted("echo z >a.txt", root) == ["a.txt"])
    check("quoted target", extracted('cat s.sh > "b.txt"', root) == ["b.txt"])
    check("sed in place", extracted("sed -i 's/x/y/' b.txt", root) == ["b.txt"])
    check(
        "sed in place with a suffix",
        extracted("sed -i.bak 's/x/y/' b.txt", root) == ["b.txt"],
    )
    check(
        "tee writes every non-flag argument",
        extracted("echo hi | tee a.txt b.txt", root) == ["a.txt", "b.txt"],
    )
    check("tee -a", extracted("echo hi | tee -a a.txt", root) == ["a.txt"])
    check(
        "dd of=", extracted("dd if=/dev/zero of=a.txt bs=1 count=1", root) == ["a.txt"]
    )
    check("relative subdirectory", extracted("echo x > sub/c.txt", root) == ["c.txt"])
    check(
        "absolute path",
        extracted(f"echo x > {root / 'a.txt'}", root) == ["a.txt"],
    )
    check(
        "a later segment's write is found",
        extracted("grep x a.txt && echo done > b.txt", root) == ["b.txt"],
    )

    # ── reads that must stay quiet ───────────────────────────────────────────────────

    check(
        "2>/dev/null is not a write",
        extracted("grep foo a.txt 2>/dev/null | head -5", root) == [],
    )
    check(
        "redirect to /dev/null",
        extracted("ls -la > /dev/null 2>&1", root) == [],
    )
    check("sed without -i", extracted("sed -n '1,5p' a.txt", root) == [])
    check("plain read", extracted("cat a.txt", root) == [])
    check(
        "the sed script is not mistaken for a file",
        extracted("sed -i 's/a.txt/b/' b.txt", root) == ["b.txt"],
    )
    check(
        "a target that was never created",
        extracted("false > nonexistent.txt", root) == [],
    )
    check(
        "an unexpanded variable is not guessed at",
        extracted('echo x > "$OUT"', root) == [],
    )
    check(
        "fd duplication is not a file",
        extracted("make 2>&1 | grep -c error", root) == [],
    )

    # ── heredoc bodies are content, not shell ────────────────────────────────────────
    #
    # The payload carries the whole file for a heredoc write, and file content is full
    # of characters that mean something to a shell parser. A Markdown blockquote is a
    # bare `>`, so without stripping the body first the hook reads a redirect out of the
    # prose and hands an untouched file to auto-format and chezmoi-guard — a silent
    # wrong write, which is the failure the whole hook exists to prevent.

    check(
        "a blockquote in the body is not a redirect",
        extracted("cat > a.txt <<'EOF'\n> b.txt is the index\nEOF", root) == ["a.txt"],
    )
    check(
        "a shell command quoted in the body is not run",
        extracted(
            "cat > a.txt <<'EOF'\nRun `sed -i s/x/y/ b.txt` to fix it.\nEOF", root
        )
        == ["a.txt"],
    )
    check(
        "an unquoted delimiter is handled",
        extracted("cat > a.txt <<EOF\n> b.txt\nEOF", root) == ["a.txt"],
    )
    check(
        "a tab-indented terminator is handled",
        extracted("cat > a.txt <<-EOF\n> b.txt\n\tEOF\necho done", root) == ["a.txt"],
    )
    check(
        "a write after the heredoc is still found",
        extracted("cat > a.txt <<'EOF'\n> nope\nEOF\necho x > b.txt", root)
        == ["a.txt", "b.txt"],
    )

    # ── the escape hatch ─────────────────────────────────────────────────────────────

    check(
        "CLAUDE_BASH_WRITE_FANOUT=0 disables it",
        extracted("echo x > a.txt", root, {"CLAUDE_BASH_WRITE_FANOUT": "0"}) == [],
    )

    # ── the bulk-write cap ───────────────────────────────────────────────────────────

    many = root / "many"
    many.mkdir()
    for i in range(12):
        (many / f"f{i}").write_text("x\n")
    cmd = " ".join(f"many/f{i}" for i in range(12))
    check(
        "a bulk write is capped at 8",
        len(extracted(f"echo hi | tee {cmd}", root)) == 8,
    )

print()
if failures:
    print(f"{len(failures)} failure(s): {', '.join(failures)}")
    sys.exit(1)
print("all passed")
