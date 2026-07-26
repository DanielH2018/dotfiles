#!/usr/bin/env bash
# shellcheck disable=SC2154  # all data vars (cwd, model_id, …) are assigned by the eval'd jq block below
# Claude Code status line — mirrors the Starship catppuccin_mocha theme, which is the
# terminal's own (chezmoi `.chezmoidata/terminal.toml`). 24-bit, not 256-color: the old
# codes were documented as "approximate", and the terminal renders truecolor, so the
# statusline can hit the exact palette every other surface uses.
#   peach    #fab387 → 250;179;135   session name, dirty count
#   yellow   #f9e2af → 249;226;175   path, warning thresholds
#   green    #a6e3a1 → 166;227;161   git branch, ahead, healthy
#   blue     #89b4fa → 137;180;250   model label
#   mauve    #cba6f7 → 203;166;247   vim mode, worktree
#   red      #f38ba8 → 243;139;168   behind, over-threshold
#   overlay0 #6c7086 → 108;112;134   dim: effort, low cost, duration

# Single jq call to extract all fields at once (avoids fork overhead)
eval "$(cat | jq -r '[
  "cwd=\(.workspace.current_dir // .cwd // "" | @sh)",
  "model_id=\(.model.id // "" | @sh)",
  "model_name=\(.model.display_name // .model.id // "Claude" | @sh)",
  "used_pct=\(.context_window.used_percentage // "" | @sh)",
  "ctx_tokens=\(.context_window.total_input_tokens // "" | @sh)",
  "ctx_size=\(.context_window.context_window_size // "" | @sh)",
  "session_name=\(.session_name // "" | @sh)",
  "vim_mode=\(.vim.mode // "" | @sh)",
  "worktree_name=\(.worktree.name // .workspace.git_worktree // "" | @sh)",
  "effort_level=\(.effort.level // "" | @sh)",
  "five_pct=\(.rate_limits.five_hour.used_percentage // "" | @sh)",
  "week_pct=\(.rate_limits.seven_day.used_percentage // "" | @sh)",
  "total_cost=\(.cost.total_cost_usd // .cost.total // "" | @sh)",
  "transcript_path=\(.transcript_path // "" | @sh)",
  "session_id=\(.session_id // "" | @sh)",
  "lines_added=\(.cost.total_lines_added // "" | @sh)",
  "lines_removed=\(.cost.total_lines_removed // "" | @sh)",
  "dur_ms=\(.cost.total_duration_ms // "" | @sh)"
] | .[]')"

# Shorten model name to a compact label. Derived from the id rather than enumerated, so a release
# this script has never heard of (claude-opus-6, claude-sonnet-5-2, …) still labels itself.
# A trailing date stamp (claude-haiku-4-5-20251001) and bare years are not version parts: the
# version match requires 1-2 digit groups ending at a "-" or end-of-string, so "20251001" and
# "2025" both fail to match and are ignored rather than becoming "haiku202".
model_label="$model_name"
if [[ "$model_id" =~ (opus|sonnet|haiku|fable|mythos) ]]; then
  model_family="${BASH_REMATCH[1]}"
  model_rest="${model_id#*"$model_family"}"
  model_ver=""
  if [[ "$model_rest" =~ ^-([0-9]{1,2})(-([0-9]{1,2}))?(-|$) ]]; then
    model_ver="${BASH_REMATCH[1]}"
    [[ -n "${BASH_REMATCH[3]}" ]] && model_ver="${model_ver}.${BASH_REMATCH[3]}"
  fi
  model_label="${model_family}${model_ver}"
fi

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
[[ -n "$vim_mode" ]] && printf '\033[38;2;203;166;247m %s \033[0m' "$vim_mode"

# Segment: session name (orange) — only shown when renamed
[[ -n "$session_name" ]] && printf '\033[38;2;250;179;135m %s \033[0m' "$session_name"

# Segment: directory (yellow)
printf '\033[38;2;249;226;175m %s \033[0m' "$short_cwd"

# Segment: worktree name (purple) — only shown in linked worktrees
[[ -n "$worktree_name" ]] && printf '\033[38;2;203;166;247m ⎇ %s \033[0m' "$worktree_name"

# Segment: git branch (aqua) + dirty indicator + ahead/behind
# Cache git status for 3 seconds to avoid repeated forks on rapid redraws
if [[ -n "$git_branch" ]]; then
  _git_cache="${TMPDIR:-/tmp}/.claude-statusline-git-${cwd//\//_}"
  _cache_age=999
  [[ -f "$_git_cache" ]] && _cache_age=$(( $(date +%s) - $(stat -f%m "$_git_cache" 2>/dev/null || stat -c%Y "$_git_cache" 2>/dev/null || echo 0) ))
  if [[ $_cache_age -gt 3 ]]; then
    dirty_count=$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    ab=$(git -C "$cwd" rev-list --left-right --count "HEAD...@{upstream}" 2>/dev/null)
    ahead=0 behind=0
    if [[ -n "$ab" ]]; then
      read -r ahead behind <<< "$ab"
    fi
    printf '%s %s %s' "$dirty_count" "$ahead" "$behind" > "$_git_cache"
  else
    read -r dirty_count ahead behind < "$_git_cache"
  fi
  printf '\033[38;2;166;227;161m  %s\033[0m' "$git_branch"
  (( dirty_count > 0 )) && printf '\033[38;2;250;179;135m *%d\033[0m' "$dirty_count"
  (( ahead > 0 )) && printf '\033[38;2;166;227;161m +%d\033[0m' "$ahead"
  (( behind > 0 )) && printf '\033[38;2;243;139;168m -%d\033[0m' "$behind"
  printf ' '
fi

# Segment: model (blue) — compact label
printf '\033[38;2;137;180;250m %s \033[0m' "$model_label"

# Segment: effort level (dim grey) — only shown when set and non-default (medium)
[[ -n "$effort_level" && "$effort_level" != "medium" ]] && printf '\033[38;2;108;112;134m %s \033[0m' "$effort_level"

# Segment: context usage
#
# The CLI's own used_percentage divides by context_window_size, which it derives from a compiled
# model table. Any model missing from that table falls back to 200000 — claude-opus-5 is absent
# in 2.1.218, so 1M-window sessions pin at ctx:100% once past 200k tokens while the real usage is
# a fifth of that. Recompute from the raw token count against the model's actual window, and
# colour against the point where compaction really fires rather than a fixed 70/90.
ctx_window=""
case "$model_id" in
  *'[1m]'*)                                        ctx_window=1000000 ;;
  *opus-5*|*sonnet-5*|*fable-5*|*mythos-5*)        ctx_window=1000000 ;;
  *opus-4-7*|*opus-4-8*)                           ctx_window=1000000 ;;
  *claude-3-*|*haiku-4-5*|*sonnet-4-*|*opus-4-*)   ctx_window=200000 ;;
esac

# Unknown model — i.e. a release newer than both this script and the CLI's own table. Its
# context_window_size is then the CLI's 200000 fallback and can't be trusted. A request can never
# exceed its real window, so an observed token count above the declared size is proof the size is
# understated; escalate on that proof rather than guessing a window up front. Escalations are
# remembered per model id so the correction holds from token 0 in later sessions, instead of the
# bar having to re-cross 200k every time.
ctx_cache="${XDG_CACHE_HOME:-$HOME/.cache}/claude-statusline/context-windows"
if [[ -z "$ctx_window" ]]; then
  ctx_window="$ctx_size"
  if [[ -n "$model_id" && -r "$ctx_cache" ]]; then
    learned=$(awk -F'\t' -v m="$model_id" '$1==m{w=$2} END{if (w) print w}' "$ctx_cache" 2>/dev/null)
    if [[ "$learned" =~ ^[0-9]+$ ]] && (( learned > ${ctx_window:-0} )); then
      ctx_window="$learned"
    fi
  fi
  if [[ -n "$ctx_tokens" && -n "$ctx_window" ]] && (( ctx_tokens > ctx_window )); then
    while (( ctx_tokens > ctx_window )); do
      if   (( ctx_window < 200000 ));  then ctx_window=200000
      elif (( ctx_window < 1000000 )); then ctx_window=1000000
      else ctx_window=$(( ctx_window * 2 ))
      fi
    done
    if [[ -n "$model_id" ]] && mkdir -p "${ctx_cache%/*}" 2>/dev/null; then
      printf '%s\t%s\n' "$model_id" "$ctx_window" >> "$ctx_cache" 2>/dev/null
    fi
  fi
fi

used_int=""
if [[ -n "$ctx_tokens" && -n "$ctx_window" ]] && (( ctx_window > 0 )); then
  used_int=$(( ctx_tokens * 100 / ctx_window ))
  (( used_int > 100 )) && used_int=100
elif [[ -n "$used_pct" ]]; then
  used_int=$(printf '%.0f' "$used_pct")
fi

if [[ -n "$used_int" ]]; then
  # Auto-compaction triggers at min(pct_override%, budget-13000) where budget is the window less
  # a 20k output reserve. The window it compacts against is min(real window,
  # CLAUDE_CODE_AUTO_COMPACT_WINDOW) — the bar is still drawn against the real window, so
  # derive the threshold from the former and express it as a fraction of the latter, or red
  # lands at the wrong place. Below ~33k the reserves swamp the budget; fall back to a flat 90.
  compact_pct=90
  ctx_compact_window="$ctx_window"
  if [[ "${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-}" =~ ^[0-9]+$ && -n "$ctx_window" ]] \
     && (( CLAUDE_CODE_AUTO_COMPACT_WINDOW > 0 && CLAUDE_CODE_AUTO_COMPACT_WINDOW < ctx_window )); then
    ctx_compact_window="$CLAUDE_CODE_AUTO_COMPACT_WINDOW"
  fi
  if [[ -n "$ctx_window" ]] && (( ctx_compact_window > 33000 )); then
    ctx_budget=$(( ctx_compact_window - 20000 ))
    compact_at=$(( ctx_budget - 13000 ))
    if [[ "${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:-}" =~ ^[0-9]+$ ]] \
       && (( CLAUDE_AUTOCOMPACT_PCT_OVERRIDE > 0 && CLAUDE_AUTOCOMPACT_PCT_OVERRIDE <= 100 )); then
      by_pct=$(( ctx_budget * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE / 100 ))
      (( by_pct < compact_at )) && compact_at=$by_pct
    fi
    compact_pct=$(( compact_at * 100 / ctx_window ))
  fi
  if (( used_int >= compact_pct )); then
    printf '\033[38;2;243;139;168mctx:%d%% \033[0m' "$used_int"
  elif (( used_int >= compact_pct * 85 / 100 )); then
    printf '\033[38;2;249;226;175mctx:%d%% \033[0m' "$used_int"
  else
    printf '\033[38;2;166;227;161mctx:%d%% \033[0m' "$used_int"
  fi
fi

# Segment: prompt-cache expiry countdown — TTL tier auto-detected from the transcript
# (ephemeral_1h vs ephemeral_5m cache_creation buckets). Hidden once the cache is cold.
tp="$transcript_path"
if [[ -z "$tp" && -n "$session_id" ]]; then
  # shellcheck disable=SC2012  # <session_id>.jsonl names are fixed-charset; ls|head just picks the first match
  tp=$(ls -1 "$HOME"/.claude/projects/*/"$session_id".jsonl 2>/dev/null | head -1)
fi
if [[ -n "$tp" && -r "$tp" ]]; then
  # tail-read a bounded window (≤320KB) and drop the possibly-partial first line
  cache_meta=$(tail -c 320000 "$tp" 2>/dev/null | tail -n +2 | jq -rs '
    [ .[] | select(.type == "assistant") ] as $a
    | if ($a | length) == 0 then empty
      else
        ($a[-1].timestamp) as $ts
        | ([ $a[] | .message.usage.cache_creation // {} ]) as $ccs
        | (if   any($ccs[]; (.ephemeral_1h_input_tokens // 0) > 0) then 3600
           elif any($ccs[]; (.ephemeral_5m_input_tokens // 0) > 0) then 300
           else 0 end) as $ttl
        | if $ttl == 0 then empty else "\($ts)|\($ttl)" end
      end' 2>/dev/null)
  if [[ -n "$cache_meta" ]]; then
    ts="${cache_meta%|*}"; ttl="${cache_meta#*|}"
    ts_epoch=$(date -d "$ts" +%s 2>/dev/null)
    if [[ -n "$ts_epoch" ]]; then
      now=$(date +%s)
      remain=$(( ttl - (now - ts_epoch) ))
      if (( remain > 0 )); then
        if (( remain >= 60 )); then cstr=$(printf '%dm%ds' $((remain/60)) $((remain%60)))
        else cstr=$(printf '%ds' "$remain"); fi
        (( remain < 60 )) && ccol='249;226;175' || ccol='166;227;161'
        printf '\033[38;2;%sm cache %s \033[0m' "$ccol" "$cstr"
      fi
    fi
  fi
fi

# Segment: rate limits (yellow/red) — only shown when populated (Claude.ai subscription)
rate_out=""
if [[ -n "$five_pct" ]]; then
  five_int=$(printf '%.0f' "$five_pct")
  if (( five_int >= 80 )); then
    rate_out="${rate_out}\033[38;2;243;139;168m5h:${five_int}%\033[0m "
  else
    rate_out="${rate_out}\033[38;2;249;226;175m5h:${five_int}%\033[0m "
  fi
fi
if [[ -n "$week_pct" ]]; then
  week_int=$(printf '%.0f' "$week_pct")
  if (( week_int >= 80 )); then
    rate_out="${rate_out}\033[38;2;243;139;168m7d:${week_int}%\033[0m "
  else
    rate_out="${rate_out}\033[38;2;249;226;175m7d:${week_int}%\033[0m "
  fi
fi
[[ -n "$rate_out" ]] && printf '%b' "$rate_out"

# Segment: session cost (grey, yellow >$5, red >$15)
if [[ -n "$total_cost" ]]; then
  cost_fmt=$(printf '$%.2f' "$total_cost")
  cost_cents=$(printf '%.0f' "$(echo "$total_cost * 100" | bc 2>/dev/null || echo 0)")
  if (( cost_cents >= 1500 )); then
    printf '\033[38;2;243;139;168m%s \033[0m' "$cost_fmt"
  elif (( cost_cents >= 500 )); then
    printf '\033[38;2;249;226;175m%s \033[0m' "$cost_fmt"
  else
    printf '\033[38;2;108;112;134m%s \033[0m' "$cost_fmt"
  fi
fi

# Segment: lines changed (+added aqua / -removed red) — only when non-zero
la=${lines_added:-0}; lr=${lines_removed:-0}
if (( la > 0 || lr > 0 )); then
  printf '\033[38;2;166;227;161m+%d\033[0m/\033[38;2;243;139;168m-%d\033[0m ' "$la" "$lr"
fi

# Segment: session duration (dim grey)
if [[ -n "$dur_ms" ]]; then
  dur_s=$(( ${dur_ms%.*} / 1000 ))
  if   (( dur_s >= 3600 )); then dstr=$(printf '%dh%dm' $((dur_s/3600)) $(((dur_s%3600)/60)))
  elif (( dur_s >= 60 ));   then dstr=$(printf '%dm' $((dur_s/60)))
  else dstr=$(printf '%ds' "$dur_s"); fi
  printf '\033[38;2;108;112;134m%s \033[0m' "$dstr"
fi
exit 0
