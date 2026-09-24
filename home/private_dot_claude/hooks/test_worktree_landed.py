#!/usr/bin/env python3
"""Standalone tests for worktree-landed.sh.

Run: python3 test_worktree_landed.py

Feeds the Stop hook a payload on stdin from inside real git worktrees and asserts block
(a JSON decision) vs silence. The contract worth pinning is the silence: this hook fires
at the end of every turn, so a false positive interrupts a working session and tells
it to delete its workspace. The quiet cases outnumber the one that must not be quiet.
"""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from _testkit import check, finish, git

HERE = Path(__file__).resolve().parent
HOOK = HERE / "executable_worktree-landed.sh"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "worktree-landed.sh"

# The squash fallback runs the claude-worktree package's forge lookup. In the source
# tree, point the hook at the package beside it; the deployed copy falls through to
# ~/.local/share/claude-worktree, as test_prune_worktrees.py does.
_PACKAGE_SOURCE = HERE.parent.parent / "dot_local" / "share" / "claude-worktree"
if _PACKAGE_SOURCE.is_dir():
    os.environ.setdefault("CLAUDE_WORKTREE_HOME", str(_PACKAGE_SOURCE))

# Scrub git's own environment before anything runs. These tests build real repositories
# in a temp dir and drive them with `cwd=`, but GIT_DIR and GIT_WORK_TREE outrank cwd —
# and git exports both to every hook it runs. Under a pre-commit or pre-push hook an
# unscrubbed run therefore aims each `git init` and `git commit` at the REAL repository
# the hook fired in.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]

# A stand-in for `gh pr list --head <branch> --state merged --json <fields>`.
# $STUB_MERGED holds one `<branch> <head-sha>` row per merged PR, so a test can
# state a reused branch name whose merged PR points at a different commit — the
# case the hook has to refuse.
#
# It answers BOTH query shapes on purpose. The shape this hook used before it
# asked for head SHAs was `--json number --jq length`; a stub that spoke only the
# new one would make the old hook go silent for want of parseable output. The
# red-proof for the change is the old hook BLOCKING on a reused name, so the old
# shape has to keep working here.
STUB_DIR = Path(tempfile.mkdtemp(prefix="worktree-landed-stub-"))
GH_STUB = STUB_DIR / "gh"
MERGED_LIST = STUB_DIR / "merged"
MERGED_LIST.write_text("")
GH_STUB.write_text(
    "#!/bin/bash\n"
    "branch=\nfields=\n"
    "while [ $# -gt 0 ]; do\n"
    '  case "$1" in\n'
    '    --head) branch="$2"; shift 2 ;;\n'
    '    --json) fields="$2"; shift 2 ;;\n'
    "    *) shift ;;\n"
    "  esac\n"
    "done\n"
    'case "$fields" in\n'
    # headRefOid is answered as gh's JSON, which is what claude_worktree parses.
    '  *headRefOid*) awk -v b="$branch" \'BEGIN { printf "[" } $1 == b '
    '{ printf "%s{\\"headRefOid\\": \\"%s\\"}", s, $2; s = "," } '
    'END { print "]" }\' "$STUB_MERGED" ;;\n'
    '  *) awk -v b="$branch" \'$1 == b { n++ } END { print n+0 }\' "$STUB_MERGED" ;;\n'
    "esac\n"
)
GH_STUB.chmod(0o755)


def run(cwd, stop_hook_active=False, **env):
    """Run the hook in cwd; return its decision, or None when it stayed silent.

    GH_BIN points at the stub below by default, so no test reaches the network. The
    squash fallback shells out to `gh` whenever the local ancestor test fails, which
    covers several of the silent cases too, not just the squash ones.
    """
    result = subprocess.run(
        ["bash", str(HOOK)],
        cwd=cwd,
        input=json.dumps({"session_id": "test", "stop_hook_active": stop_hook_active}),
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "HOOK_INPUT_LIB": str(HERE / "hook-input.sh"),
            "GH_BIN": str(GH_STUB),
            "STUB_MERGED": str(MERGED_LIST),
            **env,
        },
    )
    if result.returncode != 0:
        return {"error": result.stderr.strip() or f"exit {result.returncode}"}
    return json.loads(result.stdout) if result.stdout.strip() else None


def merged_rows(*rows):
    """Set the stub's merged-PR table: (branch, head-sha) pairs."""
    MERGED_LIST.write_text("".join(f"{b} {sha}\n" for b, sha in rows))


def head_of(path):
    return git(["rev-parse", "HEAD"], path).stdout.strip()


def build(root):
    """An origin, a clone, and the worktree states the hook has to tell apart."""
    origin = root / "origin"
    origin.mkdir()
    git(["init", "-q", "-b", "main", "--bare", "."], origin)

    repo = root / "repo"
    git(["clone", "-q", str(origin), str(repo)], root)
    git(["config", "user.email", "t@t"], repo)
    git(["config", "user.name", "t"], repo)
    (repo / "a").write_text("a\n")
    git(["add", "a"], repo)
    git(["commit", "-qm", "init"], repo)
    git(["push", "-q", "origin", "main"], repo)

    trees = repo / ".claude" / "worktrees"
    trees.mkdir(parents=True)

    def worktree(name, *, commit, push, land, squash=False, drop_upstream=False):
        path = trees / name
        git(["worktree", "add", "-q", "-b", f"wt-{name}", str(path)], repo)
        if commit:
            (path / name).write_text(name)
            git(["add", "."], path)
            git(["commit", "-qm", name], path)
        if push:
            git(["push", "-q", "-u", "origin", f"wt-{name}"], path)
        if squash:
            # A squash merge: the branch tip is never an ancestor of the default branch,
            # so only the PR record says this landed.
            git(["merge", "-q", "--squash", f"wt-{name}"], repo)
            git(["commit", "-qm", f"squash {name}"], repo)
            git(["push", "-q", "origin", "main"], repo)
            git(["fetch", "-q", "origin"], repo)
        if land:
            # A merge commit on the default branch — how both real repos land work.
            git(["merge", "-q", "--no-ff", "-m", f"merge {name}", f"wt-{name}"], repo)
            git(["push", "-q", "origin", "main"], repo)
            git(["fetch", "-q", "origin"], repo)
        if drop_upstream:
            # What a merge with branch deletion leaves behind: `branch.<x>.merge` is
            # still configured, but `@{upstream}` no longer resolves, so the tip has
            # nothing local to disagree with. This is the state in which a branch-NAME
            # match was the hook's only evidence before it compared head SHAs.
            git(["push", "-q", "origin", "--delete", f"wt-{name}"], repo)
            git(["fetch", "-q", "--prune", "origin"], path)
        return path

    return {
        "repo": repo,
        "landed": worktree("landed", commit=True, push=True, land=True),
        # A second landed tree, so a check that consumes the one-ask stamp on one of
        # them cannot make a later check pass for the wrong reason.
        "landed2": worktree("landed2", commit=True, push=True, land=True),
        "unmerged": worktree("unmerged", commit=True, push=True, land=False),
        "dirty": worktree("dirty", commit=True, push=True, land=True),
        "fresh": worktree("fresh", commit=False, push=False, land=False),
        "squashed": worktree(
            "squashed", commit=True, push=True, land=False, squash=True
        ),
        # Squash-merged, then worked in again: the tip is no longer the commit the PR
        # record refers to, so the merged PR proves nothing about what is on disk.
        "squashed_then_edited": worktree(
            "squashed-then-edited", commit=True, push=True, land=False, squash=True
        ),
        # Squash-merged and then deleted upstream — the ordinary end state of a
        # landing here. Nothing local contradicts the tip any more, so this is the
        # tree on which the GitHub answer is the whole of the evidence.
        "reused_name": worktree(
            "reused-name",
            commit=True,
            push=True,
            land=False,
            squash=True,
            drop_upstream=True,
        ),
    }


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    t = build(root)
    (t["dirty"] / "scratch").write_text("unsaved\n")

    landed = run(t["landed"])
    check("landed + clean blocks", bool(landed) and landed.get("decision") == "block")
    check(
        "the block names the branch and the tool to call",
        bool(landed)
        and "wt-landed" in landed.get("reason", "")
        and "ExitWorktree" in landed.get("reason", ""),
    )
    check(
        "the block warns off discard_changes",
        bool(landed) and "discard_changes" in landed.get("reason", ""),
    )
    check(
        "the block covers the case where ExitWorktree cannot act",
        bool(landed) and "prune-worktrees.py" in landed.get("reason", ""),
    )
    # Leaving the tree is half the job: the primary checkout still holds the pre-merge
    # commit, and every later session and deploy reads its templates from there.
    check(
        "the block tells the session to fast-forward the primary checkout",
        bool(landed)
        and "pull --ff-only" in landed.get("reason", "")
        and str(t["repo"]) in landed.get("reason", ""),
    )
    # Removing a worktree leaves its branch behind; nothing else deletes it in-session.
    check(
        "the block tells the session to delete the branch with -d, never -D",
        bool(landed)
        and "branch -d wt-landed" in landed.get("reason", "")
        and "Never -D" in landed.get("reason", ""),
    )
    # Both orders are needed, one per merge shape: the pull prunes the tracking ref a
    # squash-merged branch needs, and is the only thing that brings a ff land's
    # tip into the primary's HEAD.
    reason = landed.get("reason", "") if landed else ""
    check(
        "the branch deletion is ordered before the pull",
        "branch -d" in reason
        and "pull --ff-only" in reason
        and reason.index("branch -d") < reason.index("pull --ff-only"),
    )
    check(
        "the block asks for a second -d attempt after the pull",
        "BEFORE the pull" in reason and "AFTER the pull" in reason,
    )

    # Asked once, never again for this tree: merging is often not the end of the work
    # (merge, deploy, verify), and a hook that re-blocks every turn would nag a session
    # that has good reason to stay put.
    check("a later turn on the same worktree is silent", run(t["landed"]) is None)
    check("a second pass in the same cascade is silent", run(t["landed"], True) is None)
    check("uncommitted work is silent", run(t["dirty"]) is None)
    check("an unmerged branch is silent", run(t["unmerged"]) is None)
    check("a fresh never-pushed worktree is silent", run(t["fresh"]) is None)
    check("the primary checkout is silent", run(t["repo"]) is None)
    check("outside a git repo it is silent", run(tmp) is None)

    # A worktree outside .claude/worktrees/ is the operator's, not a session's.
    outside = root / "byhand"
    git(["worktree", "add", "-q", "-b", "wt-byhand", str(outside)], t["repo"])
    git(["push", "-q", "-u", "origin", "wt-byhand"], outside)
    check("a worktree outside .claude/worktrees is silent", run(outside) is None)

    # Detached HEAD has no branch to have landed. Run it on the untouched landed tree,
    # which would otherwise block — so silence here is the detach, not the stamp.
    git(["checkout", "-q", "--detach"], t["landed2"])
    check("detached HEAD is silent", run(t["landed2"]) is None)

    # The squash fallback. Until GitHub says the PR merged, a rewritten tip is
    # indistinguishable from work in progress.
    check(
        "a squash-merged branch is silent while gh reports no merged PR",
        run(t["squashed"]) is None,
    )
    merged_rows(
        ("wt-squashed", head_of(t["squashed"])),
        ("wt-squashed-then-edited", head_of(t["squashed_then_edited"])),
    )
    squashed = run(t["squashed"])
    check(
        "a squash-merged branch blocks once gh reports the PR merged",
        bool(squashed) and squashed.get("decision") == "block",
    )
    check(
        "the squash block says the pull request landed, not that the commits did",
        bool(squashed) and "pull request is merged" in squashed.get("reason", ""),
    )
    # The squash case gets a DIFFERENT cleanup. ExitWorktree tests reachability, so it
    # refuses every rewritten branch. Until 2026-08-22 the block told the session to
    # accept that refusal and stop, stranding the tree the hook had just proven landed.
    squash_reason = squashed.get("reason", "") if squashed else ""
    check(
        "the squash block warns that ExitWorktree will refuse",
        "WILL refuse" in squash_reason,
    )
    check(
        "the squash block still warns off discard_changes",
        "discard_changes" in squash_reason,
    )
    # Order is load-bearing: "keep" releases the lock and lifts the isolation guard,
    # and git holds the branch until the worktree is gone.
    check(
        "the squash block asks for ExitWorktree keep before the git steps",
        'action "keep"' in squash_reason
        and "worktree remove" in squash_reason
        and squash_reason.index('action "keep"')
        < squash_reason.index("worktree remove"),
    )
    check(
        "the squash block removes the worktree before deleting the branch",
        "worktree remove" in squash_reason
        and "branch -d" in squash_reason
        and squash_reason.index("worktree remove") < squash_reason.index("branch -d"),
    )
    # -D is the point of this path. It supplies the fact -d cannot reach once the
    # tracking ref is pruned — but only after -d has been tried, and only here.
    check(
        "the squash block offers -D only as a fallback to -d",
        "branch -d" in squash_reason and "capital-D" in squash_reason,
    )
    check(
        "the squash block never forces the worktree removal",
        "Never --force" in squash_reason,
    )
    # A four-step sequence that half-fails must not leave the session improvising.
    check(
        "the squash block says to stop at the first failing step",
        "Stop at the first step that fails" in squash_reason,
    )
    # The ancestry path must not learn -D from its neighbour: a refusal there is a
    # signal, not an obstacle.
    check(
        "the ancestry block still forbids -D",
        "Never -D on this path" in reason and "capital-D" not in reason,
    )
    # The block carries commands only; the reasoning it points at has to be a file that
    # exists next to the hook, or the pointer is a dead end in every session it fires.
    doc = HOOK.parent / "worktree-landed.md"
    doc_text = doc.read_text() if doc.is_file() else ""
    check("the reasoning doc ships beside the hook", doc.is_file())
    check(
        "both blocks name the reasoning doc by its real path",
        str(doc) in reason and str(doc) in squash_reason,
    )
    check(
        "the reasoning doc explains the fallback the blocks do not",
        "prune-worktrees.py" in doc_text and "Never `--force`" in doc_text,
    )
    check(
        "no gh on PATH is silent",
        run(t["squashed_then_edited"], GH_BIN=str(STUB_DIR / "no-such-gh")) is None,
    )
    check(
        "a gh that fails is silent",
        run(t["squashed_then_edited"], GH_BIN="false") is None,
    )
    # #581: the gh call runs through run_bounded, and a missing run-bounded.sh is a
    # broken install, reported as a hook error rather than as the silence that means
    # "nothing landed". The accepting half is every run() above, with the library
    # present.
    no_lib = run(
        t["squashed_then_edited"], RUN_BOUNDED_LIB="/nonexistent/run-bounded.sh"
    )
    check(
        "a missing run-bounded.sh is a hook error naming the library",
        bool(no_lib) and "/nonexistent/run-bounded.sh" in no_lib.get("error", ""),
    )
    # A commit made after the PR merged exists only here, whatever the PR record says.
    (t["squashed_then_edited"] / "later").write_text("later\n")
    git(["add", "."], t["squashed_then_edited"])
    git(["commit", "-qm", "after the merge"], t["squashed_then_edited"])
    check(
        "a commit made after the merge is silent",
        run(t["squashed_then_edited"]) is None,
    )

    # ── the reused branch name ──────────────────────────────────────────────────
    #
    # The pair below is the one that decides whether `-D` is authorised by evidence
    # or by a string. Both halves run on the SAME worktree, in the state a landing
    # actually leaves: squash-merged, upstream deleted. The upstream test above
    # therefore cannot silence either of them — assert that precondition first, or a
    # green refusal here would be proving something else.
    reused = t["reused_name"]
    upstream_gone = (
        subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", "@{upstream}"],
            cwd=reused,
            capture_output=True,
            text=True,
        ).returncode
        != 0
    )
    check("the reused-name tree has no upstream left to disagree with", upstream_gone)
    check(
        "it still carries the branch config that proves it was pushed",
        subprocess.run(
            ["git", "config", "--get", "branch.wt-reused-name.merge"],
            cwd=reused,
            capture_output=True,
        ).returncode
        == 0,
    )

    # Rejects: a merged PR under this branch name whose head is a DIFFERENT commit.
    # That is a sibling's work, and the tip on disk has landed nowhere. Blocking here
    # tells the session to run `git branch -D` over unlanded commits.
    merged_rows(("wt-reused-name", "0" * 40))
    check(
        "a merged PR under a reused branch name at another commit is silent",
        run(reused) is None,
    )

    # Accepts: the same name, and this time the merged PR's head IS this tip.
    merged_rows(("wt-reused-name", head_of(reused)))
    reused_block = run(reused)
    check(
        "a merged PR whose head is this exact tip blocks",
        bool(reused_block) and reused_block.get("decision") == "block",
    )

shutil.rmtree(STUB_DIR, ignore_errors=True)

finish()
