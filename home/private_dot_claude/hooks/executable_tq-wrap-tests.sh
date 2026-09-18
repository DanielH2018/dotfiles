#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Bash
#   timeout: 10
#   order: 40
#   command: {{ if eq .chezmoi.os "windows" }}py -3 ~/.claude/hooks/tq-wrap-tests.py{{ else }}~/.claude/hooks/tq-wrap-tests.sh{{ end }}
# Non-Windows goes through the bash shim, which answers the 98% of Bash calls
# tq will never claim without starting an interpreter (25ms -> ~10ms), and
# execs the .py for the rest. Windows keeps calling the .py directly: the
# shim is a POSIX shell script and the saving is not worth a second code
# path there. Both routes end at the same Python authority.
# PreToolUse (Bash) shim in front of tq-wrap-tests.py.
#
# The Python hook is correct and stays the authority; what it is not is cheap. It sits in
# front of every Bash call the agent makes, and starting the interpreter alone costs ~13ms
# before a line of its logic runs — measured 25ms end to end, 3042 calls/day.
#
# Measured over 24h of real commands (3631 sampled), the work it does is almost all wasted:
#
#   62%  contain a shell character, so rewrite() returns None immediately
#   36%  are a simple command whose program tq does not claim -- these paid for the
#        `import detect` purely to obtain the candidate list and then bailed
#    2%  are actually worth asking tq about
#
# So this shim answers the 98% in bash and execs Python only for the rest. The whole design
# rule is that it may only ever *skip* work Python would also have skipped: anything it
# cannot classify with certainty falls through, where the slow path is the correct path.
# Fail-open is the same posture the Python hook takes -- a hook that cannot understand its
# input must leave the command alone.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# In the source tree the sibling is `executable_tq-wrap-tests.py`; chezmoi drops the prefix
# on apply, so the default only resolves once deployed. TQ_WRAP_PY is the seam the suite
# uses to exercise the checkout — without it every test here would run the fall-through
# path and assert nothing about the fast one.
PY="${TQ_WRAP_PY:-${BASH_SOURCE[0]%/*}/tq-wrap-tests.py}"
run_python() { printf '%s' "$_HOOK_INPUT_RAW" | exec python3 "$PY"; }

# Cheap exits that need no payload parsing. TQ_OFF is the documented kill switch; without a
# tq binary rewrite() returns None for every command anyway.
[ -n "${TQ_OFF:-}" ] && exit 0
TQ_SOURCE="${TQ_BIN:-$HOME/.local/bin/tq}"
[ -x "$TQ_SOURCE" ] || exit 0
command -v jq >/dev/null 2>&1 || { run_python; exit 0; }

# The candidate shortlist is tq's, never a copy: it is dumped from detect.py and re-dumped
# whenever that file changes, so the two cannot drift the way an inline list here would.
# The key is the module's size+mtime; a miss costs one interpreter start, which is what
# every call used to cost.
TQ_LIB="${TQ_HOME:-${TQ_SOURCE%/bin/*}/share/tq}"
DETECT="$TQ_LIB/detect.py"
[ -r "$DETECT" ] || { run_python; exit 0; }

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-hooks"
CACHE="$CACHE_DIR/tq-candidates.json"
KEY_FILE="$CACHE_DIR/tq-candidates.key"
KEY=$(stat -c '%s-%Y' "$DETECT" 2>/dev/null || stat -f '%z-%m' "$DETECT" 2>/dev/null) || KEY=''

if [ -z "$KEY" ] || [ "$(cat "$KEY_FILE" 2>/dev/null)" != "$KEY" ] || [ ! -s "$CACHE" ]; then
  mkdir -p "$CACHE_DIR" 2>/dev/null
  if TQ_LIB="$TQ_LIB" python3 -c '
import json, os, sys
lib = os.environ["TQ_LIB"]
sys.path.insert(0, lib)
import detect
print(json.dumps(sorted(detect.CANDIDATES)))
' > "$CACHE.tmp" 2>/dev/null && [ -s "$CACHE.tmp" ]; then
    mv -f "$CACHE.tmp" "$CACHE" 2>/dev/null
    printf '%s' "$KEY" > "$KEY_FILE" 2>/dev/null
  else
    rm -f "$CACHE.tmp" 2>/dev/null
    run_python
    exit 0
  fi
fi

# One jq pass decides it. Everything ambiguous returns "python" rather than "skip":
#
#   * a shell character means rewrite() bails, so skipping matches it exactly
#   * a first token that is not a plain program name -- quoted, an assignment, a variable,
#     anything shlex would read differently from a naive split -- is not ours to judge
#   * a program tq claims still has to face detect(), which only Python can run
VERDICT=$(printf '%s' "$_HOOK_INPUT_RAW" | jq -r --slurpfile c "$CACHE" '
  ($c[0] // []) as $cands
  | if .tool_name != "Bash" then "skip"
    else ((.tool_input.command // "") | tostring) as $cmd
    | if ($cmd | length) == 0 then "skip"
      elif ($cmd | test("[;&|<>()`$\n]")) then "skip"
      else ($cmd | sub("^[ \t]+"; "") | split(" ")[0]) as $first
      | if ($first | test("^[A-Za-z0-9._/+-]+$") | not) then "python"
        elif ($cands | index($first | split("/") | last)) then "python"
        else "skip"
        end
      end
    end' 2>/dev/null) || VERDICT=python

[ "$VERDICT" = "skip" ] && exit 0
run_python
