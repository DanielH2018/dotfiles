#!/usr/bin/env bash
# sandbox-worktree-ops.sh — one worktree at a time: create it, clean it up, delete
# it, and the three CLI paths that act on a worktree by name
# (--complete-worktrees, --complete-branches, --rename). Sourced by claude-sandbox
# (lives in ~/.claude/sandbox). Sourced, not executed: define functions only, never
# run anything at load time or set shell options here.
#
# NOT sandbox-worktree-gc.sh. That file holds the operations that take the whole set
# of worktrees in view — the --prune picker, the --gc sweep and the startup nudge —
# and it depends on delete_worktree here, so it is sourced after this file.
#
# NOT sandbox-worktree.sh. That file holds the pure helpers these operations are
# built from — sanitize_repo_name, repo_hash, resolve_worktree_target,
# worktree_exists_at, find_worktree_for_branch, list_tool_worktrees — and its header
# promises they read no launcher globals and never exit, which is what lets tests
# source it freely. This file is the opposite on both counts and is kept separate so
# that promise stays true rather than being quietly weakened.
#
# CONTRACT — the most entangled of the sandbox libs. These functions
#
#   * READ launcher globals: REPO_PATH, REPO_NAME, REPO_HASH, SANDBOX_DIR,
#     SESSIONS_BASE, AUDIT_BASE, ARTIFACTS_BASE, STATE_DIR, WT_NAME, BRANCH_MODE,
#     EXISTING_BRANCH;
#   * WRITE launcher globals the main flow depends on afterwards: WT_BRANCH,
#     WT_PATH, WT_CREATED and WORK_PATH — setup_worktree exists to set those;
#   * call into sandbox-worktree.sh for the pure helpers, and compact_session from
#     sandbox-compact.sh when deleting a worktree;
#   * call `exit` on failure, and the three CLI paths exit on their error branches
#     too — rename_worktree() also calls usage(), which the launcher defines.
#
# CALL ORDER stays in the launcher: the --prune/--gc/--setup-worktree early exits,
# the startup nudge and the setup_worktree call all sit in the launcher's main flow,
# where the flags that select them are parsed. Only the definitions live here.
#
# SC2153 fires on WT_NAME, which the launcher's arg parser assigns and this file only
# reads; the linter cannot see across that boundary and offers the local wt_name as a
# likely misspelling instead. The directive is file-wide, not scoped to that name.
# shellcheck disable=SC2153

# --- Git worktree management ---
setup_worktree() {
  IFS=$'\t' read -r WT_BRANCH WT_PATH < <(
    resolve_worktree_target "$REPO_PATH" "$REPO_NAME" "$WT_NAME" "$BRANCH_MODE" "$EXISTING_BRANCH")

  if worktree_exists_at "$REPO_PATH" "$WT_PATH"; then
    echo "Reusing existing worktree: $WT_PATH (branch: $WT_BRANCH)"
    WORK_PATH="$(cd "$WT_PATH" && pwd)"
    return
  fi

  # If the branch is already checked out in another worktree, git refuses to
  # add a second one. Reuse a tool worktree; refuse (with guidance) for main.
  local existing_wt
  existing_wt="$(find_worktree_for_branch "$REPO_PATH" "$WT_BRANCH" || true)"
  if [[ -n "$existing_wt" ]]; then
    if [[ "$existing_wt" == "$REPO_PATH" ]]; then
      echo "Error: branch '$WT_BRANCH' is checked out in your main checkout:" >&2
      echo "  $REPO_PATH" >&2
      echo "Run 'claude-sandbox $REPO_PATH' to sandbox it there, or move the main" >&2
      echo "checkout off it first:  git -C $REPO_PATH switch <other-branch>" >&2
      exit 1
    fi
    echo "Branch '$WT_BRANCH' already checked out — reusing worktree: $existing_wt"
    WORK_PATH="$existing_wt"
    return
  fi

  if [[ "$BRANCH_MODE" == true ]]; then
    # Use the branch if it exists (local, or origin via git DWIM tracking);
    # otherwise create it from HEAD. A branch created here is removed on a
    # clean exit (see cleanup_worktree); pre-existing branches are always kept.
    if git -C "$REPO_PATH" show-ref --verify --quiet "refs/heads/$WT_BRANCH" 2>/dev/null \
       || git -C "$REPO_PATH" show-ref --verify --quiet "refs/remotes/origin/$WT_BRANCH" 2>/dev/null; then
      echo "Creating worktree from branch: $WT_BRANCH"
      git -C "$REPO_PATH" worktree add "$WT_PATH" "$WT_BRANCH"
    else
      echo "Creating worktree with new branch (forked from HEAD): $WT_BRANCH"
      git -C "$REPO_PATH" worktree add -b "$WT_BRANCH" "$WT_PATH"
      WT_BRANCH_CREATED=true
    fi
  elif git -C "$REPO_PATH" show-ref --verify --quiet "refs/heads/$WT_BRANCH" 2>/dev/null; then
    # Branch exists locally — create worktree from it
    echo "Creating worktree from existing branch: $WT_BRANCH"
    git -C "$REPO_PATH" worktree add "$WT_PATH" "$WT_BRANCH"
  else
    # New branch — fork from current HEAD
    echo "Creating worktree with new branch: $WT_BRANCH"
    git -C "$REPO_PATH" worktree add -b "$WT_BRANCH" "$WT_PATH"
  fi

  WT_CREATED=true
  WORK_PATH="$(cd "$WT_PATH" && pwd)"
  echo "  Worktree: $WORK_PATH"
  echo "  Branch:   $WT_BRANCH"
}

cleanup_worktree() {
  # Only consider cleanup for worktrees we created this session
  if [[ "$WT_CREATED" != true ]]; then
    return
  fi
  if [[ -z "$WT_PATH" || ! -d "$WT_PATH" ]]; then
    return
  fi

  local has_changes=false

  # Check for uncommitted changes (staged, unstaged, or untracked)
  if [[ -n "$(git -C "$WT_PATH" status --porcelain 2>/dev/null)" ]]; then
    has_changes=true
  fi

  # Check for unpushed commits vs the parent branch
  local commit_count
  commit_count=$(git -C "$WT_PATH" rev-list --count HEAD --not --remotes 2>/dev/null || echo "0")
  if [[ "$commit_count" -gt 0 ]]; then
    has_changes=true
  fi

  if [[ "$has_changes" == true ]]; then
    echo ""
    echo "Worktree kept (has changes):"
    echo "  Path:   $WT_PATH"
    echo "  Branch: $WT_BRANCH"
    echo ""
    echo "To push and create a PR:"
    echo "  cd $WT_PATH"
    echo "  git push -u origin $WT_BRANCH"
    echo "  gh pr create --draft"
    echo ""
    echo "To remove when done:"
    echo "  git -C $REPO_PATH worktree remove $WT_PATH"
    echo "  git -C $REPO_PATH branch -d $WT_BRANCH"
  else
    echo "Worktree clean — removing: $WT_PATH"
    git -C "$REPO_PATH" worktree remove "$WT_PATH" 2>/dev/null || true
    if [[ "$BRANCH_MODE" == true && "$WT_BRANCH_CREATED" != true ]]; then
      echo "  Keeping pre-existing branch: $WT_BRANCH"
    else
      git -C "$REPO_PATH" branch -d "$WT_BRANCH" 2>/dev/null || true
    fi
  fi
}

# --- Delete a single worktree and its data ---
delete_worktree() {
  # Usage: delete_worktree <wt-name> <instance-id>
  local wt_name="$1"
  local instance_id="$2"
  local wt_path="$REPO_PATH/../$REPO_NAME-wt-$wt_name"
  # Resolve the branch BEFORE removing the worktree (removal detaches the ref).
  local wt_branch
  wt_branch="$(resolve_worktree_branch "$wt_name" "$REPO_PATH" "$REPO_NAME")"

  # Compact session before deletion
  # Non-fatal: compaction failures must not abort prune before deletion (set -e)
  compact_session "$instance_id" "$REPO_NAME" "$wt_name" || true

  # Remove worktree if it exists. A dirty worktree (uncommitted or untracked
  # files) makes a plain remove fail; since the user explicitly selected and
  # confirmed deletion — and compaction archived a summary above — fall back to
  # --force so the worktree (and hence its branch) can actually be removed.
  if [[ -d "$wt_path" ]] || git -C "$REPO_PATH" worktree list --porcelain 2>/dev/null | grep -q "/$REPO_NAME-wt-$wt_name$"; then
    echo "  Removing worktree: $wt_path"
    git -C "$REPO_PATH" worktree remove "$wt_path" 2>/dev/null \
      || git -C "$REPO_PATH" worktree remove --force "$wt_path" 2>/dev/null \
      || true
  fi

  # Delete the branch the worktree was actually on (claude/<name> for -w, an
  # arbitrary name for -b). branch -D cannot remove a branch still checked out
  # in a worktree, so this must run after the removal above.
  if [[ -n "$wt_branch" ]] && git -C "$REPO_PATH" show-ref --verify --quiet "refs/heads/$wt_branch" 2>/dev/null; then
    echo "  Deleting branch: $wt_branch"
    git -C "$REPO_PATH" branch -D "$wt_branch" 2>/dev/null || true
  fi

  # Remove session and audit data. `${instance_id:?}` rather than a bare
  # expansion: the -d guards above are satisfied by the BASE directory when the
  # id is empty, so the three rm -rf below would take out every instance's data
  # rather than this one's. Both call sites build a non-empty id today; this
  # makes a future third one fail loudly instead of destructively.
  if [[ -d "$SESSIONS_BASE/$instance_id" ]]; then
    rm -rf "${SESSIONS_BASE:?}/${instance_id:?}"
    echo "  Removed session data: $instance_id"
  fi
  if [[ -d "$AUDIT_BASE/$instance_id" ]]; then
    rm -rf "${AUDIT_BASE:?}/${instance_id:?}"
    echo "  Removed audit data: $instance_id"
  fi
  if [[ -d "$ARTIFACTS_BASE/$instance_id" ]]; then
    rm -rf "${ARTIFACTS_BASE:?}/${instance_id:?}"
    echo "  Removed artifacts data: $instance_id"
  fi
}

# --- Worktree CLI paths (each ends in an early exit; see CALL ORDER above) ---
complete_worktree_names() {
  [[ -z "$REPO_PATH" ]] && exit 0

  # Resolve short repo names
  REPO_PATH="$(resolve_repo_path "$REPO_PATH")"
  REPO_PATH="$(cd "$REPO_PATH" 2>/dev/null && pwd)" || exit 0

  repo_name_safe="$(sanitize_repo_name "$REPO_PATH")"
  rhash="$(repo_hash "$REPO_PATH")"
  base_instance="${repo_name_safe}-${rhash}"

  # Names `-w NAME` can reuse: a tool worktree at <repo>-wt-<name> that is on
  # claude/<name>. Previously this offered every claude/* branch in the worktree
  # list, including one checked out somewhere that is not a tool worktree — for
  # which `-w` would go on to make a second worktree and reuse the first, not the
  # round-trip the completion implies.
  while IFS=$'\t' read -r wt_name wt_branch _; do
    [[ "$wt_branch" == "claude/$wt_name" ]] && printf '%s\n' "$wt_name"
  done < <(list_tool_worktrees "$REPO_PATH" "$repo_name_safe")

  # Orphaned session names (worktree gone but session data remains)
  list_orphan_sessions "$REPO_PATH" "$repo_name_safe" "$SESSIONS_BASE" "$base_instance"
}

complete_branch_names() {
  [[ -z "$REPO_PATH" ]] && exit 0

  REPO_PATH="$(resolve_repo_path "$REPO_PATH")"
  REPO_PATH="$(cd "$REPO_PATH" 2>/dev/null && pwd)" || exit 0

  # Local branches only (refs/heads). -b still accepts a remote-only branch
  # name typed manually; this just keeps completion to a manageable subset.
  git -C "$REPO_PATH" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null | sort -u
}

rename_worktree() {
  [[ -z "$REPO_PATH" ]] && usage

  # Resolve short repo names
  REPO_PATH="$(resolve_repo_path "$REPO_PATH")"
  REPO_PATH="$(cd "$REPO_PATH" && pwd)"

  # Validate new name
  if [[ ! "$RENAME_NEW" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: new name must be alphanumeric (hyphens/underscores allowed): '$RENAME_NEW'" >&2
    exit 1
  fi

  REPO_NAME="$(sanitize_repo_name "$REPO_PATH")"
  REPO_HASH="$(repo_hash "$REPO_PATH")"

  OLD_BRANCH="claude/$RENAME_OLD"
  NEW_BRANCH="claude/$RENAME_NEW"
  OLD_WT_PATH="$REPO_PATH/../$REPO_NAME-wt-$RENAME_OLD"
  NEW_WT_PATH="$REPO_PATH/../$REPO_NAME-wt-$RENAME_NEW"
  OLD_INSTANCE="${REPO_NAME}-${REPO_HASH}-${RENAME_OLD}"
  NEW_INSTANCE="${REPO_NAME}-${REPO_HASH}-${RENAME_NEW}"

  # Determine if the worktree/branch actually exist (vs orphaned session data)
  OLD_WT_PATH_ABS="$(cd "$OLD_WT_PATH" 2>/dev/null && pwd)" || true
  HAS_WORKTREE=false
  HAS_BRANCH=false
  [[ -n "$OLD_WT_PATH_ABS" ]] && HAS_WORKTREE=true
  git -C "$REPO_PATH" show-ref --verify --quiet "refs/heads/$OLD_BRANCH" 2>/dev/null && HAS_BRANCH=true

  # Must have at least a worktree, branch, or session data
  if [[ "$HAS_WORKTREE" == false && "$HAS_BRANCH" == false \
        && ! -d "$SESSIONS_BASE/$OLD_INSTANCE" && ! -d "$AUDIT_BASE/$OLD_INSTANCE" \
        && ! -d "$ARTIFACTS_BASE/$OLD_INSTANCE" ]]; then
    echo "Error: nothing found for '$RENAME_OLD' (no worktree, branch, or session data)" >&2
    exit 1
  fi

  # Check new name isn't already taken
  if git -C "$REPO_PATH" show-ref --verify --quiet "refs/heads/$NEW_BRANCH" 2>/dev/null; then
    echo "Error: branch '$NEW_BRANCH' already exists" >&2
    exit 1
  fi
  if [[ -d "$NEW_WT_PATH" ]]; then
    echo "Error: worktree path already exists: $NEW_WT_PATH" >&2
    exit 1
  fi

  # Check no running container for this worktree
  if docker ps --filter "name=claudebot-${OLD_INSTANCE}-" --format '{{.Names}}' 2>/dev/null | grep -q .; then
    echo "Error: a sandbox session is running for '$RENAME_OLD' — stop it first" >&2
    exit 1
  fi

  echo "Renaming worktree: $RENAME_OLD -> $RENAME_NEW"

  # 1. Rename branch (skip if none)
  if [[ "$HAS_BRANCH" == true ]]; then
    echo "  Branch: $OLD_BRANCH -> $NEW_BRANCH"
    git -C "$REPO_PATH" branch -m "$OLD_BRANCH" "$NEW_BRANCH"
  fi

  # 2. Move worktree directory (skip if none)
  if [[ "$HAS_WORKTREE" == true ]]; then
    echo "  Path: $OLD_WT_PATH_ABS -> $NEW_WT_PATH"
    git -C "$REPO_PATH" worktree move "$OLD_WT_PATH_ABS" "$NEW_WT_PATH"
  fi

  # 3. Move session data
  if [[ -d "$SESSIONS_BASE/$OLD_INSTANCE" ]]; then
    echo "  Sessions: $OLD_INSTANCE -> $NEW_INSTANCE"
    mv "$SESSIONS_BASE/$OLD_INSTANCE" "$SESSIONS_BASE/$NEW_INSTANCE"
  fi

  # 4. Move audit data
  if [[ -d "$AUDIT_BASE/$OLD_INSTANCE" ]]; then
    echo "  Audit: $OLD_INSTANCE -> $NEW_INSTANCE"
    mv "$AUDIT_BASE/$OLD_INSTANCE" "$AUDIT_BASE/$NEW_INSTANCE"
  fi

  # 5. Move artifacts data
  if [[ -d "$ARTIFACTS_BASE/$OLD_INSTANCE" ]]; then
    echo "  Artifacts: $OLD_INSTANCE -> $NEW_INSTANCE"
    mv "$ARTIFACTS_BASE/$OLD_INSTANCE" "$ARTIFACTS_BASE/$NEW_INSTANCE"
  fi

  echo ""
  echo "Done. Resume with:"
  echo "  claude-sandbox -w $RENAME_NEW $REPO_PATH"
}
