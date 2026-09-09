"""claude-guard: one Python package for Claude Code Bash permission decisions.

Slice 1 shipped the segmenter (`segment`) and the CLI. Slice 4 ships the deny rules (`deny`),
the PreToolUse entry in `hook`, registered in its own shadow. The cutovers and the homelab
package are later slices; see docs/specs/2026-09-06-claude-guard-design.md in the dotfiles
repo.
"""

__version__ = "0.1.0"
