#!/usr/bin/env python3
"""Standalone tests for memory-index-size.py.

Run: python3 test_memory_index_size.py

The hook warns when MEMORY.md has too many pointer lines. What needs pinning is the
counting rule and the silence: this prints at every session start, so it must count
only real entries (a heading or a prose bullet is not an entry) and must say nothing at
all below the cap, outside a repo, or when the index is missing.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from _testkit import check, finish

# Importing the hook below would otherwise write a __pycache__ into the chezmoi source
# tree, which config-soak walks by filesystem and would then track as config.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "executable_memory-index-size.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "memory-index-size.py"

spec = importlib.util.spec_from_file_location("memory_index_size", SCRIPT)
mod = importlib.util.module_from_spec(spec)
sys.modules["memory_index_size"] = mod
spec.loader.exec_module(mod)

# See test_prune_worktrees.py: GIT_DIR outranks cwd, and git exports it to every hook.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]

# ── the counting rule ────────────────────────────────────────────────────────────────

check("a pointer line counts", mod.count_pointers("- [a](a.md) — thing\n") == 1)
check(
    "several pointer lines count",
    mod.count_pointers("- [a](a.md)\n- [b](b.md)\n- [c](c.md)\n") == 3,
)
check("a heading is not an entry", mod.count_pointers("# Memory index\n") == 0)
check("a plain bullet is not an entry", mod.count_pointers("- not a link\n") == 0)
check("an indented pointer is not an entry", mod.count_pointers("  - [a](a.md)\n") == 0)
check(
    "blank lines and prose are not entries", mod.count_pointers("\nsome prose\n") == 0
)
check("an empty index counts zero", mod.count_pointers("") == 0)


# ── end to end ───────────────────────────────────────────────────────────────────────

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    repo = root / "repo"
    repo.mkdir()
    subprocess.run(
        ["git", "init", "-q"], cwd=repo, check=True, capture_output=True, text=True
    )
    # git resolves symlinks in the toplevel it prints (/tmp is a symlink on macOS), so
    # derive the slug from the same value the hook will see, not from `repo`.
    toplevel = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    config_dir = root / "config"
    memory = config_dir / "projects" / toplevel.replace("/", "-") / "memory"
    memory.mkdir(parents=True)
    index = memory / "MEMORY.md"

    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(config_dir)}

    def run(cwd, extra_env=None, args=()):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            env={**env, **(extra_env or {})},
        )

    def write_index(entries):
        index.write_text(
            "# Memory\n\n" + "".join(f"- [m{i}](m{i}.md)\n" for i in range(entries))
        )

    write_index(85)
    at_cap = run(repo)
    check("at the cap it is silent", at_cap.stdout == "")
    check("at the cap it exits 0", at_cap.returncode == 0)

    write_index(92)
    over = run(repo)
    check("over the cap it reports", over.stdout != "")
    check("names the current count", "92" in over.stdout)
    check("names the cap", "85" in over.stdout)
    check("says what to do instead of appending", "append" in over.stdout.lower())
    check("exits 0 when it reports", over.returncode == 0)

    check("--max moves the cap", run(repo, args=("--max", "200")).stdout == "")
    check(
        "the opt-out silences it",
        run(repo, {"CLAUDE_MEMORY_INDEX_CHECK": "0"}).stdout == "",
    )

    outside = run(tmp)
    check(
        "outside a repo it is a silent no-op",
        outside.returncode == 0 and outside.stdout == "",
    )

    # ── the worktree case, which is the one this hook exists to cover ────────────────
    # Memory is keyed to the main checkout, so a session in .claude/worktrees/<name>
    # must resolve back to it. Without that, the hook is silent in exactly the sessions
    # this repo spends most of its time in.
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@e",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "seed",
        ],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    wt = repo / ".claude" / "worktrees" / "wt"
    subprocess.run(
        ["git", "worktree", "add", "-q", "-b", "wt", str(wt)],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    from_wt = run(wt)
    check("a worktree resolves to the main checkout's index", "92" in from_wt.stdout)
    check("the worktree run exits 0", from_wt.returncode == 0)

    write_index(85)
    check("a worktree is silent under the cap", run(wt).stdout == "")
    write_index(92)

    index.unlink()
    missing = run(repo)
    check(
        "no index is a silent no-op",
        missing.returncode == 0 and missing.stdout == "",
    )

finish()
