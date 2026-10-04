"""cc-wait: one command for every wait a Claude Code session makes.

A wait names a source (`file`, `exit`, or a repo's `.claude/wait-sources/<name>`), and
`cc_wait.loop` owns everything else: the budget, the retries, the output and the exit code.
The contract is in docs/specs/2026-10-04-cc-wait-design.md in the dotfiles repo.
"""

__version__ = "0.1.0"
