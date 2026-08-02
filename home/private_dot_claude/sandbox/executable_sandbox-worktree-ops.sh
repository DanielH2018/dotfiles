#!/usr/bin/env bash
# sandbox-worktree-ops.sh — the worktree lifecycle: create, clean up, delete, prune,
# GC, and the passive startup nudge. Sourced by claude-sandbox (lives in
# ~/.claude/sandbox). Sourced, not executed: define functions only, never run
# anything at load time or set shell options here.
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
#   * call `exit` on failure, in eight places.
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

# --- Interactive worktree pruning ---
prune_worktrees() {
  local base_instance="${REPO_NAME}-${REPO_HASH}"

  local -a entries=()
  local -a entry_names=()

  local name wt_branch wt_path status unpushed last_date
  while IFS=$'\t' read -r name wt_branch wt_path; do
    status="clean"
    if [[ -n "$(git -C "$wt_path" status --porcelain 2>/dev/null)" ]]; then
      status="has changes"
    fi
    unpushed="$(git -C "$wt_path" rev-list --count HEAD --not --remotes 2>/dev/null || echo "0")"
    if [[ "$unpushed" -gt 0 ]]; then
      status="has unpushed commits"
    fi
    last_date="$(git -C "$wt_path" log -1 --format='%as' 2>/dev/null || echo "unknown")"
    entries+=("$(printf '%-16s %-28s %-12s %s' "$name" "$wt_branch" "$last_date" "$status")")
    entry_names+=("$name")
  done < <(list_tool_worktrees "$REPO_PATH" "$REPO_NAME")

  local suffix orphan_branch
  while IFS= read -r suffix; do
    [[ -n "$suffix" ]] || continue
    orphan_branch="$(resolve_worktree_branch "$suffix" "$REPO_PATH" "$REPO_NAME")"
    [[ -z "$orphan_branch" ]] && orphan_branch="(branch gone)"
    entries+=("$(printf '%-16s %-28s %-12s %s' "$suffix" "$orphan_branch" "n/a" "orphaned")")
    entry_names+=("$suffix")
  done < <(list_orphan_sessions "$REPO_PATH" "$REPO_NAME" "$SESSIONS_BASE" "$base_instance")

  if [[ ${#entries[@]} -eq 0 ]]; then
    echo "No worktrees found for $REPO_NAME."
    exit 0
  fi

  local -a selected_names=()

  if command -v fzf &>/dev/null; then
    local header
    header="$(printf '%-16s %-28s %-12s %s' "NAME" "BRANCH" "LAST COMMIT" "STATUS")"

    # Preview sources the worktree lib and calls the function directly, rather
    # than re-entering claude-sandbox with --_preview: the launcher's prelude
    # (settings resolution, docker probes) would run on every keystroke. Values
    # go in as positional args — printf %q on the paths, and fzf shell-quotes
    # {1} itself — so a repo path containing a quote can't break out of the
    # preview command string.
    local preview_cmd
    # shellcheck disable=SC2016  # the $0..$4 are the preview shell's positionals, expanded by fzf's bash, not this one
    preview_cmd="$(printf 'bash -c %s %s {1} %s %s %s' \
      "$(printf '%q' 'source "$0"; fzf_preview_worktree "$1" "$2" "$3" "$4"')" \
      "$(printf '%q' "$SANDBOX_DIR/sandbox-worktree.sh")" \
      "$(printf '%q' "$REPO_PATH")" \
      "$(printf '%q' "$REPO_NAME")" \
      "$(printf '%q' "$REPO_HASH")")"

    local selected
    selected="$(printf '%s\n' "${entries[@]}" | \
      fzf --multi \
          --header="$header" \
          --preview="$preview_cmd" \
          --preview-window=right:50%:wrap \
          --prompt="Select worktrees to delete (TAB to multi-select): " || true)"

    if [[ -z "$selected" ]]; then
      echo "No worktrees selected."
      exit 0
    fi

    while IFS= read -r line; do
      local name
      name="$(echo "$line" | awk '{print $1}')"
      selected_names+=("$name")
    done <<< "$selected"
  else
    echo "Worktrees for $REPO_NAME:"
    echo ""
    printf '  %-4s %-16s %-28s %-12s %s\n' "#" "NAME" "BRANCH" "LAST COMMIT" "STATUS"
    printf '  %-4s %-16s %-28s %-12s %s\n' "---" "----" "------" "-----------" "------"
    local idx=1
    for entry in "${entries[@]}"; do
      printf '  %-4s %s\n' "$idx)" "$entry"
      idx=$((idx + 1))
    done
    echo ""
    echo -n "Enter numbers to delete (comma-separated, e.g. 1,3,5): "
    read -r selection
    [[ -z "$selection" ]] && { echo "No selection."; exit 0; }
    IFS=',' read -ra indices <<< "$selection"
    for i in "${indices[@]}"; do
      i="$(echo "$i" | tr -d ' ')"
      if [[ "$i" =~ ^[0-9]+$ ]] && [[ "$i" -ge 1 ]] && [[ "$i" -le ${#entry_names[@]} ]]; then
        selected_names+=("${entry_names[$((i-1))]}")
      fi
    done
  fi

  if [[ ${#selected_names[@]} -eq 0 ]]; then
    echo "No valid worktrees selected."
    exit 0
  fi

  echo ""
  echo "Will delete ${#selected_names[@]} worktree(s):"
  for name in "${selected_names[@]}"; do
    local sel_branch
    sel_branch="$(resolve_worktree_branch "$name" "$REPO_PATH" "$REPO_NAME")"
    [[ -z "$sel_branch" ]] && sel_branch="(branch gone)"
    echo "  - $name ($sel_branch)"
  done
  echo ""
  echo -n "Proceed? (y/n): "
  read -r confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Cancelled."
    exit 0
  fi

  echo ""
  for name in "${selected_names[@]}"; do
    local instance="${base_instance}-${name}"
    echo "Deleting $name..."
    delete_worktree "$name" "$instance"
    echo ""
  done

  echo "Done. ${#selected_names[@]} worktree(s) cleaned up."
}

# --- GC: clean up worktrees with deleted remote branches ---
gc_worktrees() {
  local base_instance="${REPO_NAME}-${REPO_HASH}"

  # Both exits below stamp $STATE_DIR/.last-gc, and --gc is reachable before any
  # container launch has created that directory — on a fresh install the redirect
  # failed under set -e, so gc deleted the worktrees and then died before its
  # summary, leaving the stamp unwritten and the startup nudge firing forever.
  mkdir -p "$STATE_DIR"

  echo "Fetching remote state..."
  git -C "$REPO_PATH" fetch --prune 2>/dev/null || true

  # Scan tool worktrees (dir <repo>-wt-*, any branch) whose upstream is gone.
  local -a gone_names=()
  local -a gone_branches=()
  local name wt_branch track
  while IFS=$'\t' read -r name wt_branch _; do
    track="$(git -C "$REPO_PATH" for-each-ref --format='%(upstream:track)' "refs/heads/$wt_branch" 2>/dev/null)"
    if [[ "$track" == "[gone]" ]]; then
      gone_names+=("$name")
      gone_branches+=("$wt_branch")
    fi
  done < <(list_tool_worktrees "$REPO_PATH" "$REPO_NAME")

  if [[ ${#gone_names[@]} -eq 0 ]]; then
    echo "No worktrees with deleted remote branches found."
    date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/.last-gc"
    exit 0
  fi

  echo ""
  printf '  %-16s %-28s %-12s %s\n' "WORKTREE" "BRANCH" "PR STATUS" "ACTION"
  printf '  %-16s %-28s %-12s %s\n' "--------" "------" "---------" "------"

  local i
  for i in "${!gone_names[@]}"; do
    name="${gone_names[$i]}"
    local branch="${gone_branches[$i]}"
    local pr_status="unknown"
    if command -v gh &>/dev/null; then
      local pr_state
      pr_state="$(gh pr list --repo "$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null)" --head "$branch" --state all --json state --jq '.[0].state' 2>/dev/null || true)"
      if [[ -n "$pr_state" ]]; then
        pr_status="$(echo "$pr_state" | tr '[:upper:]' '[:lower:]')"
      else
        pr_status="none found"
      fi
    fi
    printf '  %-16s %-28s %-12s %s\n' "$name" "$branch" "$pr_status" "compact + delete"
  done

  echo ""
  echo -n "Clean up ${#gone_names[@]} worktree(s) with deleted remote branches? (y/n): "
  read -r confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Cancelled."
    exit 0
  fi

  echo ""
  for name in "${gone_names[@]}"; do
    local instance="${base_instance}-${name}"
    echo "Cleaning up $name..."
    delete_worktree "$name" "$instance"
    echo ""
  done

  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/.last-gc"

  echo "Done. ${#gone_names[@]} worktree(s) cleaned up."
}

# --- Startup GC nudge (passive, non-blocking) ---
check_gc_nudge() {
  local last_gc_file="$STATE_DIR/.last-gc"
  local needs_check=false

  if [[ ! -f "$last_gc_file" ]]; then
    needs_check=true
  elif [[ "$(find "$last_gc_file" -mtime +7 -print -quit 2>/dev/null)" ]]; then
    needs_check=true
  fi

  [[ "$needs_check" == false ]] && return

  local gone_count=0
  local wt_branch track
  while IFS=$'\t' read -r _ wt_branch _; do
    track="$(git -C "$REPO_PATH" for-each-ref --format='%(upstream:track)' "refs/heads/$wt_branch" 2>/dev/null)"
    [[ "$track" == "[gone]" ]] && gone_count=$((gone_count + 1))
  done < <(list_tool_worktrees "$REPO_PATH" "$REPO_NAME")

  if [[ "$gone_count" -gt 0 ]]; then
    echo "Note: $gone_count worktree(s) have deleted remote branches -- run 'claude-sandbox --gc $REPO_PATH' to clean up."
  fi
}
