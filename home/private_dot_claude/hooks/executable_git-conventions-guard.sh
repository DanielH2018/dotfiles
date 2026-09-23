#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Bash
#   timeout: 10
#   order: 45
# PreToolUse (Bash) hook: three git conventions from CLAUDE.md, as command checks (#575).
#
#   git commit --amend                    ask
#   git merge without --ff-only           ask   (--abort/--continue/--quit pass too)
#   gh pr create|edit --title <bad>       deny  (a feat:/fix: style prefix, or a ticket id)
#
# The rules live in claude_guard.checks.git_conventions, which decides on each command's
# own argv from claude_guard.segment rather than on the command text. Its docstring has
# the shapes a substring match gets wrong, and its tests pin each rule both ways.
#
# bin/land and bin/land-sync run their own `git merge --ff-only` inside a script, where
# no hook sees it. Typed by hand, the same command carries --ff-only and passes.
#
# Every failure here is no decision: no interpreter, no package, an unreadable command.
# guard-pre-tool-use.sh already asks on a command the parser refuses.

set -u

# Cheapest bail first, ahead of any interpreter: this runs on every Bash call, and a
# command that names none of these words cannot break any of the three rules.
IN=$(cat)
case "$IN" in
  *amend*|*merge*|*title*|*' -t'*) ;;
  *) exit 0 ;;
esac

GUARD_SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[ -f "$GUARD_SHARE/claude_guard/checks/git_conventions.py" ] || exit 0
# The interpreter lookup is guard-pre-tool-use.sh's, flag for flag: --no-project/--system/
# --managed-python keep uv from answering with a worktree's own venv, and -S -P stop a
# cwd-local module shadowing the package.
PY=$(uv python find --no-project --managed-python --system 3.14 2>/dev/null) || exit 0
[ -x "$PY" ] || exit 0

printf '%s' "$IN" | CG_SHARE="$GUARD_SHARE" "$PY" -S -P -c '
import os, sys
sys.path.insert(0, os.environ["CG_SHARE"])
from claude_guard.checks.git_conventions import hook_output
out = hook_output(sys.stdin.read())
if out:
    print(out)
' 2>/dev/null
exit 0
