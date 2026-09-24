#!/usr/bin/env python3
"""Standalone tests for memory-upkeep.py.

Run: python3 test_memory_upkeep.py

The hook has three sections, and this file pins them in the order the hook runs them.

Stale paths and stale checks report memories naming repo paths that are gone. What
needs pinning is the false-positive rate, not the detection: this prints at every
session start, and a report that names a memory wrongly even once teaches the reader to
skip the whole line. Memories are full of slashed tokens that are not paths —
`refs/heads/main`, `kube-system/coredns`, `get list watch` — and every one of them must
stay out.

Index size warns when MEMORY.md has too many pointer lines. What needs pinning is the
counting rule and the silence: it must count only real entries (a heading or a prose
bullet is not an entry) and must say nothing below the cap, outside a repo, or when the
index is missing.

The last block pins what merging them added: each opt-out silences only its own
sections, and one section staying quiet never stops the other from running.
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
SCRIPT = HERE / "executable_memory-upkeep.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "memory-upkeep.py"

spec = importlib.util.spec_from_file_location("memory_upkeep", SCRIPT)
mod = importlib.util.module_from_spec(spec)
sys.modules["memory_upkeep"] = mod
spec.loader.exec_module(mod)

# See test_prune_worktrees.py: GIT_DIR outranks cwd, and git exports it to every hook.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]

with tempfile.TemporaryDirectory() as tmp:
    # .resolve() because the checks below compare against paths the code under test
    # reports, and git reports a checkout by its real path. On macOS the temp dir sits
    # under /var/folders, a symlink to /private/var/folders, so an unresolved root makes
    # every such comparison miss on a prefix neither side chose.
    root = Path(tmp).resolve()
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
    # the check reads the sentence holding the path rather than the line.

    check(
        "a path the memory says no longer exists",
        stale("guarded by `ansible/roles/gone.yml`, which no longer exists") == [],
    )
    check(
        "a path the memory says was deleted",
        stale("`ansible/roles/gone.yml` was deleted in commit abc1234") == [],
    )
    # Same sentence, wrapped: `sentence_bounds` scopes the marker search to the sentence
    # rather than the line because these files wrap mid-sentence. Until 2026-09-19 this
    # case put the marker in the NEXT sentence ("... `gone.yml`. That directory has no
    # `files/`"), the shape the +/-200 character window accepted before 8d642ae scoped
    # the search to a sentence, and it stayed red in the tree for three weeks because
    # nothing ran this file. The next-sentence shape is reported now, by design: see
    # `a marker suppresses only within its own sentence` in
    # tests/hooks/memory-upkeep.test.js.
    check(
        "the marker may follow the path across a line break",
        stale(
            "`AUTOMATIONS_YAML` still pointed at\n`ansible/roles/gone.yml`, a\n"
            "directory that no longer exists, so it raised."
        )
        == [],
    )
    # The pin for that design: a marker one sentence AFTER the path does not suppress.
    # Decided by measurement on 2026-09-19 (#549): widening forward changed no live
    # flag and the one mention it would newly suppress carried a marker about a review
    # fix, not the path. The docstring of `already_says_it_is_gone` says the same; this
    # is what stops the two drifting apart again.
    check(
        "a marker in the next sentence does not suppress",
        stale(
            "`AUTOMATIONS_YAML` still pointed at `ansible/roles/gone.yml`. That\n"
            "directory has no build output, so it raised."
        )
        == ["ansible/roles/gone.yml"],
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
    # Path existence is checked against every checkout of the repo: the session's own
    # first, then the main checkout and each sibling worktree. A file added on a branch
    # is therefore not stale from anywhere while a worktree holds it — a memory written
    # by the session that created the file, ahead of its merge, is correct, and the hook
    # flagged one from `master` at every session start until the PR landed (dotfiles
    # #557). Once the worktree is gone the path reads as stale again.
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
        "a path only a sibling worktree holds is not stale from the main checkout",
        "branch-only.md" not in from_main.stdout,
    )
    check(
        "a path in no checkout is still stale from the main checkout",
        "ansible/roles/gone.yml" in from_main.stdout,
    )
    check(
        "sibling_checkouts lists the worktree from the main checkout",
        mod.sibling_checkouts(repo, repo) in ([wt], [wt.resolve()]),
    )
    check(
        "sibling_checkouts lists the main checkout first from the worktree",
        mod.sibling_checkouts(wt, repo)[0] == repo,
    )
    check(
        "sibling_checkouts keeps the main checkout when git fails",
        mod.sibling_checkouts(root / "not-a-repo", repo) == [repo],
    )

    subprocess.run(
        ["git", "worktree", "remove", "--force", str(wt)],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    after_prune = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env
    )
    check(
        "the same path is stale once the worktree holding it is gone",
        "branch-only.md" in after_prune.stdout,
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


# ── index size: the counting rule ────────────────────────────────────────────────────

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


# ── index size: end to end ───────────────────────────────────────────────────────────

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
    check("exits 0 when it reports the index", over.returncode == 0)

    check("--max moves the cap", run(repo, args=("--max", "200")).stdout == "")
    check(
        "the index opt-out silences it",
        run(repo, {"CLAUDE_MEMORY_INDEX_CHECK": "0"}).stdout == "",
    )

    outside = run(tmp)
    check(
        "outside a repo the index check is a silent no-op",
        outside.returncode == 0 and outside.stdout == "",
    )

    # ── the worktree case, for the index ─────────────────────────────────────────────
    # Memory is keyed to the main checkout, so a session in .claude/worktrees/<name>
    # must resolve back to it. Without that, the check is silent in exactly the
    # sessions this repo spends most of its time in.
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
    check("the worktree index run exits 0", from_wt.returncode == 0)

    write_index(85)
    check("a worktree is silent under the cap", run(wt).stdout == "")
    write_index(92)

    # ── both halves in one run ───────────────────────────────────────────────────────
    # What the merge added. Each section is gated on its own opt-out, and a section with
    # nothing to say must not end the run before the other one reads the tree.
    (repo / "docs").mkdir()
    (memory / "drifted.md").write_text("The gate is `docs/gone.md`.\n")
    both = run(repo)
    check(
        "one run reports a stale path and an oversized index together",
        "drifted.md" in both.stdout and "pointer lines" in both.stdout,
    )
    no_paths = run(repo, {"CLAUDE_MEMORY_PATH_CHECK": "0"})
    check(
        "the path opt-out drops the path report and keeps the index report",
        "drifted.md" not in no_paths.stdout and "pointer lines" in no_paths.stdout,
    )
    no_index = run(repo, {"CLAUDE_MEMORY_INDEX_CHECK": "0"})
    check(
        "the index opt-out drops the index report and keeps the path report",
        "drifted.md" in no_index.stdout and "pointer lines" not in no_index.stdout,
    )
    check(
        "both opt-outs silence the whole hook",
        run(
            repo, {"CLAUDE_MEMORY_PATH_CHECK": "0", "CLAUDE_MEMORY_INDEX_CHECK": "0"}
        ).stdout
        == "",
    )
    (memory / "drifted.md").unlink()

    index.unlink()
    missing = run(repo)
    check(
        "no index is a silent no-op",
        missing.returncode == 0 and missing.stdout == "",
    )

finish()
