# claude-worktree

One module, `claude_worktree.py`, holding the readers two worktree pruners share: the
dotfiles `prune-worktrees.py` SessionStart hook and the server repo's
`scripts/dev/prune_worktrees.py`. Server issue #2133 is the audit that found the two
scripts carrying ten function names in common, three of them byte-identical.

What is shared is the READING — `Worktree`, `parse_worktree_list`, `session_is_alive`,
`cherry_says_landed`, `merge_tree_says_contained`, `default_ref`, and `process_holds`,
the /proc scan for processes still holding a tree. The `worktree-landed.sh` Stop hook
runs that scan as `claude_worktree.py holders <tree>`. What stays per-repo is
the delete authority: the hook reports a squash or rebase match as REVIEW and never
removes; the server script removes it after asking the forge which head it merged.

`cherry_says_landed` takes an explicit `empty_means` because the two callers read empty
`git cherry` output oppositely, and a wrong default would delete a fresh worktree.

Callers reach the deployed copy at `~/.local/share/claude-worktree`, or wherever
`CLAUDE_WORKTREE_HOME` points. The server repo's CI has no dotfiles deploy, so it checks
out this repo at a pinned SHA and links the package into place (server#2812).

    PYTHONPATH=. uv run --no-project --with pytest pytest    # from this directory
