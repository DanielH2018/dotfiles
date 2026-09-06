"""claude-guard: one Python package for Claude Code Bash permission decisions.

Slice 1 shipped the segmenter (`segment`) and the CLI. Slice 2 ships the settings loader
(`rules`), the compound judge (`judge`), the scratch-rm and safe-curl checks (`checks`), the
shared tables (`tables`) and the PermissionRequest entry (`hook`), registered in shadow.
The deny rules, the cutover and the homelab package are later slices; see
docs/specs/2026-09-06-claude-guard-design.md in the dotfiles repo.
"""

__version__ = "0.1.0"
