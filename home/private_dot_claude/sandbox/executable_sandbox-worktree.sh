#!/usr/bin/env bash
# sandbox-worktree.sh — worktree/session helpers sourced by claude-sandbox
# (lives in ~/.claude/sandbox). Sourced, not executed: define functions only,
# never run anything at load time or set shell options here.
#
# Everything here is a pure function of its arguments — no launcher globals are
# read or written, and nothing calls `exit`. That is what lets the launcher and
# the tests both source this file: the launcher's own worktree code exits the
# process on error, so the existing sandbox tests have to awk the function
# bodies out of the script and run them in a subshell. These don't.

# Repo name as used in Docker tags, instance IDs and worktree directory names:
# the basename with every character outside [a-zA-Z0-9._-] replaced by '-', then
# one leading '-' removed.
#
# The pipeline is the launcher's original verbatim. Note what `s/-$//` actually
# does there: `tr` has already turned basename's own trailing newline into a '-',
# so the trailing strip only ever removes THAT, and a basename ending in '-' keeps
# its dash. Reproduced rather than corrected — this name feeds instance IDs and
# worktree directory names that already exist on disk.
#
# printf, because the pipeline emits no trailing newline of its own and callers
# that don't wrap this in $(…) would otherwise run two results together.
sanitize_repo_name() {
  local name
  name="$(basename "$1" | tr -c 'a-zA-Z0-9._-' '-' | sed 's/^-//;s/-$//')"
  printf '%s\n' "$name"
}

# Short digest of the full repo path, so two repos sharing a basename
# (~/work/api and ~/personal/api) get distinct instance IDs. macOS ships `md5`,
# most Linux distros ship `md5sum`; probed per call rather than shimmed at load
# so that sourcing this file defines functions and nothing else.
repo_hash() {
  local digest
  if command -v md5 >/dev/null 2>&1; then
    digest="$(printf '%s' "$1" | md5)"
  else
    digest="$(printf '%s' "$1" | md5sum | cut -d' ' -f1)"
  fi
  printf '%s\n' "${digest:0:8}"
}

# Enumerate the tool-created worktrees of a repo — those whose directory is
# named <repo_name>-wt-<name>, whatever branch they are on (claude/<name> for
# -w, an arbitrary branch for -b). One line per worktree:
#
#   <name><TAB><branch><TAB><path>
#
# branch is the short form (refs/heads/ stripped). Detached worktrees emit no
# `branch` line in git's porcelain and are skipped, which matches what the
# launcher's hand-rolled copies of this loop did.
list_tool_worktrees() {
  local repo_path="$1" repo_name="$2"
  local line wt_path wt_branch wt_base name
  while IFS= read -r line; do
    if [[ "$line" == "worktree "* ]]; then
      wt_path="${line#worktree }"
    elif [[ "$line" == "branch "* ]]; then
      wt_branch="${line#branch refs/heads/}"
      wt_base="$(basename "$wt_path")"
      if [[ "$wt_base" == "${repo_name}-wt-"* ]]; then
        name="${wt_base#"${repo_name}"-wt-}"
        printf '%s\t%s\t%s\n' "$name" "$wt_branch" "$wt_path"
      fi
      wt_path=""
      wt_branch=""
    fi
  done < <(git -C "$repo_path" worktree list --porcelain 2>/dev/null)
}

# The branch and directory a launch targets, before either exists. `-b` takes the
# branch as given; `-w NAME` derives claude/<name>. Split out of the launcher's
# setup_worktree so the naming rule is testable without creating a worktree —
# the rest of that function mutates the repo and exits, so it stays there.
# Emits: <branch><TAB><path>
resolve_worktree_target() {
  local repo_path="$1" repo_name="$2" wt_name="$3" branch_mode="$4" existing_branch="$5"
  local branch
  if [[ "$branch_mode" == true ]]; then
    branch="$existing_branch"
  else
    branch="claude/$wt_name"
  fi
  printf '%s\t%s\n' "$branch" "$repo_path/../$repo_name-wt-$wt_name"
}

# Path of the worktree that currently has <branch> checked out, empty if none.
# git refuses to add a second worktree for a branch already checked out, so the
# launcher consults this before deciding to reuse or create.
find_worktree_for_branch() {
  local repo_path="$1" branch="$2"
  local line wt_path=""
  while IFS= read -r line; do
    if [[ "$line" == "worktree "* ]]; then
      wt_path="${line#worktree }"
    elif [[ "$line" == "branch refs/heads/$branch" ]]; then
      printf '%s\n' "$wt_path"
      return 0
    fi
  done < <(git -C "$repo_path" worktree list --porcelain 2>/dev/null)
  return 1
}

# Whether <candidate> is already a registered worktree of <repo_path>. Resolves
# the candidate first: it is composed with a `/../` segment, which never matches
# git's porcelain output literally. False for a path that does not exist.
worktree_exists_at() {
  local repo_path="$1" candidate="$2" abs line
  abs="$(cd "$candidate" 2>/dev/null && pwd)" || return 1
  [[ -n "$abs" ]] || return 1
  while IFS= read -r line; do
    [[ "$line" == "worktree $abs" ]] && return 0
  done < <(git -C "$repo_path" worktree list --porcelain 2>/dev/null)
  return 1
}

# Worktree names that have session data under $sessions_base but no live
# worktree left — the sessions a --prune or --list should still offer. Echoes
# one name per line.
list_orphan_sessions() {
  local repo_path="$1" repo_name="$2" sessions_base="$3" base_instance="$4"
  local live_names session_dir session_name suffix
  live_names="$(list_tool_worktrees "$repo_path" "$repo_name" | cut -f1)"
  for session_dir in "$sessions_base/${base_instance}-"*; do
    [[ -d "$session_dir" ]] || continue
    session_name="$(basename "$session_dir")"
    [[ "$session_name" == "$base_instance" ]] && continue
    suffix="${session_name#"${base_instance}"-}"
    # grep -x against the live set rather than a glob: a name is a whole line.
    printf '%s\n' "$live_names" | grep -qxF "$suffix" && continue
    # An instance directory is created by resolve_session_context before the
    # container starts, so every aborted launch leaves an empty one behind. With
    # no transcript in it there is no conversation to offer, and reporting it as
    # an orphaned session sends --list and --prune chasing nothing. mindepth 2:
    # the transcripts live one level down, under the cwd-derived project slug.
    [[ -n "$(find "$session_dir" -mindepth 2 -name '*.jsonl' -print -quit 2>/dev/null)" ]] || continue
    printf '%s\n' "$suffix"
  done
}

# The real branch a tool worktree is on. Worktrees made with -w are on
# claude/<name>; those made with -b are on an arbitrary branch. Read the actual
# branch from git for a live worktree; for an orphaned one (worktree gone, only
# session data left) probe claude/<name> then <name>. Echoes the branch, or
# nothing if none can be determined.
resolve_worktree_branch() {
  local name="$1" repo_path="$2" repo_name="$3"
  local wt_path abs branch
  wt_path="$repo_path/../$repo_name-wt-$name"
  abs="$(cd "$wt_path" 2>/dev/null && pwd)" || abs=""
  if [[ -n "$abs" ]]; then
    branch="$(list_tool_worktrees "$repo_path" "$repo_name" \
      | awk -F'\t' -v p="$abs" '$3==p{print $2; exit}')"
    if [[ -n "$branch" ]]; then
      printf '%s\n' "$branch"
      return
    fi
  fi
  if git -C "$repo_path" show-ref --verify --quiet "refs/heads/claude/$name" 2>/dev/null; then
    printf '%s\n' "claude/$name"
  elif git -C "$repo_path" show-ref --verify --quiet "refs/heads/$name" 2>/dev/null; then
    printf '%s\n' "$name"
  fi
}

# Detail pane for the --prune fzf picker. Rendered per keystroke, so every git
# call is failure-tolerant and nothing here writes to disk.
fzf_preview_worktree() {
  local wt_name="$1" repo_path="$2" repo_name="$3" repo_hash="$4"
  local instance_id="${repo_name}-${repo_hash}-${wt_name}"
  local wt_path="$repo_path/../$repo_name-wt-$wt_name"
  local wt_branch
  wt_branch="$(resolve_worktree_branch "$wt_name" "$repo_path" "$repo_name")"
  [[ -z "$wt_branch" ]] && wt_branch="(unknown)"

  echo "=== $wt_name ==="
  echo ""
  echo "Branch:   $wt_branch"

  if [[ -d "$wt_path" ]]; then
    wt_path="$(cd "$wt_path" && pwd)"
    echo "Path:     $wt_path"

    local last_commit
    last_commit="$(git -C "$wt_path" log -1 --format='%h %ar — %s' 2>/dev/null || echo "no commits")"
    echo "Last:     $last_commit"

    local staged unstaged untracked
    staged="$(git -C "$wt_path" diff --cached --numstat 2>/dev/null | wc -l | tr -d ' ')"
    unstaged="$(git -C "$wt_path" diff --numstat 2>/dev/null | wc -l | tr -d ' ')"
    untracked="$(git -C "$wt_path" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')"
    echo "Changes:  $staged staged, $unstaged unstaged, $untracked untracked"

    local unpushed
    unpushed="$(git -C "$wt_path" rev-list --count HEAD --not --remotes 2>/dev/null || echo "?")"
    echo "Unpushed: $unpushed commit(s)"
  else
    echo "Path:     (no worktree — orphaned session)"
  fi

  local session_dir="$HOME/.claude/sandbox/sessions/$instance_id"
  if [[ -d "$session_dir" ]]; then
    local session_size
    session_size="$(du -sh "$session_dir" 2>/dev/null | cut -f1)"
    echo "Session:  $session_size"
  else
    echo "Session:  no data"
  fi

  if command -v gh &>/dev/null; then
    local pr_status
    pr_status="$(gh pr list --repo "$(git -C "$repo_path" remote get-url origin 2>/dev/null)" --head "$wt_branch" --state all --json state,number,title --jq '.[0] | "\(.state) — #\(.number) \(.title)"' 2>/dev/null || true)"
    if [[ -n "$pr_status" ]]; then
      echo "PR:       $pr_status"
    else
      echo "PR:       none found"
    fi
  fi
}
