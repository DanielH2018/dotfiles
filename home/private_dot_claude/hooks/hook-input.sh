# shellcheck shell=bash
# The library lives in lib/hook-input.sh. This file keeps the old path working for hooks
# installed from outside this repo that source hook-input.sh beside themselves:
# work-laptop-config's symlinked hooks. Delete it once they source lib/hook-input.sh.
#
# The $HOME fallback serves a caller staged elsewhere with this file symlinked beside it,
# where BASH_SOURCE names the symlink's directory and that directory has no lib/.
# shellcheck source=/dev/null
. "${BASH_SOURCE[0]%/*}/lib/hook-input.sh" 2>/dev/null || . "$HOME/.claude/hooks/lib/hook-input.sh"
