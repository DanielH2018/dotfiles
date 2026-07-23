#!/usr/bin/env bash
# Regenerate the terminal cheatsheet after every `chezmoi apply`, so the HTML page
# always reflects the just-deployed WezTerm / Neovim / Yazi configs. Cheap (~200ms)
# and idempotent. The generator (~/.local/bin/terminal-cheatsheet) is applied before
# this "after" script runs, and parses the freshly-rendered files under ~/.config.
set -eu

# chezmoi runs this non-interactively, so fnm's node (put on PATH only by the interactive
# shell rc) isn't visible. Add fnm's stable default-alias bin so node resolves here too.
fnm_bin="${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin"
[ -d "$fnm_bin" ] && PATH="$fnm_bin:$PATH"

command -v node >/dev/null 2>&1 || { echo "terminal-cheatsheet: node not found, skipping"; exit 0; }
gen="$HOME/.local/bin/terminal-cheatsheet"
[ -f "$gen" ] || { echo "terminal-cheatsheet: generator not deployed yet, skipping"; exit 0; }

node "$gen"
