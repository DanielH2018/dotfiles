#!/usr/bin/env bash
# guard-permission-request.sh — PermissionRequest/Bash shim for the claude-guard package.
#
# Failure contract (spec docs/specs/2026-09-06-claude-guard-design.md, "Failure contracts",
# allow path): cannot run or cannot parse → emit NOTHING, exit 0, and the prompt stands. So
# a missing uv, a missing managed 3.14, a missing package, or a Python error all end here
# silently; this is an allow-only hook and silence is its safe state.
#
# Shadow (spec "Rollout" row 2): with CLAUDE_GUARD_SHADOW=1 the Python side computes its
# verdict, runs the deployed bash chain on the same stdin, appends one hashed line to
# ~/.claude/logs/claude-guard-shadow.jsonl and prints nothing. settings.base.json sets the
# variable in its env block; the default below is the belt to that brace, so a settings.json
# not yet regenerated cannot run this hook live. Slice 3 flips both in one PR.
#
# `--no-project` stops uv reading a pyproject in cwd; `--system` stops it answering with a
# valid, version-matching virtualenv it finds by walking up from cwd instead — measured
# returning such a worktree's own `.venv/bin/python3` in place of the managed interpreter,
# which this allow-only hook has no way to notice happened. (A dangling or wrong-version cwd
# venv is not the risk: uv already probes it and falls back to the managed toolchain on its
# own.) `--managed-python` restricts the answer to a uv-managed install. `-S` skips
# site-packages; the package is stdlib-only.
set -u
: "${CLAUDE_GUARD_SHADOW:=1}"
export CLAUDE_GUARD_SHADOW
SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[ -f "$SHARE/claude_guard/cli.py" ] || exit 0
PY=$(uv python find --no-project --managed-python --system 3.14 2>/dev/null) || exit 0
[ -x "$PY" ] || exit 0
PYTHONPATH="$SHARE" "$PY" -S -m claude_guard.cli permission-request
exit 0
