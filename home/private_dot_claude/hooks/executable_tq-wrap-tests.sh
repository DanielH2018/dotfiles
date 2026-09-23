#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Bash
#   timeout: 10
#   order: 40
#   command: {{ if eq .chezmoi.os "windows" }}py -3 ~/.claude/hooks/tq-wrap-tests.py{{ else }}~/.claude/hooks/tq-wrap-tests.sh{{ end }}
# Non-Windows goes through this bash shim, which keeps the two exits that need no
# command parsing and execs the .py for everything else. Windows calls the .py directly.
# Both routes end at the same Python authority.
# PreToolUse (Bash) shim in front of tq-wrap-tests.py.
#
# DECIDED: no command-text decision here (#580, operator's call on 2026-09-23). This
# shim used to answer most Bash calls itself with a jq pass over the command string, to
# skip starting Python. Whether a command is one simple command is now decided by
# claude_guard.segment inside the .py, the same parser the deny hook runs, so the bash
# side no longer reads the command at all. Measured on daniel-box on 2026-09-23 over 30
# calls each: the deployed jq shim took 29 ms per call on `git status`, its fast path,
# and the .py run directly took 18-19 ms. So the fast path had stopped saving anything.
#
# What stays here are the two exits that cost nothing and read no command: the TQ_OFF
# kill switch, and no tq binary, where rewrite() would return None for every command.
# Fail-open is the Python hook's posture too: a hook that cannot understand its input
# leaves the command alone.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

[ -n "${TQ_OFF:-}" ] && exit 0
[ -x "${TQ_BIN:-$HOME/.local/bin/tq}" ] || exit 0

# In the source tree the sibling is `executable_tq-wrap-tests.py`; chezmoi drops the prefix
# on apply, so the default only resolves once deployed. TQ_WRAP_PY is the seam the suite
# uses to exercise the checkout.
PY="${TQ_WRAP_PY:-${BASH_SOURCE[0]%/*}/tq-wrap-tests.py}"
printf '%s' "$_HOOK_INPUT_RAW" | exec python3 "$PY"
