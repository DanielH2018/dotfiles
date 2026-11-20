#!/usr/bin/env python3
# gen-hooks: register
#   event: SessionStart
#   matcher: startup|resume|clear
#   timeout: 15
#   order: 50
#   command: bash ~/.claude/hooks/lib/run-python.sh prune-worktrees.py --hook
#   description: Remove merged, clean, unlocked session worktrees
# Every source that opens a working session, not just "startup": a resumed session is
# the long-lived case where merged siblings pile up, and its own tree is kept as the
# current one either way. Not "compact", which fires mid-turn and would sweep for
# nothing.
"""Start the worktree pruner, as the SessionStart hook and as a command.

The pruner is `claude_worktree_sweep.py` in the claude-worktree package, deployed at
`~/.local/share/claude-worktree`; its module docstring has the modes, the exit codes
and what a repository's `.claude/prune-worktrees.json` may say. This file only finds
that package. `CLAUDE_WORKTREE_HOME` points it at another copy, which is how the tests
run it from the source tree.

There is no fallback copy here. Without the package the hook says why nothing was
pruned and lets the session start, and every other caller exits 69, so a timer on a
host whose `chezmoi apply` never ran fails loudly.
"""

import os
import sys
from pathlib import Path

PACKAGE_MISSING = 69

_HOME = Path(
    os.environ.get("CLAUDE_WORKTREE_HOME", Path.home() / ".local/share/claude-worktree")
)
if _HOME.is_dir():
    sys.path.insert(0, str(_HOME))
try:
    import claude_worktree_sweep
except ImportError as exc:
    why = f"{exc} — `chezmoi apply` deploys {_HOME}"
    if "--hook" in sys.argv[1:]:
        print(f"worktree autoprune skipped: {why}")
        sys.exit(0)
    print(f"prune-worktrees: {why}", file=sys.stderr)
    sys.exit(PACKAGE_MISSING)

if __name__ == "__main__":
    sys.exit(claude_worktree_sweep.main())
