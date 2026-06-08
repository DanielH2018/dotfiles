#!/usr/bin/env bash
# Claude Code status line — mirrors Starship gruvbox_dark theme
# Colors (256-color approximate for gruvbox_dark):
#   color_orange  #d65d0e → 166
#   color_yellow  #d79921 → 136
#   color_aqua    #689d6a → 71
#   color_blue    #458588 → 66
#   color_bg1     #3c3836 → 237
#   color_fg0     #fbf1c7 → 230

input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd')
model=$(echo "$input" | jq -r '.model.display_name // .model.id // "Claude"')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Shorten path: replace $HOME with ~, then truncate to last 3 segments
home="$HOME"
short_cwd="${cwd/#$home/\~}"
# Keep last 3 path segments
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

# Build output with ANSI colors dimmed (status line renders dim by default)
# Segment: directory (yellow bg)
printf '\033[38;5;136m %s \033[0m' "$short_cwd"

# Segment: git branch (aqua) + dirty indicator
if [[ -n "$git_branch" ]]; then
  dirty_count=$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if (( dirty_count > 0 )); then
    printf '\033[38;5;71m  %s \033[38;5;166m*%d \033[0m' "$git_branch" "$dirty_count"
  else
    printf '\033[38;5;71m  %s \033[0m' "$git_branch"
  fi
fi

# Segment: model (blue)
printf '\033[38;5;66m %s \033[0m' "$model"

# Segment: context usage
if [[ -n "$used_pct" ]]; then
  used_int=$(printf '%.0f' "$used_pct")
  # Color: green < 70%, yellow 70-89%, red >= 90%
  if (( used_int >= 90 )); then
    printf '\033[38;5;167mctx:%d%% \033[0m' "$used_int"
  elif (( used_int >= 70 )); then
    printf '\033[38;5;136mctx:%d%% \033[0m' "$used_int"
  else
    printf '\033[38;5;71mctx:%d%% \033[0m' "$used_int"
  fi
fi
