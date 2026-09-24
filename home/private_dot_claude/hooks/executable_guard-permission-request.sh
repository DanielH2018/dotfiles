#!/usr/bin/env bash
# gen-hooks: register
#   event: PermissionRequest
#   matcher: Bash
#   timeout: 10
#   order: 10
# DECIDED: claude-guard slice 3 cutover (docs/specs/2026-09-06-claude-guard-design.md,
# Rollout row 3). This is now the sole decision for Bash PermissionRequest --
# judge() ports, rule for rule, the six bash hooks that used to be registered
# in settings.base.json (allow-compound-bash.sh, allow-readonly-remote.sh, allow-safe-curl.sh,
# allow-safe-rm.sh, allow-ansible-readonly.sh, allow-daniel-server.sh; each
# hook's own file:line citations live in the claude_guard check that replaced
# it). They are deleted, not merely unregistered -- the Python tests are the
# oracle now. auto-approve-remote-ssh.sh is not among them; its entry moved to
# the server repo's own settings on 2026-08-29 and was never part of this chain.
# Contract unchanged from shadow: cannot run or cannot parse -> emits nothing
# and the prompt stands.
# guard-permission-request.sh — PermissionRequest/Bash shim for the claude-guard package.
#
# Failure contract (spec docs/specs/2026-09-06-claude-guard-design.md, "Failure contracts",
# allow path): cannot run or cannot parse → emit NOTHING, exit 0, and the prompt stands. So
# a missing uv, a missing managed 3.14, a missing package, or a Python error all end here
# silently; this is an allow-only hook and silence is its safe state.
#
# Live (spec "Rollout" row 3, slice 3): the Python side's verdict decides -- allow or silence,
# per the failure contract above. This shim always runs live; slice 6 (2026-09-17) retired the
# CLAUDE_GUARD_SHADOW switch and the shadow mode it fed -- every bash hook it compared against
# was already deleted from disk in slice 3, so the comparison it logged was against nothing.
# See docs/specs/2026-09-06-claude-guard-design.md row 6 and claude_guard.hook's module
# docstring for the history.
#
# `--no-project` stops uv reading a pyproject in cwd; `--system` stops it answering with a
# valid, version-matching virtualenv it finds by walking up from cwd instead — measured
# returning such a worktree's own `.venv/bin/python3` in place of the managed interpreter,
# which this allow-only hook has no way to notice happened. (A dangling or wrong-version cwd
# venv is not the risk: uv already probes it and falls back to the managed toolchain on its
# own.) `--managed-python` restricts the answer to a uv-managed install. `-S` skips
# site-packages; the package is stdlib-only. `-P` stops Python prepending cwd (as `''`) to
# sys.path for `-m` — measured `sys.path[:3] == ['', PYTHONPATH-dir, ...]` without it, so a
# Claude session working in a directory that happens to hold its own claude_guard.py (or,
# unset -S, any stdlib-named module) would shadow this package ahead of PYTHONPATH in the
# very process that decides whether to allow a command. This side is now live, so a shadowed
# package on the allow path could print `allow` and skip a prompt for real.
#
# DECIDED: silence stays this hook's could-not-evaluate verdict, not a deny (#657).
# PermissionRequest has no `ask`. A hook either allows, denies, or prints nothing, and
# nothing leaves the permission prompt up, which is the non-allow outcome a PreToolUse
# guard reaches with `ask`. So `|| exit 0` below is fail-closed here, although it reads
# like guard-pre-tool-use.sh's fail-open. A deny would refuse commands a human could still
# approve.
#
# What was open is the bound. `uv python find` and the judge ran bare, so a hung one held
# the hook until the harness killed it at 10s. Both run through run_bounded (#581): 2s for
# the lookup and 6s for the judge, inside the 10s. CLAUDE_GUARD_TIMEOUT_S sets both, for
# the tests. The judge's output is printed only when it ran to completion and exited 0, so
# a partial `allow` cannot reach the harness. Its stderr is dropped inside the child, as
# guard-pre-tool-use.sh drops it, because a traceback can quote the command. Every
# could-not-evaluate path writes one line to stderr naming what did not run, which the
# harness logs without acting on it.
set -u
not_evaluated() {
  printf 'guard-permission-request: %s -- not evaluated; the permission prompt stands\n' "$1" >&2
  exit 0
}
SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[ -f "$SHARE/claude_guard/cli.py" ] || exit 0
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/run-bounded.sh}"
# shellcheck source=/dev/null
if ! . "$RUN_BOUNDED_PATH" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
  not_evaluated "cannot load $RUN_BOUNDED_PATH"
fi
T_FIND=${CLAUDE_GUARD_TIMEOUT_S:-2}
T_JUDGE=${CLAUDE_GUARD_TIMEOUT_S:-6}

# </dev/null: the payload on stdin is the judge's, and must not be spent on the lookup.
run_bounded "$T_FIND" 4096 -- \
  bash -c 'exec uv python find --no-project --managed-python --system 3.14 2>/dev/null' </dev/null
[ "$RB_STATUS" = ok ] || not_evaluated "uv python find did not finish within ${T_FIND}s ($RB_STATUS)"
[ "$RB_EXIT" -eq 0 ] || exit 0
PY=$RB_OUT
[ -x "$PY" ] || exit 0

# shellcheck disable=SC2016  # $1/$2 belong to the inner bash
run_bounded "$T_JUDGE" 65536 -- \
  bash -c 'PYTHONPATH="$1" exec "$2" -S -P -m claude_guard.cli permission-request 2>/dev/null' _ "$SHARE" "$PY"
[ "$RB_STATUS" = ok ] || not_evaluated "claude_guard did not finish within ${T_JUDGE}s ($RB_STATUS)"
[ "$RB_EXIT" -eq 0 ] || not_evaluated "claude_guard failed (exit $RB_EXIT)"
[ -z "$RB_OUT" ] || printf '%s\n' "$RB_OUT"
exit 0
