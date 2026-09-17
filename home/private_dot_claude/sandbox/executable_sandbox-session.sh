#!/usr/bin/env bash
# sandbox-session.sh — one run's session context and its teardown, sourced by
# claude-sandbox (lives in ~/.claude/sandbox). Sourced, not executed: define functions
# only, never run anything at load time or set shell options here.
#
# The two halves of a single run's lifecycle. resolve_session_context works out where
# this instance's state lives and whether there is a conversation to resume, then prints
# the launch banner; cleanup undoes what the run created. They are here together because
# the second exists to unwind the first — ARTIFACTS_DIR is set by one and reported by
# the other.
#
# CONTRACT — both are launcher-global consumers, neither is pure.
#
# resolve_session_context READS INSTANCE_ID, REPO_PATH, AUDIT_BASE, SESSIONS_BASE,
# ARTIFACTS_BASE, PRIVATE_BASE, STATE_DIR, FRESH_SESSION, WORK_PATH, USE_WORKTREE,
# WT_BRANCH and DOCKERFILE, and SETS
# AUDIT_DIR, SESSIONS_DIR, ARTIFACTS_DIR, PRIVATE_DIR, RESUME_SESSION, AUTH_MARKER
# and TOOLCHAIN_LIST
# — every one of which the docker args assembled after it depend on. It also creates the
# per-instance directories.
#
# cleanup is the EXIT trap, so it runs on every path out of the launcher, including the
# failure ones. It removes the staged gh token file (GH_HOSTS_TMPFILE, set by
# sandbox-auth.sh), the vault temporaries and the resolved settings file, and calls
# stop_proxy from sandbox-proxy.sh, cleanup_worktree from sandbox-worktree-ops.sh, and
# av_guarded_remove if Agent View defined it. Everything it touches is read through
# ${VAR:-} so it stays safe when a run fails before the variable is set.
#
# CALL ORDER stays in the launcher: the resolve_session_context call and the
# `trap cleanup EXIT` both sit in the main flow. Only the definitions live here.

# --- Per-instance session context ---
resolve_session_context() {
  AUDIT_DIR="$AUDIT_BASE/$INSTANCE_ID"
  SESSIONS_DIR="$SESSIONS_BASE/$INSTANCE_ID"
  ARTIFACTS_DIR="$ARTIFACTS_BASE/$INSTANCE_ID"
  PRIVATE_DIR="$PRIVATE_BASE/$INSTANCE_ID"
  # $STATE_DIR/hooks is the parent of the per-hook :ro mount points below. Create it
  # here so Docker doesn't materialise it root-owned on the host when it makes the
  # mount points (the state dir lives under the user's real ~/.claude tree).
  mkdir -p "$AUDIT_DIR" "$SESSIONS_DIR" "$ARTIFACTS_DIR" "$STATE_DIR" "$STATE_DIR/hooks"
  # Per-instance replacements for the pooled parts of $STATE_DIR. They have to
  # exist before the mounts are assembled: Docker materialises a missing bind
  # source itself, and for history.jsonl — a FILE — it would materialise a
  # root-owned DIRECTORY on the host, which Claude then cannot write. Same
  # reason $STATE_DIR/hooks is created above.
  mkdir -p "$PRIVATE_DIR/file-history" "$PRIVATE_DIR/shell-snapshots"
  [[ -f "$PRIVATE_DIR/history.jsonl" ]] || : > "$PRIVATE_DIR/history.jsonl"

  # --- Auto-resume: continue the most recent conversation for this instance ---
  # The container cwd is always /workspace, which Claude escapes to the "-workspace"
  # project dir; its top-level *.jsonl are prior conversations. If any exist (and
  # --fresh wasn't passed), append --continue so a re-launch of the same instance
  # picks up where it left off instead of starting cold. Only replays a transcript
  # already persisted on the host — not boundary-affecting.
  RESUME_SESSION=false
  RESUME_SESSION_ID=""
  if [[ "$FRESH_SESSION" == false ]]; then
    if [[ -n "$(find "$SESSIONS_DIR/-workspace" -maxdepth 1 -name '*.jsonl' -print -quit 2>/dev/null)" ]]; then
      RESUME_SESSION=true
    else
      # A session that made its own worktree and moved into it re-keys its
      # project directory to the new cwd, so its transcript lands under
      # "-workspace--claude-worktrees-<name>" and never under "-workspace".
      # Confirmed on the host: ~/.claude/projects holds exactly those slugs for
      # worktrees made with EnterWorktree. Without this the instance looks cold
      # on every relaunch while its conversation sits one directory over.
      #
      # --continue cannot reach it — it resolves against the container's cwd,
      # which is /workspace — so this path resumes by id instead. `claude
      # --resume <id>` was verified to work from an unrelated cwd.
      #
      # maxdepth 2 from here is maxdepth 1 within each slug, which keeps
      # subagent transcripts (written under <slug>/<id>/) out, exactly as the
      # -workspace probe above does.
      local newest
      newest="$(find "$SESSIONS_DIR" -mindepth 2 -maxdepth 2 -name '*.jsonl' -print0 2>/dev/null \
        | xargs -0 -r ls -t 2>/dev/null | head -1 || true)"
      if [[ -n "$newest" ]]; then
        RESUME_SESSION=true
        # shellcheck disable=SC2034  # read by append_resume_args() in the launcher, across the source boundary
        RESUME_SESSION_ID="$(basename "$newest" .jsonl)"
      fi
    fi
  fi

  AUTH_MARKER="$STATE_DIR/.auth-configured"

  echo ""
  echo "Starting Claude Code in Pattern C sandbox for $INSTANCE_ID..."
  echo "  Workspace: $WORK_PATH -> /workspace"
  if [[ "$USE_WORKTREE" == true ]]; then
    echo "  Branch: $WT_BRANCH"
  fi
  echo "  Audit: $AUDIT_DIR -> /audit"
  echo "  Artifacts: $ARTIFACTS_DIR -> /artifacts"
  echo "  State: $STATE_DIR -> /home/claudebot/.claude (persistent)"
  echo "  Sessions: $SESSIONS_DIR -> /home/claudebot/.claude/projects"
  if [[ "$RESUME_SESSION" == true ]]; then
    echo "  Session: resuming most recent conversation (--continue) — pass --fresh to start clean"
  else
    # The cold path used to print nothing, so an INSTANCE_ID that missed by a
    # character looked exactly like a first run. Name the id that was looked up,
    # and point at --list: the prior conversation is almost always still on disk
    # under a neighbouring id (a different -b branch, or a different casing of
    # the same one). Unconditional rather than enumerated — list_orphan_sessions
    # reports only instances whose worktree is gone, so a live sibling worktree
    # would not show up in a nudge built on it.
    if [[ "$FRESH_SESSION" == true ]]; then
      echo "  Session: starting a new conversation (--fresh)"
    else
      echo "  Session: no prior conversation for $INSTANCE_ID — starting cold"
      echo "           Expected one? claude-sandbox --list $REPO_PATH"
    fi
  fi
  echo "  Plugins: ~/.claude/plugins -> /home/claudebot/.claude/plugins (read-only)"
  echo "  Commands/Agents: ~/.claude/{commands,agents} -> /home/claudebot/.claude/{commands,agents} (read-only)"
  if [[ -f "$AUTH_MARKER" ]]; then
    echo "  Cloud MCPs: authenticated (read-only, write ops denied)"
  else
    echo "  Cloud MCPs: not yet authenticated (login will be prompted)"
  fi

  # Detect installed toolchains from the generated Dockerfile
  TOOLCHAIN_LIST=""
  if [[ -f "$DOCKERFILE" ]]; then
    TOOLCHAIN_LIST=$(grep '# ---' "$DOCKERFILE" 2>/dev/null | sed 's/# --- //;s/ ---.*//' | paste -sd ', ' - || true)
    if grep -q 'uv/install' "$DOCKERFILE" 2>/dev/null; then
      TOOLCHAIN_LIST="${TOOLCHAIN_LIST:+$TOOLCHAIN_LIST, }uv"
    fi
  fi
}

# --- Cleanup on exit ---
cleanup() {
  # Remove temporary gh config file (contains token)
  if [[ -n "${GH_HOSTS_TMPFILE:-}" && -f "$GH_HOSTS_TMPFILE" ]]; then
    rm -f "$GH_HOSTS_TMPFILE"
  fi
  # Remove temporary generated Snowflake config (not secret, but per-run)
  if [[ -n "${SNOWFLAKE_CONFIG_TMPFILE:-}" && -f "$SNOWFLAKE_CONFIG_TMPFILE" ]]; then
    rm -f "$SNOWFLAKE_CONFIG_TMPFILE"
  fi
  if [[ -n "${VAULT_INDEX_TMP:-}" && -f "$VAULT_INDEX_TMP" ]]; then
    rm -f "$VAULT_INDEX_TMP"
  fi
  if [[ -n "${VAULT_DB_TMPDIR:-}" && -d "$VAULT_DB_TMPDIR" ]]; then
    rm -rf "$VAULT_DB_TMPDIR"
  fi
  # The resolved settings file is the mount source, so it has to outlive the
  # container — remove it here rather than earlier. Pattern-matched because
  # resolve-sandbox-settings.sh falls back to returning $SANDBOX_DIR/settings.base.json
  # (a real tracked file) when the fold and the merge both fail.
  case "${SANDBOX_SETTINGS:-}" in
    */sandbox-settings-*.json | */sandbox-host-*.json) rm -f "$SANDBOX_SETTINGS" ;;
  esac
  if [[ "$NEEDS_DOCKER" == true ]]; then
    stop_proxy
  fi
  if [[ -n "${ARTIFACTS_DIR:-}" && -d "$ARTIFACTS_DIR" && -n "$(ls -A "$ARTIFACTS_DIR" 2>/dev/null)" ]]; then
    echo ""
    echo "Artifacts written to: $ARTIFACTS_DIR"
  fi
  if [[ "$USE_WORKTREE" == true ]]; then
    cleanup_worktree
  fi
  repair_container_worktrees
  # Deregister this session's Agent View row. RUN_ID-guarded: if a newer session ever
  # reused the deterministic INSTANCE_ID key, this exit can't delete the newer row.
  if [[ "${AV_REGISTERED:-false}" == true ]] && declare -f av_guarded_remove >/dev/null 2>&1; then
    av_guarded_remove "$INSTANCE_ID" "$RUN_ID" || true
  fi
  # Leave the pane back to word-left; a pane that outlives the container would otherwise
  # keep routing C-Left to Agent View.
  if [[ "${AV_PANE_MARKED:-false}" == true && -n "${TMUX_PANE:-}" ]]; then
    tmux set-option -p -t "$TMUX_PANE" -u @av_agent 2>/dev/null || true
  fi
}
