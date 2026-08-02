#!/usr/bin/env bash
# Regenerate the tools inventory after every `chezmoi apply`, so the HTML page always
# reflects the just-deployed set of commands — including which of them this host actually
# got. The generator (~/.local/bin/tools-inventory) and its data (~/.local/share/
# tools-inventory/tools.json) are applied before this "after" script runs.
#
# Cheap enough to leave enabled, unlike the terminal-cheatsheet script next to it (which
# is listed in .chezmoiignore and so never runs): the rendered page carries no timestamp,
# so an unchanged inventory produces a byte-identical file and the generator skips the
# write entirely. A no-op run is a few dozen small reads.
#
# Drift — a script in the source tree with no tools.json entry — is reported on stderr
# here and in a banner on the page itself, but never fails the apply. A stale inventory is
# not a reason to abort deploying dotfiles.
set -eu

# chezmoi runs this non-interactively, so fnm's node (put on PATH only by the interactive
# shell rc) isn't visible. Add fnm's stable default-alias bin so node resolves here too.
fnm_bin="${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin"
[ -d "$fnm_bin" ] && PATH="$fnm_bin:$PATH"

# Same problem, second binary: the generator shells out to `chezmoi ignored` for the
# per-host column, and chezmoi's own installer puts it in ~/.local/bin, which this
# environment need not carry either. Measured on the first real apply: the spawn failed
# with ENOENT and the page rendered with no host column at all.
[ -d "$HOME/.local/bin" ] && PATH="$HOME/.local/bin:$PATH"

command -v node >/dev/null 2>&1 || { echo "tools-inventory: node not found, skipping"; exit 0; }
gen="$HOME/.local/bin/tools-inventory"
[ -f "$gen" ] || { echo "tools-inventory: generator not deployed yet, skipping"; exit 0; }

node "$gen" || echo "tools-inventory: generation failed, leaving the previous page in place"
