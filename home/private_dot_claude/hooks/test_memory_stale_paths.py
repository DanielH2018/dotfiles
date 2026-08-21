#!/usr/bin/env python3
"""Standalone tests for memory-stale-paths.py.

Run: python3 test_memory_stale_paths.py

The hook reports memories naming repo paths that are gone. What needs pinning is the
false-positive rate, not the detection: this prints at every session start, and a report
that names a memory wrongly even once teaches the reader to skip the whole line.
Memories are full of slashed tokens that are not paths — `refs/heads/main`,
`kube-system/coredns`, `get list watch` — and every one of them must stay out.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Importing the hook below would otherwise write a __pycache__ into the chezmoi source
# tree, which config-soak walks by filesystem and would then track as config.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "executable_memory-stale-paths.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "memory-stale-paths.py"

spec = importlib.util.spec_from_file_location("memory_stale_paths", SCRIPT)
mod = importlib.util.module_from_spec(spec)
sys.modules["memory_stale_paths"] = mod
spec.loader.exec_module(mod)

# See test_prune_worktrees.py: GIT_DIR outranks cwd, and git exports it to every hook.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]

failures = []


def check(name, condition):
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    repo = root / "repo"
    (repo / "ansible" / "roles").mkdir(parents=True)
    (repo / "docs").mkdir()
    (repo / "ansible" / "roles" / "live.yml").write_text("x\n")
    (repo / "docs" / "kept.md").write_text("x\n")

    def stale(text):
        return mod.stale_paths(text, repo)

    # ── it finds what it should ──────────────────────────────────────────────────────

    check(
        "a deleted file is reported",
        stale("The check lives in `ansible/roles/gone.yml`.")
        == ["ansible/roles/gone.yml"],
    )
    check(
        "a file that still exists is not reported",
        stale("The check lives in `ansible/roles/live.yml`.") == [],
    )
    check(
        "two stale paths in one memory",
        stale("`docs/a.md` and `docs/b.md`") == ["docs/a.md", "docs/b.md"],
    )
    check(
        "trailing sentence punctuation is stripped",
        stale("See `docs/gone.md`.") == ["docs/gone.md"],
    )

    # ── it stays quiet on everything that is not a repo path ─────────────────────────

    check("a git ref is not a path", stale("`refs/heads/main` is the default") == [])
    check(
        "a kubernetes namespaced name is not a path",
        stale("restart `kube-system/coredns`") == [],
    )
    check("an unquoted path is ignored", stale("see ansible/roles/gone.yml") == [])
    check("a URL is ignored", stale("`https://example.com/a/b`") == [])
    check(
        "a relative path is ignored",
        stale("clone into `./repos` first") == [],
    )
    check(
        "a parent-relative path is ignored",
        stale("written to `../out/thing.txt`") == [],
    )
    check(
        "a path whose whole directory is gone is not reported",
        stale("`retired/thing.yml` was the old home") == [],
    )
    check("prose with a slash is ignored", stale("either `and/or` works") == [])

    # ── end to end ───────────────────────────────────────────────────────────────────

    subprocess.run(
        ["git", "init", "-q", "-b", "main", "."], cwd=repo, capture_output=True
    )
    memories = root / "cfg" / "projects" / str(repo).replace("/", "-") / "memory"
    memories.mkdir(parents=True)
    (memories / "MEMORY.md").write_text("- [x](x.md) — `docs/index-only.md`\n")
    (memories / "fine.md").write_text("Nothing here but `docs/kept.md`.\n")
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(root / "cfg")}

    quiet = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env
    )
    check("silent when every path resolves", quiet.stdout == "")
    check("exits 0 when silent", quiet.returncode == 0)

    (memories / "drifted.md").write_text("The gate is `ansible/roles/gone.yml`.\n")
    loud = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env
    )
    check("names the drifted memory", "drifted.md" in loud.stdout)
    check("names the missing path", "ansible/roles/gone.yml" in loud.stdout)
    check("does not name the healthy memory", "fine.md" not in loud.stdout)
    # The index links memories rather than describing code, so a stale path in a link
    # hook is the linked memory's problem, reported there.
    check("skips the index", "MEMORY.md" not in loud.stdout)
    check("exits 0 when it reports", loud.returncode == 0)

    off = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=repo,
        capture_output=True,
        text=True,
        env={**env, "CLAUDE_MEMORY_PATH_CHECK": "0"},
    )
    check("the opt-out silences it", off.stdout == "")

    outside = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=tmp, capture_output=True, text=True, env=env
    )
    check(
        "outside a repo it is a silent no-op",
        outside.returncode == 0 and outside.stdout == "",
    )

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all passed")
