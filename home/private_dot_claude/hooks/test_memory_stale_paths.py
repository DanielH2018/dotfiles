#!/usr/bin/env python3
# python-suites: skip -- red on main (#544); check()-style runner, no `OK N` line (#545)
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

    # ── a memory that names a path BECAUSE it is gone ────────────────────────────────
    #
    # The dominant false positive on the first real run: three of the four memories
    # reported were describing an absence, not asserting a presence, and each was
    # correct as written. Re-reporting those is how a session-start line trains its
    # reader to skip it. The marker has to be found in prose that wraps mid-sentence, so
    # the check reads a character window rather than a line.

    check(
        "a path the memory says no longer exists",
        stale("guarded by `ansible/roles/gone.yml`, which no longer exists") == [],
    )
    check(
        "a path the memory says was deleted",
        stale("`ansible/roles/gone.yml` was deleted in commit abc1234") == [],
    )
    check(
        "the marker may follow the path across a line break",
        stale(
            "`AUTOMATIONS_YAML` still pointed at\n`ansible/roles/gone.yml`. That\n"
            "directory has no `files/` and no archive copy, so it raised."
        )
        == [],
    )
    check(
        "a live claim is still reported when the marker is far away",
        stale(
            "The gate is `ansible/roles/gone.yml`.\n\n"
            + ("filler. " * 40)
            + "\nSomething unrelated was removed last week."
        )
        == ["ansible/roles/gone.yml"],
    )
    check(
        "one live mention outweighs another that is marked gone",
        stale(
            "`ansible/roles/gone.yml` no longer exists.\n\n"
            + ("filler. " * 40)
            + "\nRun the check in `ansible/roles/gone.yml` before deploying."
        )
        == ["ansible/roles/gone.yml"],
    )

    # A path whose own filename contains a marker word must not suppress itself. This is
    # the failure mode with teeth: it silences exactly the files most likely to have
    # been deleted, and it does so silently. `ansible/roles/gone.yml` above is the same
    # guard from the other direction — it is reported only because the needle is cut out
    # of its own window.
    check(
        "a filename containing a marker word does not silence itself",
        stale("The list is in `docs/retired-hosts.md`, read it first.")
        == ["docs/retired-hosts.md"],
    )

    # ── the [ENFORCED]/(SCOPED) index pass ───────────────────────────────────────────
    #
    # A marked entry points at a check. The pointer outlives the check when the test is
    # renamed or moved, and a file that still exists says nothing about a symbol inside
    # it — which is why node ids are resolved to a definition, not just to a file.

    (repo / "docs" / "test_x.py").write_text("def test_live():\n    pass\n")

    def checks(text):
        return mod.stale_checks(text, repo)

    check(
        "a node id whose file is gone is missing",
        checks("ENFORCED by `docs/test_gone.py::test_live`.")
        == (["docs/test_gone.py::test_live"], []),
    )
    check(
        "a node id whose file defines the test resolves",
        checks("ENFORCED by `docs/test_x.py::test_live`.")
        == ([], ["docs/test_x.py::test_live"]),
    )
    check(
        "a node id whose test was renamed is missing",
        checks("ENFORCED by `docs/test_x.py::test_old`.")
        == (["docs/test_x.py::test_old"], []),
    )
    check(
        "a bare `::name` resolves against the file named before it",
        checks("ENFORCED, paired in `docs/test_x.py::test_live` (with `::test_old`).")[
            0
        ]
        == ["docs/test_x.py::test_old"],
    )
    check(
        "a `symbol` in `file` pair resolves to a definition",
        checks("ENFORCED by `test_live` in `docs/test_x.py`.")
        == ([], ["docs/test_x.py::test_live"]),
    )
    check(
        "a path outside the marked sentence is not a check",
        checks("ENFORCED by `docs/test_x.py`. See also `docs/other.md`.")
        == ([], ["docs/test_x.py"]),
    )
    check(
        "a path whose top directory is not in the repo is skipped, not missing",
        checks("ENFORCED by an assert in `pre_tasks/load_secrets.yml`.") == ([], []),
    )

    index = (
        "- [a](a.md) [ENFORCED] · [b](b.md) [ENFORCED, SCOPED] · [c](c.md) (SCOPED)\n"
        "- [A task tagged [config, deploy] is skipped](d.md) — text. [ENFORCED]\n"
        "- [e](e.md) — no marker here.\n"
    )
    check(
        "markers bind per link, nested-bracket labels included",
        mod.index_entries(index)
        == [("a.md", False), ("b.md", True), ("c.md", True), ("d.md", False)],
    )

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

    # ── the worktree case ────────────────────────────────────────────────────────────
    # Memory is keyed to the main checkout, so a session in .claude/worktrees/<name>
    # has to resolve back to it or this hook is silent in most of the repo's sessions.
    # But only the SLUG resolves back: path existence stays against the worktree, or a
    # file added on a branch reads as stale.
    git = [
        "git",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@e",
        "-c",
        "commit.gpgsign=false",
    ]
    (repo / "docs").mkdir(exist_ok=True)
    (repo / "docs" / "kept.md").write_text("x\n")
    subprocess.run(
        [*git, "add", "-A"], cwd=repo, check=True, capture_output=True, text=True
    )
    subprocess.run(
        [*git, "commit", "-q", "-m", "seed"],
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
    (wt / "docs" / "branch-only.md").write_text("x\n")
    (memories / "branchy.md").write_text("It lives at `docs/branch-only.md`.\n")

    from_wt = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=wt, capture_output=True, text=True, env=env
    )
    check(
        "a worktree resolves to the main checkout's memories",
        "drifted.md" in from_wt.stdout,
    )
    check("the worktree run exits 0", from_wt.returncode == 0)
    check(
        "a path that exists only in the worktree is not called stale",
        "branch-only.md" not in from_wt.stdout,
    )

    from_main = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env
    )
    check(
        "the same path is stale from the main checkout, where it does not exist",
        "branch-only.md" in from_main.stdout,
    )
    (memories / "branchy.md").unlink()

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
