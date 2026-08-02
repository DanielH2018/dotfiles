#!/usr/bin/env bash
# sandbox-worktree-gc.sh — bulk cleanup: the interactive --prune picker, the
# --gc sweep for worktrees whose remote branch is gone, and the passive startup
# nudge that mentions when there is something to collect. Sourced by
# claude-sandbox (lives in ~/.claude/sandbox). Sourced, not executed: define
# functions only, never run anything at load time or set shell options here.
#
# Split from sandbox-worktree-ops.sh, which keeps the per-worktree lifecycle —
# setup, cleanup, delete, and the three CLI paths that act on one worktree by
# name. The line between them is how many worktrees are in view: everything here
# enumerates the whole set and decides which of them to remove, and none of it
# runs on the ordinary launch path.
#
# CONTRACT — these functions
#
#   * READ launcher globals: REPO_PATH, REPO_NAME, REPO_HASH, SANDBOX_DIR,
#     SESSIONS_BASE and STATE_DIR. They write none of them: unlike
#     setup_worktree, nothing here feeds the main flow, because every path that
#     reaches these exits rather than going on to launch a container;
#   * call list_tool_worktrees from sandbox-worktree.sh to enumerate, and
#     delete_worktree from sandbox-worktree-ops.sh to remove — so this file must
#     be sourced AFTER that one;
#   * call `exit` on failure and on their own success.
#
# CALL ORDER stays in the launcher: the --prune and --gc early exits and the
# startup nudge all sit in the main flow, where the flags that select them are
# parsed. Only the definitions live here.
#
# SC2153 fires here for the same reason it does in sandbox-worktree-ops.sh: the
# launcher's arg parser assigns these globals and this file only reads them.
# shellcheck disable=SC2153

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
