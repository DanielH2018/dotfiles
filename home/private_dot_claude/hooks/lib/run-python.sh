# shellcheck shell=bash
# run-python.sh — start a Python hook under the interpreter claude_guard runs under.
#
# Usage, as a gen-hooks `command:` line:  bash ~/.claude/hooks/lib/run-python.sh <hook.py> [args]
#
# DECIDED: every Python hook runs under uv's managed CPython 3.14 (lib/guard-python.sh), not
# `#!/usr/bin/env python3`. Three reasons, in order of weight:
#
#   1. `env python3` resolves through the session's PATH, so a session that activated a
#      project venv ran the hooks under that venv's interpreter, with its site-packages
#      ahead of the stdlib. The managed lookup ignores a venv by construction (`--system`).
#   2. The managed 3.14 is already a hard dependency: the claude_guard shims ask on every
#      Bash call without it. `python3` was a second, unpinned one, and it drifts by machine
#      (3.15 from Homebrew on the work laptop, the distro's 3.12 on a Linux box).
#   3. CI already runs these hooks' tests under TOOLCHAIN_PYTHON, the same 3.14 the managed
#      install pins, so the tested interpreter and the live one become the same.
#
# The hooks use only the stdlib and put their own lib/ on sys.path, so they start with
# `-S -P`, as claude_guard does: no site-packages, and no script directory prepended ahead of
# the stdlib.
#
# Failure contract: a host with no managed 3.14 (or no run-bounded.sh to bound the lookup)
# runs the hook under `python3` as before, with one line on stderr naming the fallback. These
# hooks maintain state and catch mistakes; not running one is worse than running it under a
# different minor version. Two lookups that cannot finish cost this launcher its 2s bound,
# which fits the shortest registration it serves (5s).

set -u
dir=${BASH_SOURCE[0]%/*}
# shellcheck source=/dev/null
if . "${RUN_BOUNDED_LIB:-$dir/run-bounded.sh}" 2>/dev/null && . "$dir/guard-python.sh" 2>/dev/null \
  && guard_python 2; then
  exec "$GUARD_PY" -S -P "$@"
fi
printf 'run-python: no uv-managed Python 3.14, so %s runs under python3\n' "${1:-?}" >&2
exec python3 "$@"
