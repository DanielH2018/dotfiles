#!/usr/bin/env python3
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
import tempfile
from pathlib import Path

from _testkit import check, finish

HERE = Path(__file__).resolve().parent
HOOK = HERE / "executable_bash-write-fanout.sh"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "bash-write-fanout.sh"

# The claude_guard package the hook strips heredocs with, from the CHECKOUT rather than
# from whatever this machine has deployed. CI never runs `chezmoi apply`, so the
# deployed path does not exist there and the hook would take its regex fallback --
# the parser assertions below would then measure the thing they exist to replace.
GUARD_SRC = HERE.parents[1] / "dot_local" / "share" / "claude-guard"
if not GUARD_SRC.is_dir():  # deployed copy: the source tree is not beside the hook
    GUARD_SRC = Path(os.environ.get("CLAUDE_GUARD_HOME", "")) or GUARD_SRC


def _have_parser():
    """Whether the hook's parsed path can actually run here.

    It needs the package AND the uv-MANAGED 3.14 the claude-guard shims resolve,
    which is not the interpreter actions/setup-python provides. Where it cannot run
    the hook falls back by design, so the two checks below state the fallback's
    answer instead of being skipped: this suite's `OK N` line is asserted against
    its check() call sites, and a skipped check would read as a block that was
    never reached.
    """
    if not (GUARD_SRC / "claude_guard" / "segment.py").is_file():
        return False
    try:
        found = subprocess.run(
            [
                "uv",
                "python",
                "find",
                "--no-project",
                "--managed-python",
                "--system",
                "3.14",
            ],
            capture_output=True,
            text=True,
        )
    except OSError:
        return False
    return found.returncode == 0 and Path(found.stdout.strip() or "/dev/null").exists()


HAVE_PARSER = _have_parser()


def extracted(command, cwd, env_extra=None):
    """The paths the hook would fan out for `command`, as basenames, sorted."""
    env = {
        **os.environ,
        "CLAUDE_BASH_WRITE_FANOUT_DRYRUN": "1",
        # Ahead of env_extra, so the no-package case can still point it elsewhere.
        "CLAUDE_GUARD_HOME": str(GUARD_SRC),
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

    # A delimiter the line-at-a-time regex cannot see. It requires `[A-Za-z_]` as the
    # first character, so `<<'.END'` was not read as a heredoc at all and the blockquote
    # in the body was tokenized as a redirect: the hook fanned out b.txt, which the
    # command never wrote. claude_guard.segment reads the delimiter the way bash does.
    # Where the parsed path cannot run at all, the fallback's answer is what to expect:
    # b.txt fanned out too. Stating it rather than skipping keeps the `OK N` count
    # honest, which python-suites.test.js asserts against the check() call sites.
    check(
        "a delimiter the regex cannot read is still a heredoc",
        extracted("cat > a.txt <<'.END'\n> b.txt is the index\n.END", root)
        == (["a.txt"] if HAVE_PARSER else ["a.txt", "b.txt"]),
    )
    # ── what happens when the parser cannot answer ───────────────────────────────────
    #
    # The parser is an improvement, never a dependency. With no claude_guard package the
    # hook takes the regex, which is what it did before -- worse on the delimiter above,
    # correct on the ordinary shapes. A command the parser REFUSES to read is different:
    # its writes cannot be located, so nothing is fanned out. A missed fanout costs a
    # formatter run; a wrong one rewrites a file the command never touched.

    noguard = str(root / "no-such-claude-guard")
    check(
        "with no claude_guard package the ordinary heredoc still works",
        extracted(
            "cat > a.txt <<'EOF'\n> b.txt\nEOF", root, {"CLAUDE_GUARD_HOME": noguard}
        )
        == ["a.txt"],
    )
    check(
        "an unreadable command fans out nothing",
        extracted("cat > a.txt <<'EOF'\nbody\nEOF\necho \"unbalanced > b.txt", root)
        == ([] if HAVE_PARSER else ["a.txt"]),
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

    # ── the fan-out itself needs no tempfile (#581) ─────────────────────────────────
    #
    # `OUTPUTS=$(mktemp) || exit 0` skipped every downstream hook when no tempfile could
    # be made. The hook is copied beside a stub lint-after-edit.sh that always blocks,
    # then run for real with TMPDIR pointing nowhere: the block must still come out. The
    # accepting half is the same run with a working TMPDIR.
    #
    # The stub pretty-prints across lines, as lint-after-edit.sh's `jq -n` does.
    # The merge splits on newlines, and before the fan-out compacted each hook's output
    # every fragment failed to parse: the block arrived as plain context, not a block.
    hookdir = root / "hookdir"
    hookdir.mkdir()
    (hookdir / "bash-write-fanout.sh").write_text(HOOK.read_text())
    (hookdir / "hook-input.sh").write_text((HOOK.parent / "hook-input.sh").read_text())
    stub = hookdir / "lint-after-edit.sh"
    stub.write_text(
        "#!/bin/bash\ncat >/dev/null\n"
        'printf \'{\\n  "decision": "block",\\n  "reason": "stub-lint"\\n}\\n\'\n'
    )
    stub.chmod(0o755)

    def fanned(tmpdir):
        result = subprocess.run(
            ["bash", str(hookdir / "bash-write-fanout.sh")],
            cwd=root,
            input=json.dumps(
                {
                    "session_id": "test",
                    "cwd": str(root),
                    "tool_input": {"command": "echo x > a.txt"},
                }
            ),
            capture_output=True,
            text=True,
            env={**os.environ, "CLAUDE_GUARD_HOME": str(GUARD_SRC), "TMPDIR": tmpdir},
        )
        try:
            return json.loads(result.stdout)
        except ValueError:
            return {}

    check(
        "the fan-out reports a downstream block",
        fanned(tmp).get("reason") == "stub-lint",
    )
    check(
        "and still does with no writable TMPDIR",
        fanned(str(root / "no-such-tmpdir")).get("reason") == "stub-lint",
    )

finish()
