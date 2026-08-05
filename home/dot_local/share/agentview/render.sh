# shellcheck shell=bash
# agentview · render — the palette and everything that turns the global `rows` into the
# grouped, colored fzf list: pin/state bucketing, per-row layout, the group headers.
# Sourced by ~/.local/bin/agentview; needs rows (gather_*) and common (title lookups).
# SC2154/SC2034: globals cross the module boundary in both directions — the loader assigns
# what this reads, and the palette below is consumed by its siblings. SC1087: `$E[` builds
# an ANSI escape, not an array index.
# shellcheck disable=SC2154,SC2034,SC1087

# ---- palette (Catppuccin Mocha, truecolor) ----
E=$'\033'; Z="$E[0m"
C_NEED="$E[38;2;249;226;175m"          # yellow  — needs input
C_WORK="$E[38;2;166;227;161m"          # green   — working
C_REVIEW="$E[38;2;250;179;135m"        # peach   — review (stopped, but dirty/unpushed)
C_DONE="$E[38;2;108;112;134m"          # overlay0 — completed / idle
C_DIM="$E[38;2;127;132;156m"           # overlay1 — "claude ·"
C_BOLD="$E[1m"                         # bold prefix — group headers + names render bold+state
C_PIN="$E[38;2;203;166;247m"           # mauve — PINNED group accent (★)
GBAR=$'▎'                         # ▎ left accent rule — state-colored, runs down each group
BADGEBG="$E[48;2;69;71;90m"            # surface1 — machine chip background
BADGEFG="$E[38;2;69;71;90m"            # surface1 as FG — colors the pill's rounded end-caps
PILL_L=$''; PILL_R=$''     # powerline half-circles — round the source badge into a box
# Single-source the state→accent map and the empty-state row so the two render paths
# (render_body + interactive picker) can't drift — they had: one used an extra leading
# tab, mis-offsetting the "no sessions" row against fzf's --with-nth=2.. delimiter.
state_color() {  # set $_scol to a state group's accent (a function call, no per-row fork)
  case "$1" in needs-input) _scol="$C_NEED";; working) _scol="$C_WORK";; review) _scol="$C_REVIEW";; *) _scol="$C_DONE";; esac
}
row_pinned() {  # sets $_pinned=1/0 for $1=host $2=cwd $3=kind $4=locator (reads PINNED_SET
  # via dynamic scope from build_pretty). No fork — runs per row on the render path.
  local _pid
  compute_pin_id "$1" "$2" "$3" "$4"
  [ -n "${PINNED_SET[$_pid]:-}" ] && _pinned=1 || _pinned=0
}
NO_SESSIONS_ROW=$'\t   '"${C_DONE}   no active Claude sessions — nothing running${Z}"
LABEL=$' ✳ claude sessions '      # ✳ Claude mark in the border title
PROMPT=$'  '                     # Nerd Font magnifier + gap (IosevkaTerm NFM)
declare -A GN=( [pinned]="PINNED" [needs-input]="NEEDS INPUT" [working]="WORKING" [review]="REVIEW" [completed]="COMPLETED" [idle]="IDLE" )

group_expanded() {  # $1 = group name -> true (0) if its rows should render in full.
  # completed/idle are the only foldable groups: the rest are what the picker exists to show.
  case "$1" in completed|idle) ;; *) return 0 ;; esac
  [ -r "$foldfile" ] && grep -qxF "$1" "$foldfile" 2>/dev/null
}

row_width() {  # sets _rw: usable row columns for the render + header alignment.
  # Inside a reload/execute child fzf exports FZF_COLUMNS (its own area, margin/padding
  # already excluded) — keep 2 for the pointer gutter. At the initial render (no fzf yet)
  # start from the terminal and discount fzf's chrome (2×2% margin + padding + border).
  # Floor of 40 keeps the pad/truncate math sane on tiny panes. Was a hardcoded 72, which
  # overran narrow panes (clipped names) and wasted wide ones.
  if [ -n "${FZF_COLUMNS:-}" ]; then _rw=$(( FZF_COLUMNS - 2 ))
  else
    _rw="${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}"
    _rw=$(( _rw - _rw * 4 / 100 - 6 ))
  fi
  [ "$_rw" -lt 40 ] && _rw=40
}

fmt_age() {  # $1 = epoch -> sets _age: compact "12m"/"3h"/"2d"; empty for unknown/zero ts
  local t=${1:-0} d; _age=""
  case "$t" in ''|*[!0-9]*) return;; esac
  [ "$t" -le 0 ] && return
  d=$(( now - t )); [ "$d" -lt 0 ] && d=0
  if   [ "$d" -lt 60 ];    then _age="${d}s"
  elif [ "$d" -lt 3600 ];  then _age="$((d/60))m"
  elif [ "$d" -lt 86400 ]; then _age="$((d/3600))h"
  else _age="$((d/86400))d"; fi
}

badge_name() {  # $1 = host -> sets _bn: friendly machine tag (from HOST_LABEL)
  host_label "$1"; _bn="$_hl"
}

# Bound to REAP_GRACE (rows.sh), not a second 120 -- one staleness constant for the
# whole picker. Every render-capable mode's _avmods sources rows before render, so
# REAP_GRACE is already set; the :-120 fallback only guards a future load-order change,
# it is not the normal path. Do not replace this with a literal.
AV_STALE_AFTER="${REAP_GRACE:-120}"

host_status_rows() {  # print one keyless row per host that isn't currently healthy
  # (or is healthy but stale), so a dead/slow remote reads as signage, not silence.
  # Keyless: `printf '\t...'` gives every row an empty KEY, the same treatment group
  # headers get, so the --skip cursor logic steps over these rather than landing on them.
  local host status outcome when age lbl
  while IFS= read -r host; do
    status="$(remote_status_for "$host")"
    [ -r "$status" ] || continue
    IFS=$'\t' read -r outcome when < "$status" || continue
    host_label "$host"; lbl="$_hl"
    case "$outcome" in
      unreachable) printf '\t  %s · unreachable\n' "$lbl" ;;
      failed)      printf '\t  %s · fetch failed\n' "$lbl" ;;
      ok)
        # A corrupt status file (partial write, disk error) can carry a non-numeric epoch;
        # under `set -u` the bare arithmetic below would abort the whole render. Mirror
        # fmt_age's own guard and treat garbage as maximally stale, so it still surfaces.
        case "$when" in ''|*[!0-9]*) when=0;; esac
        age=$(( now - when ))
        [ "$age" -gt "$AV_STALE_AFTER" ] && { fmt_age "$when"; printf '\t  %s · %s old\n' "$lbl" "$_age"; }
        ;;
    esac
  done < <(remote_hosts)
}

gc_pins() {  # drop pins whose session no longer exists anywhere (a local file OR the remote
  # cache) — orphans left when a session ends, is pruned (7-day / dead-pid), or is CTRL+X'd,
  # plus the "a new session in the same cwd inherits a stale locator-less pin" mispin. Runs each
  # render AFTER the prune, reconciling the sidecar against current state. No-op (one stat) when
  # nothing is pinned. jq over valid session JSON doesn't error, so a wrongly-emptied set is only
  # reachable when there genuinely are no sessions — in which case every pin IS an orphan.
  [ -s "$pinfile" ] || return
  local live tmp="$pinfile.tmp.$$" lf host cache
  shopt -s nullglob; lf=( "$statedir"/*.json ); shopt -u nullglob
  live=""
  [ "${#lf[@]}" -gt 0 ] && live=$(jq -r "$JQ_PINID" "${lf[@]}" 2>/dev/null)
  while IFS= read -r host; do
    cache="$(remote_cache_for "$host")"
    [ -s "$cache" ] && live="$live"$'\n'"$(MSYS_NO_PATHCONV=1 jq -r "$JQ_PINID" < "$cache" 2>/dev/null)"
  done < <(remote_hosts)
  if [ -n "$live" ]; then printf '%s\n' "$live" | grep -Fxf - "$pinfile" > "$tmp" 2>/dev/null
  else : > "$tmp"; fi
  mv -f "$tmp" "$pinfile" 2>/dev/null || rm -f "$tmp" 2>/dev/null
}

loc_rank() {  # sets _lr = jump quality of locator $1: real pane 2 > bg attach 1 > none 0
  case "$1" in
    tmux:?*|wezterm:?*) _lr=2 ;;
    bg:?*)              _lr=1 ;;
    *)                  _lr=0 ;;   # none: / empty / bg: with no job
  esac
}

collapse_bg_forks() {  # merge a bg daemon row with its interactive origin into one row.
  # Backgrounding a session spawns a bg job that inherits the task title but gets a fresh
  # session id with NO lineage link (session files carry no parent field), so the origin and
  # the fork render as two same-named rows. Correlate on host+cwd+title, using REAL titles
  # only — an auto name ("<leaf>-<2 hex>") is not a shared task identity, so those never
  # merge. Collapse only a group holding BOTH a bg and a non-bg member (two plain interactive
  # sessions that merely share a title stay separate); keep the base = freshest member but
  # adopt the best jump target across the pair (a live pane beats bg-attach beats none:) and
  # set kind to route <enter> accordingly. Rewrites global `rows`. Row = state<TAB>host<TAB>
  # cwd<TAB>pane<TAB>ts<TAB>kind<TAB>locator<TAB>title.
  local -A GROUP=()
  local pass="" L rest cwd title fwd leaf host
  while IFS= read -r L; do
    [ -z "$L" ] && continue
    rest="${L#*$'\t'}"                       # drop state
    host="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
    cwd="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
    rest="${rest#*$'\t'}"; rest="${rest#*$'\t'}"; rest="${rest#*$'\t'}"; rest="${rest#*$'\t'}"  # pane ts kind locator
    title="$rest"
    fwd="${cwd//\\//}"; fwd="${fwd%/}"; leaf="${fwd##*/}"
    # Not mergeable (no shared task identity): empty title, or Claude's auto "<leaf>-<2 hex>".
    if [ -z "$title" ] || [[ "$title" == "$leaf"-[0-9a-f][0-9a-f] ]]; then
      pass+="$L"$'\n'; continue
    fi
    GROUP["$host$US$cwd$US$title"]+="$L"$'\n'
  done <<< "$rows"
  local k members m mrest nbg nother base base_ts bestloc bestrank _lr
  local b_st b_host b_cwd b_pane b_ts b_kind b_loc b_title m_ts m_kind m_loc
  for k in "${!GROUP[@]}"; do
    members="${GROUP[$k]}"
    nbg=0; nother=0; base=""; base_ts=-1; bestloc=""; bestrank=-1
    while IFS= read -r m; do
      [ -z "$m" ] && continue
      mrest="${m#*$'\t'}"; mrest="${mrest#*$'\t'}"; mrest="${mrest#*$'\t'}"  # -> after host,cwd
      mrest="${mrest#*$'\t'}"                                                # -> after pane
      m_ts="${mrest%%$'\t'*}"; mrest="${mrest#*$'\t'}"
      m_kind="${mrest%%$'\t'*}"; mrest="${mrest#*$'\t'}"
      m_loc="${mrest%%$'\t'*}"
      [ "$m_kind" = "bg" ] && nbg=$((nbg+1)) || nother=$((nother+1))
      case "$m_ts" in ''|*[!0-9]*) m_ts=0;; esac
      [ "$m_ts" -gt "$base_ts" ] && { base_ts="$m_ts"; base="$m"; }
      loc_rank "$m_loc"; [ "$_lr" -gt "$bestrank" ] && { bestrank="$_lr"; bestloc="$m_loc"; }
    done <<< "$members"
    if [ "$nbg" -gt 0 ] && [ "$nother" -gt 0 ]; then
      b_st="${base%%$'\t'*}"; mrest="${base#*$'\t'}"
      b_host="${mrest%%$'\t'*}"; mrest="${mrest#*$'\t'}"
      b_cwd="${mrest%%$'\t'*}"; mrest="${mrest#*$'\t'}"
      b_pane="${mrest%%$'\t'*}"; mrest="${mrest#*$'\t'}"
      b_ts="${mrest%%$'\t'*}"; mrest="${mrest#*$'\t'}"
      b_kind="${mrest%%$'\t'*}"; mrest="${mrest#*$'\t'}"
      b_loc="${mrest%%$'\t'*}"; b_title="${mrest#*$'\t'}"
      case "$bestloc" in bg:*) b_kind="bg";; tmux:*|wezterm:*) b_kind="host";; esac
      pass+="$b_st"$'\t'"$b_host"$'\t'"$b_cwd"$'\t'"$b_pane"$'\t'"$b_ts"$'\t'"$b_kind"$'\t'"$bestloc"$'\t'"$b_title"$'\n'
    else
      pass+="$members"
    fi
  done
  rows="$pass"
}

build_pretty() {  # prints "KEY<TAB>COLORED-DISPLAY" per row, grouped; KEY carries the card fields
  local W BADGEW=7 grp st host cwd pane ts kind locator title_reg gitmark name title bn scol stext cnt key L _rest
  local bcell left_p left_c pad sp maxs bpad bfg first=1 fwd clabel
  local PINCNT=0 idx=0 g1 gutc _pinned _hp _leaf _par
  row_width; W=$_rw
  # Pinned rows collect into a PINNED group at the very top. Load the sidecar once into a
  # set, then in the tally below count pinned rows separately so a state group's header
  # count reflects only what still renders under it.
  local -A PINNED_SET=()
  gc_pins                                     # reconcile the sidecar against live sessions first
  if [ -f "$pinfile" ]; then
    while IFS= read -r _hp; do [ -n "$_hp" ] && PINNED_SET["$_hp"]=1; done < "$pinfile"
  fi
  # Sort every row by ts (desc) ONCE and tally per-state counts in pure bash, so the
  # group loop needs no per-group awk/sort — each of those was a process spawn, and
  # spawns dominate render time on Windows.
  local -a sorted; local -A GCNT=() NAMECNT=()
  mapfile -t sorted < <(printf '%s' "$rows" | sort -t$'\t' -k5,5nr)
  for L in "${sorted[@]}"; do
    st="${L%%$'\t'*}"; [ -z "$st" ] && continue
    _rest="${L#*$'\t'}"; host="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
    cwd="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
    _rest="${_rest#*$'\t'}"                       # skip pane
    _rest="${_rest#*$'\t'}"                       # skip ts
    kind="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
    locator="${_rest%%$'\t'*}"
    # Tally leaf names so the render can tell twins apart (same-named checkout on
    # another host / a worktree elsewhere) by prefixing the parent dir.
    fwd="${cwd//\\//}"; fwd="${fwd%/}"; _leaf="${fwd##*/}"; [ -z "$_leaf" ] && _leaf="$cwd"
    [ -n "$_leaf" ] && NAMECNT[$_leaf]=$(( ${NAMECNT[$_leaf]:-0} + 1 ))
    row_pinned "$host" "$cwd" "$kind" "$locator"
    if [ "$_pinned" = 1 ]; then PINCNT=$(( PINCNT + 1 )); else GCNT[$st]=$(( ${GCNT[$st]:-0} + 1 )); fi
  done
  for grp in pinned needs-input working review completed idle; do
    if [ "$grp" = pinned ]; then cnt=$PINCNT; else cnt=${GCNT[$grp]:-0}; fi
    [ "$cnt" -eq 0 ] && continue
    [ "$first" -eq 0 ] && printf '\t\n'   # blank spacer between groups (empty KEY = no-op on select)
    first=0
    if ! group_expanded "$grp"; then
      # Collapsed: this landable fold row REPLACES the usual keyless header (never reached
      # for "pinned" — group_expanded always returns true for it). A fold header must be
      # selectable to be expandable, so it carries a sentinel key (fold:<group>) rather than
      # an empty one — see the --skip dispatch in executable_agentview.
      printf 'fold:%s\t  %s (%s)\n' "$grp" "${GN[$grp]}" "$cnt"
      continue
    fi
    if [ "$grp" = pinned ]; then
      printf '\t%s%s%s %s★%s %s%s%s%s %s%s%s\n' "$C_PIN" "$GBAR" "$Z" "$C_PIN" "$Z" "$C_BOLD" "$C_PIN" "${GN[$grp]}" "$Z" "$C_DIM" "$cnt" "$Z"
    else
      state_color "$grp"; scol="$_scol"
      # An EXPANDED foldable group (completed/idle) still needs a landable key, the same
      # fold:<group> sentinel the collapsed header carries, so <enter> can re-collapse it.
      # The other three state headers can't be folded at all and stay keyless like spacers.
      case "$grp" in completed|idle) key="fold:$grp";; *) key="";; esac
      printf '%s\t%s%s%s %s●%s %s%s%s%s %s%s%s\n' "$key" "$scol" "$GBAR" "$Z" "$scol" "$Z" "$C_BOLD" "$scol" "${GN[$grp]}" "$Z" "$C_DIM" "$cnt" "$Z"
    fi
    for L in "${sorted[@]}"; do
      # Split on tab WITHOUT read's IFS-whitespace collapsing: sandbox rows have an
      # empty pane, and `IFS=$'\t' read` folds that empty field, shifting locator/title
      # out of place so do_jump reads the wrong KEY field. Parameter expansion keeps
      # empties. (@tsv already escaped any literal tabs in the values.)
      st="${L%%$'\t'*}"; _rest="${L#*$'\t'}"
      host="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
      cwd="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
      pane="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
      ts="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
      kind="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
      locator="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
      # Split title from the trailing git marker WITHOUT collapsing empties. A pre-git
      # 8-field row (no trailing tab) leaves _rest == title_reg -> no marker.
      title_reg="${_rest%%$'\t'*}"
      if [ "$_rest" = "$title_reg" ]; then gitmark=""; else gitmark="${_rest#*$'\t'}"; fi
      # Membership: the PINNED group takes every pinned row (in ts order); each state
      # group takes its own state MINUS anything already shown as pinned.
      row_pinned "$host" "$cwd" "$kind" "$locator"
      if [ "$grp" = pinned ]; then
        [ "$_pinned" = 1 ] || continue
      else
        { [ "$st" = "$grp" ] && [ "$_pinned" = 0 ]; } || continue
      fi
      fwd="${cwd//\\//}"; fwd="${fwd%/}"; name="${fwd##*/}"; [ -z "$name" ] && name="$cwd"
      # Two rows sharing a leaf name render identically — prefix the parent dir so
      # they stay tellable apart (full path remains in the CTRL+O card).
      if [ -n "$name" ] && [ "${NAMECNT[$name]:-0}" -gt 1 ]; then
        _par="${fwd%/*}"; _par="${_par##*/}"
        [ -n "$_par" ] && [ "$_par" != "$name" ] && name="$_par/$name"
      fi
      # Prefer a registry-supplied title (sandbox rows carry repo·branch); else the
      # mux-correlated pane title (host rows on wezterm). Tabs would split the columns.
      if [ -n "$title_reg" ]; then title="$title_reg"; else title_for_cwd "$cwd"; title="$_title"; fi
      title="${title//$'\t'/ }"
      [ "$kind" = "sandbox" ] && clabel="sandbox" || clabel="claude"
      badge_name "$host"; bn="$_bn"
      case "$bn" in
        PC)      bfg="$E[38;2;137;180;250m";;   # blue  — desktop
        Homelab) bfg="$E[38;2;203;166;247m";;   # mauve — server
        *)       bfg="$E[38;2;205;214;244m";;   # text  — cloud
      esac
      # badge cell = the rounded pill (caps hugging <name>, no inner padding) + trailing pad,
      # so the "claude ·" column lines up whatever the machine name's length.
      bpad=$(( BADGEW - ${#bn} )); [ "$bpad" -lt 0 ] && bpad=0
      printf -v bcell '%*s' "$((BADGEW + 2))" ''
      state_color "$st"; scol="$_scol"     # colour the bar/name by the row's real state, even under PINNED
      # Number gutter sits just after the accent bar — where the header's ● bullet is — so
      # the ▎ rule stays column-aligned down the group while ALT+1..9 jumps to the Nth row.
      # --jump-nth counts the same non-empty-KEY rows in this order.
      idx=$(( idx + 1 ))
      if [ "$idx" -le 9 ]; then g1="$idx"; gutc="${C_DIM}${idx}${Z}"; else g1=" "; gutc=" "; fi
      left_p="  ${g1} ${bcell}  ${clabel} · ${name}"
      # Machine source as a rounded pill: fill-colored caps hug the machine-colored name with
      # no inner padding (tight); trailing bpad right-pads to the shared column.
      printf -v left_c '%s%s%s %s %s%s%s%s%s%s%s%s%s%*s  %s%s · %s%s%s%s%s' \
        "$scol" "$GBAR" "$Z" "$gutc" "$BADGEFG" "$PILL_L" "$BADGEBG" "$bfg" "$bn" "$Z" "$BADGEFG" "$PILL_R" "$Z" "$bpad" '' \
        "$C_DIM" "$clabel" "$Z" "$C_BOLD" "$scol" "$name" "$Z"
      case "$st" in
        # Right column = the session's task title (its "name"). When none was captured, fall
        # back to the age — never the state word, which just echoes the group header.
        needs-input|working) if [ -n "$title" ]; then stext="$title"; else fmt_age "$ts"; stext="$_age"; fi;;
        review)      fmt_age "$ts"; stext="${gitmark:-⚠ review}"; [ -n "$_age" ] && stext="$stext $_age";;
        completed)   fmt_age "$ts"; [ -n "$_age" ] && stext="✓ idle $_age" || stext="✓ completed";;
        *)           fmt_age "$ts"; [ -n "$_age" ] && stext="· idle $_age" || stext="· idle";;
      esac
      maxs=$(( W - ${#left_p} - 2 )); [ "$maxs" -lt 8 ] && maxs=8
      # Idle/completed rows keep their title too: the idle marker appends only while
      # both fit — when width runs out the name wins and the marker drops.
      case "$st" in needs-input|working) ;; *)
        if [ -n "$title" ]; then
          [ $(( ${#title} + 2 + ${#stext} )) -le "$maxs" ] && stext="$title  $stext" || stext="$title"
        fi;;
      esac
      [ "${#stext}" -gt "$maxs" ] && stext="${stext:0:maxs-1}…"
      pad=$(( W - ${#left_p} - ${#stext} )); [ "$pad" -lt 1 ] && pad=1
      printf -v sp '%*s' "$pad" ''
      # KEY *is* the card blob (host|cwd|state|ts|title|pane|kind|locator, US-delimited):
      # the jump path reads field 2 (cwd, legacy) + field 8 (locator, direct) and the
      # preview reads the whole thing via {1} — so no per-row fork is needed.
      printf -v key '%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s' \
        "$host" "$US" "$cwd" "$US" "$st" "$US" "$ts" "$US" "$title" "$US" "${pane:-none}" "$US" "$kind" "$US" "$locator"
      printf '%s\t%s%s%s%s%s\n' "$key" "$left_c" "$sp" "$scol" "$stext" "$Z"
    done
  done
  host_status_rows                            # unreachable/failed/stale hosts, appended last
}

render_body() {  # sets global `body` from local + cached-remote rows (the fzf list)
  rows=""
  gather_local_rows
  gather_windows_rows                        # same-machine Windows sessions, via /mnt/c
  gather_remote_rows
  collapse_bg_forks                          # one row per task: fold a bg fork into its origin
  if [ "$HAVE_WEZTERM" = 1 ]; then
    PANELIST=$(wezterm cli --no-auto-start --prefer-mux list --format json 2>/dev/null)
    load_titles
  fi
  body=$(build_pretty)
  [ -z "$body" ] && body="$NO_SESSIONS_ROW"
}
