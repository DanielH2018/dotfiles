#!/usr/bin/env bash
# Claude Code status line — mirrors Starship gruvbox_dark theme
# Colors (256-color approximate for gruvbox_dark):
#   color_orange  #d65d0e → 166
#   color_yellow  #d79921 → 136
#   color_aqua    #689d6a → 71
#   color_blue    #458588 → 66
#   color_purple  #b16286 → 132
#   color_bg1     #3c3836 → 237
#   color_fg0     #fbf1c7 → 230

# Single jq call to extract all fields at once (avoids fork overhead)
eval "$(cat | jq -r '[
  "cwd=\(.workspace.current_dir // .cwd // "" | @sh)",
  "model_id=\(.model.id // "" | @sh)",
  "model_name=\(.model.display_name // .model.id // "Claude" | @sh)",
  "used_pct=\(.context_window.used_percentage // "" | @sh)",
  "session_name=\(.session_name // "" | @sh)",
  "vim_mode=\(.vim.mode // "" | @sh)",
  "worktree_name=\(.worktree.name // .workspace.git_worktree // "" | @sh)",
  "five_pct=\(.rate_limits.five_hour.used_percentage // "" | @sh)",
  "week_pct=\(.rate_limits.seven_day.used_percentage // "" | @sh)",
  "total_cost=\(.cost.total // "" | @sh)"
] | .[]')"

# Shorten model name to a compact label
case "$model_id" in
  *opus*-4-6*|*opus*-4.6*)    model_label="opus4.6" ;;
  *opus*-4-5*|*opus*-4.5*)    model_label="opus4.5" ;;
  *opus*-4*)                  model_label="opus4" ;;
  *opus*)                     model_label="opus" ;;
  *sonnet*-4-6*|*sonnet*-4.6*)  model_label="sonnet4.6" ;;
  *sonnet*-4-5*|*sonnet*-4.5*)  model_label="sonnet4.5" ;;
  *sonnet*-4*)                model_label="sonnet4" ;;
  *sonnet*)                   model_label="sonnet" ;;
  *haiku*)                    model_label="haiku" ;;
  *)                          model_label="$model_name" ;;
esac

# Shorten path: replace $HOME with ~, then truncate to last 3 segments
home="$HOME"
short_cwd="${cwd/#$home/\~}"
short_cwd=$(echo "$short_cwd" | awk -F'/' '{
  n = NF
  if (n <= 3) { print $0 }
  else { print "…/" $(n-2) "/" $(n-1) "/" $n }
}')

# Git branch from cwd — use `git -C` only (no --git-dir) so it works in worktrees too
git_branch=""
if git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null \
               || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
fi

# Build output

# Segment: vim mode (purple) — only shown when vim mode is active
[[ -n "$vim_mode" ]] && printf '\033[38;5;132m %s \033[0m' "$vim_mode"

# Segment: session name (orange) — only shown when renamed
[[ -n "$session_name" ]] && printf '\033[38;5;166m %s \033[0m' "$session_name"

# Segment: directory (yellow)
printf '\033[38;5;136m %s \033[0m' "$short_cwd"

# Segment: worktree name (purple) — only shown in linked worktrees
[[ -n "$worktree_name" ]] && printf '\033[38;5;132m ⎇ %s \033[0m' "$worktree_name"

# Segment: git branch (aqua) + dirty indicator + ahead/behind
# Cache git status for 3 seconds to avoid repeated forks on rapid redraws
if [[ -n "$git_branch" ]]; then
  _git_cache="${TMPDIR:-/tmp}/.claude-statusline-git-${cwd//\//_}"
  _cache_age=999
  [[ -f "$_git_cache" ]] && _cache_age=$(( $(date +%s) - $(stat -f%m "$_git_cache" 2>/dev/null || stat -c%Y "$_git_cache" 2>/dev/null || echo 0) ))
  if [[ $_cache_age -gt 3 ]]; then
    dirty_count=$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    ab=$(git -C "$cwd" rev-list --left-right --count HEAD...@{upstream} 2>/dev/null)
    ahead=0 behind=0
    if [[ -n "$ab" ]]; then
      read -r ahead behind <<< "$ab"
    fi
    printf '%s %s %s' "$dirty_count" "$ahead" "$behind" > "$_git_cache"
  else
    read -r dirty_count ahead behind < "$_git_cache"
  fi
  printf '\033[38;5;71m  %s\033[0m' "$git_branch"
  (( dirty_count > 0 )) && printf '\033[38;5;166m *%d\033[0m' "$dirty_count"
  (( ahead > 0 )) && printf '\033[38;5;71m +%d\033[0m' "$ahead"
  (( behind > 0 )) && printf '\033[38;5;167m -%d\033[0m' "$behind"
  printf ' '
fi

# Segment: model (blue) — compact label
printf '\033[38;5;66m %s \033[0m' "$model_label"

# Segment: context usage
if [[ -n "$used_pct" ]]; then
  used_int=$(printf '%.0f' "$used_pct")
  if (( used_int >= 90 )); then
    printf '\033[38;5;167mctx:%d%% \033[0m' "$used_int"
  elif (( used_int >= 70 )); then
    printf '\033[38;5;136mctx:%d%% \033[0m' "$used_int"
  else
    printf '\033[38;5;71mctx:%d%% \033[0m' "$used_int"
  fi
fi

# Segment: rate limits (yellow/red) — only shown when populated (Claude.ai subscription)
rate_out=""
if [[ -n "$five_pct" ]]; then
  five_int=$(printf '%.0f' "$five_pct")
  if (( five_int >= 80 )); then
    rate_out="${rate_out}\033[38;5;167m5h:${five_int}%\033[0m "
  else
    rate_out="${rate_out}\033[38;5;136m5h:${five_int}%\033[0m "
  fi
fi
if [[ -n "$week_pct" ]]; then
  week_int=$(printf '%.0f' "$week_pct")
  if (( week_int >= 80 )); then
    rate_out="${rate_out}\033[38;5;167m7d:${week_int}%\033[0m "
  else
    rate_out="${rate_out}\033[38;5;136m7d:${week_int}%\033[0m "
  fi
fi
[[ -n "$rate_out" ]] && printf '%b' "$rate_out"

# Segment: session cost (grey, yellow >$5, red >$15)
if [[ -n "$total_cost" ]]; then
  cost_fmt=$(printf '$%.2f' "$total_cost")
  cost_cents=$(printf '%.0f' "$(echo "$total_cost * 100" | bc 2>/dev/null || echo 0)")
  if (( cost_cents >= 1500 )); then
    printf '\033[38;5;167m%s \033[0m' "$cost_fmt"
  elif (( cost_cents >= 500 )); then
    printf '\033[38;5;136m%s \033[0m' "$cost_fmt"
  else
    printf '\033[38;5;237m%s \033[0m' "$cost_fmt"
  fi
fi
exit 0
