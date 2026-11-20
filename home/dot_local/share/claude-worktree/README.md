# claude-worktree

The one pruner for the worktrees Claude Code creates under a repository's
`.claude/worktrees/`, and the library that judges a single tree.

- `claude_worktree.py` is the library: the readers (`Worktree`, `parse_worktree_list`,
  `session_is_alive`, `process_holds`), the landed ladder (`local_layer`, `merged_layer`,
  the verdict cache), the holds (`lock_is_live`, `processes_using`, `is_fresh`,
  `is_dirty`), and `classify` and `remove`. The server repo's `lib.worktrees` imports it
  for `findings.py` and `fanout.py`.
- `claude_worktree_sweep.py` is the pruner: the survey, the branch sweep, the
  orphan-directory sweep, the reports and the CLI. Its module docstring has the modes and
  the exit codes.
- `~/.claude/hooks/prune-worktrees.py` starts the pruner. It is the SessionStart hook
  (`--hook`) and the command every other caller runs.

## What a repository contributes

A repository states its policy in `.claude/prune-worktrees.json`, read from the primary
checkout. With no file the strictest policy applies: only ancestry and a merged pull
request from the exact tip remove anything, only `worktree-*` branches are swept, and the
SessionStart sweep runs. `claude_worktree_sweep.read_policy` documents each key:

| Key | What it changes |
|---|---|
| `session_start` | `"off"` keeps the SessionStart sweep out, for a repo that prunes from a timer |
| `landed_by` | lets a `patch-id` or `content` match remove a tree and delete a branch |
| `branch_prefixes` | the branch names the branch sweep may delete |
| `unit_locks` | a pattern for lock reasons that name a systemd user unit |
| `branch_holds` | a command that prints the branches the sweep must not delete |
| `label_file` | a file at a worktree's root whose first line labels it in reports |

An unknown key is refused, and a file that does not parse stops every mode before it
removes anything.

## Calling it from outside this repo

Callers reach the deployed copy at `~/.local/share/claude-worktree`, or wherever
`CLAUDE_WORKTREE_HOME` points. `claude_worktree.INTERFACE` is raised whenever such a
caller needs something an older copy lacks. An importer compares it; a command passes
`--require N`, which exits 78 on an older copy. A host with no copy at all exits 69 from
the launcher. Neither reads as "nothing to remove".

The server repo's CI has no dotfiles deploy, so it checks out this repo at a pinned SHA
and links the package into place.

    PYTHONPATH=. uv run --no-project --with pytest pytest    # from this directory
