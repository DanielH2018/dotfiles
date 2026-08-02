#!/usr/bin/env bash
# sandbox-compact.sh — archive a finished session's transcript into the vault,
# sourced by claude-sandbox (lives in ~/.claude/sandbox). Sourced, not executed:
# define functions only, never run anything at load time or set shell options here.
#
# CONTRACT — closer to the pure end than its sibling libs, but not all the way.
# compact_session takes its three inputs as arguments (instance id, repo name,
# worktree name) rather than reading them from the launcher, writes no launcher
# globals, and never calls exit. What it does still need from the environment:
# SANDBOX_DIR and SESSIONS_BASE to find the session, REPO_PATH, CLAUDE_VAULT_DIR
# for the archive destination, and ANTHROPIC_API_KEY / ANTHROPIC_ADMIN_API_KEY,
# which it passes to the summariser.
#
# The work itself is done by compact-session.py next to this file; this is the
# shell around it — locating the transcript, deciding whether there is anything
# worth archiving, and placing the result. delete_worktree() calls it with `|| true`
# because a failed archive must never block removing a worktree.

# --- Session compaction ---
compact_session() {
  # Usage: compact_session <instance-id> <repo-name> <worktree-name>
  local instance_id="$1"
  local repo_name="$2"
  local wt_name="$3"
  local session_dir="$SESSIONS_BASE/$instance_id"
  local vault_dir
  if [ -n "${CLAUDE_VAULT_DIR:-}" ]; then
    vault_dir="$CLAUDE_VAULT_DIR/Work/Sessions/$repo_name"
  else
    vault_dir="$HOME/.claude/sandbox-sessions/$repo_name"
  fi
  local today
  today="$(date -u +%Y-%m-%d)"

  if [[ ! -d "$session_dir" ]]; then
    echo "  No session data for $instance_id — skipping compaction."
    return 0
  fi

  echo "  Compacting session $instance_id..."

  # Stage 1: Mechanical extraction
  local extract_json
  extract_json="$(mktemp "${TMPDIR:-/tmp}/compact-XXXXXX")"
  if ! python3 "$SANDBOX_DIR/compact-session.py" extract "$session_dir" \
      --repo-path="$REPO_PATH" --branch="claude/$wt_name" > "$extract_json" 2>/dev/null; then
    echo "  Warning: extraction failed for $instance_id — skipping compaction."
    rm -f "$extract_json"
    return 0
  fi

  # Check if extraction returned an error
  if python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if 'error' not in d else 1)" "$extract_json" 2>/dev/null; then
    : # no error
  else
    echo "  Warning: no session data found for $instance_id — skipping compaction."
    rm -f "$extract_json"
    return 0
  fi

  # Stage 2: API summarization (conditional)
  local user_count
  user_count="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('user_count',0))" "$extract_json")"

  local api_key="${ANTHROPIC_API_KEY:-${ANTHROPIC_ADMIN_API_KEY:-}}"
  local final_json="$extract_json"

  if [[ "$user_count" -gt 50 && -n "$api_key" ]]; then
    echo "  Large session ($user_count messages) — generating API summary..."
    local summarized_json
    summarized_json="$(mktemp "${TMPDIR:-/tmp}/compact-summary-XXXXXX")"
    if python3 "$SANDBOX_DIR/compact-session.py" summarize "$extract_json" \
        --api-key="$api_key" > "$summarized_json" 2>/dev/null; then
      final_json="$summarized_json"
    else
      echo "  Warning: API summarization failed — using mechanical summary."
    fi
  elif [[ "$user_count" -gt 50 && -z "$api_key" ]]; then
    echo "  No API key — using mechanical summary."
  fi

  # Generate vault markdown
  mkdir -p "$vault_dir"
  local vault_file="$vault_dir/${wt_name}_${today}.md"

  # Handle duplicate filenames
  if [[ -f "$vault_file" ]]; then
    local counter=2
    while [[ -f "${vault_dir}/${wt_name}_${today}_${counter}.md" ]]; do
      counter=$((counter + 1))
    done
    vault_file="${vault_dir}/${wt_name}_${today}_${counter}.md"
  fi

  local one_line
  one_line="$(python3 "$SANDBOX_DIR/compact-session.py" render \
    "$final_json" "$repo_name" "$wt_name" "$vault_file")"

  # Update sessions index
  local index_file="$vault_dir/_Index.md"
  if [[ ! -f "$index_file" ]]; then
    cat > "$index_file" <<IDXEOF
---
title: "Sessions — $repo_name"
summary: Index of archived Claude Code sessions for $repo_name
tags: [sessions, $repo_name, index]
created: $today
updated: $today
---

| Date | Worktree | Summary | Link |
|------|----------|---------|------|
IDXEOF
  fi

  local file_basename
  file_basename="$(basename "$vault_file" .md)"

  # Append row to index (insert after the header row). `-i.bak` is the portable
  # in-place form: BSD sed needs a suffix arg, GNU reads a bare '' as the script.
  sed -i.bak "/^|------|/a\\
| $today | $wt_name | $one_line | [[$file_basename]] |
" "$index_file"

  # Update the updated date in index frontmatter
  sed -i.bak "s/^updated: .*/updated: $today/" "$index_file"
  rm -f "$index_file.bak"

  echo "  Archived to $(basename "$vault_file")"

  # Clean up temp files. `if`, not `[[ … ]] &&`: as the last statement of the
  # function that form returns 1 whenever no API summary was written — the common
  # path — making a successful compaction look like a failure to any caller that
  # doesn't already absorb it with `|| true`.
  rm -f "$extract_json"
  if [[ "$final_json" != "$extract_json" ]]; then
    rm -f "$final_json"
  fi
}
