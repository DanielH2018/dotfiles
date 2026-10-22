# shellcheck shell=bash
# shellcheck disable=SC2034  # GUARD_PY and GUARD_PY_STATUS are the caller's to read
# guard_python: the one place the hooks resolve the interpreter that runs claude_guard and the
# Python hooks: uv's managed CPython 3.14.
#
# The flags are the lookup's, and each closes a measured wrong answer. `--no-project` stops uv
# reading a pyproject in cwd. `--system` stops it answering with a valid, version-matching
# virtualenv it finds by walking up from cwd: measured returning a worktree's own
# `.venv/bin/python3` in place of the managed interpreter. `--managed-python` restricts the
# answer to a uv-managed install. Callers add `-S -P` when they start it, for the reasons
# guard-pre-tool-use.sh gives.
#
# The answer is cached, because `uv python find` costs about as much as starting Python
# (26.8 ms against 26.2 ms for `python3.14 -S -P -c pass`, measured 2026-10-22 in the Bash
# sandbox), and three hooks paid it around every Bash call.
#
# The cache is a trust boundary. The deny hook execs whatever path it holds, outside the
# sandbox, and the cache directory is one the sandbox can write. So a cached path is used only
# when it names `bin/python3.14` inside a `cpython-3.14` install under uv's managed-Python
# directory, which the sandbox cannot write, and is executable. Anything else is ignored and
# looked up afresh. The worst a forged cache can then do is pick another uv-managed 3.14, which
# is what the lookup itself may answer. A stale entry (an uninstalled interpreter) fails the
# executable test and is replaced the same way. uv names the minor-version install
# `cpython-3.14-<platform>` and repoints it on a patch upgrade, so the cached path follows
# upgrades without a refresh.
#
# Knobs: GUARD_PYTHON_CACHE=0 turns the cache off. UV_PYTHON_INSTALL_DIR moves the managed
# directory, as it does for uv.

#######################################
# Resolves the managed 3.14 interpreter.
# Globals:
#   GUARD_PY         set to the interpreter path on success, "" otherwise.
#   GUARD_PY_STATUS  set to `ok`, `none` (uv answered, but with no usable interpreter), or
#                    the run_bounded status of a lookup that did not finish.
# Arguments:
#   The lookup's time bound in seconds. The caller must have sourced run-bounded.sh.
# Returns:
#   0 with GUARD_PY set; 1 otherwise. The caller decides what its failure contract makes of
#   `none` against a lookup that did not finish.
#######################################
guard_python() {
  local bound=$1 cache root cached=''
  GUARD_PY=''
  root="${UV_PYTHON_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/uv/python}"
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/claude-hooks/guard-python"
  if [ "${GUARD_PYTHON_CACHE:-1}" != 0 ] && [ -f "$cache" ]; then
    IFS= read -r cached < "$cache" 2>/dev/null
    if _guard_python_trusted "$cached" "$root"; then
      GUARD_PY=$cached
      GUARD_PY_STATUS=ok
      return 0
    fi
  fi

  # </dev/null: a hook's payload is on stdin, and the lookup must not read it.
  run_bounded "$bound" 4096 -- \
    bash -c 'exec uv python find --no-project --managed-python --system 3.14 2>/dev/null' </dev/null
  GUARD_PY_STATUS=$RB_STATUS
  [ "$RB_STATUS" = ok ] || return 1
  GUARD_PY_STATUS=none
  [ "$RB_EXIT" -eq 0 ] && [ -x "$RB_OUT" ] || return 1
  GUARD_PY=$RB_OUT
  GUARD_PY_STATUS=ok
  # Only a path the reader would trust is worth writing; one uv answered from elsewhere (a
  # Windows layout, a moved install dir) is used for this call and looked up again next time.
  if [ "${GUARD_PYTHON_CACHE:-1}" != 0 ] && _guard_python_trusted "$GUARD_PY" "$root"; then
    mkdir -p "${cache%/*}" 2>/dev/null
    { printf '%s\n' "$GUARD_PY" > "$cache.$$" && mv -f "$cache.$$" "$cache"; } 2>/dev/null \
      || rm -f "$cache.$$" 2>/dev/null
  fi
  return 0
}

#######################################
# Whether a path is a uv-managed 3.14 interpreter under the managed directory.
# Arguments:
#   The candidate path, then uv's managed-Python directory.
# Returns:
#   0 when the path may be executed, 1 otherwise.
#######################################
_guard_python_trusted() {
  local py=$1 root=$2
  case "$py" in
    ''|*'/../'*|*'/./'*) return 1 ;;
    "$root"/cpython-3.14[.-]*/bin/python3.14) ;;
    *) return 1 ;;
  esac
  # One directory level between root and bin/: the glob's `*` would also cross a `/`.
  local rest=${py#"$root"/}
  rest=${rest%/bin/python3.14}
  case "$rest" in */*) return 1 ;; esac
  [ -x "$py" ] && [ ! -d "$py" ]
}
