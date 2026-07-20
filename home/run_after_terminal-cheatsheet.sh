#!/usr/bin/env bash
# Regenerate the terminal cheatsheet after every `chezmoi apply`, so the HTML page
# always reflects the just-deployed WezTerm / Neovim / Yazi configs. Cheap (~200ms)
# and idempotent. The generator (~/.local/bin/terminal-cheatsheet) is applied before
# this "after" script runs, and parses the freshly-rendered files under ~/.config.
set -eu

command -v node >/dev/null 2>&1 || { echo "terminal-cheatsheet: node not found, skipping"; exit 0; }
gen="$HOME/.local/bin/terminal-cheatsheet"
[ -f "$gen" ] || { echo "terminal-cheatsheet: generator not deployed yet, skipping"; exit 0; }

node "$gen"
