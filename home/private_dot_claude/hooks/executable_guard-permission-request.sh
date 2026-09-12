#!/usr/bin/env bash
# guard-permission-request.sh — PermissionRequest/Bash shim for the claude-guard package.
#
# Failure contract (spec docs/specs/2026-09-06-claude-guard-design.md, "Failure contracts",
# allow path): cannot run or cannot parse → emit NOTHING, exit 0, and the prompt stands. So
# a missing uv, a missing managed 3.14, a missing package, or a Python error all end here
# silently; this is an allow-only hook and silence is its safe state.
#
# Live (spec "Rollout" row 3, slice 3): with CLAUDE_GUARD_SHADOW=0 the Python side's verdict
# decides -- allow or silence, per the failure contract above. Any other value (shadow, the
# pre-slice-3 default) computes the verdict, logs it to ~/.claude/logs/claude-guard-shadow.jsonl
# against the bash chain it used to run alongside, and decides nothing -- but that bash chain
# is now deleted, so the comparison it logs is against nothing. settings.base.json sets the
# variable in its env block and flipped to "0" in the same commit that flipped the default
# below from :=1 to :=0. Both must agree: if the generated settings.json ever lost this key
# (a stale regeneration, a host-conditional template branch that never sets it), the OLD
# default of :=1 would leave the hook permanently in shadow with no bash chain left to fall
# back on -- auto-approvals that should fire silently stop firing, and nothing reports it.
# DECIDED: the shim's default now matches the template's post-cutover value for exactly this
# reason; a missing key fails toward the live decision the cutover made, not toward a shadow
# mode whose comparison target no longer exists.
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
set -u
: "${CLAUDE_GUARD_SHADOW:=0}"
export CLAUDE_GUARD_SHADOW
SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[ -f "$SHARE/claude_guard/cli.py" ] || exit 0
PY=$(uv python find --no-project --managed-python --system 3.14 2>/dev/null) || exit 0
[ -x "$PY" ] || exit 0
PYTHONPATH="$SHARE" "$PY" -S -P -m claude_guard.cli permission-request
exit 0
