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
C_UNSEEN="$E[38;2;148;226;213m"        # teal    — DONE: finished while you weren't looking
C_DONE="$E[38;2;108;112;134m"          # overlay0 — completed / idle (i.e. seen)
C_DIM="$E[38;2;127;132;156m"           # overlay1 — "claude ·"
C_BOLD="$E[1m"                         # bold prefix — group headers + names render bold+state
C_PIN="$E[38;2;203;166;247m"           # mauve — PINNED group accent (★)
C_ERR="$E[38;2;243;139;168m"           # red — host unreachable / fetch failed
C_STALE="$C_NEED"                      # stale remote data reads as attention, not failure
GBAR=$'▎'                         # ▎ left accent rule — state-colored, runs down each group
# Foldable group headers (COMPLETED/IDLE) swap this glyph in place of the ● the other
# headers carry, so the header itself says which way <enter> will move it.
FOLD_COLLAPSED=$'▸'; FOLD_EXPANDED=$'▾'
BADGEBG="$E[48;2;69;71;90m"            # surface1 — machine chip background
BADGEFG="$E[38;2;69;71;90m"            # surface1 as FG — colors the pill's rounded end-caps
PILL_L=$''; PILL_R=$''     # powerline half-circles — round the source badge into a box
# Single-source the state→accent map and the empty-state row so the two render paths
# (render_body + interactive picker) can't drift — they had: one used an extra leading
# tab, mis-offsetting the "no sessions" row against fzf's --with-nth=3.. delimiter.
state_color() {  # set $_scol to a state group's accent (a function call, no per-row fork)
  case "$1" in needs-input) _scol="$C_NEED";; working) _scol="$C_WORK";; review) _scol="$C_REVIEW";; unseen) _scol="$C_UNSEEN";; *) _scol="$C_DONE";; esac
}
row_pinned() {  # sets $_pinned=1/0 for $1=host $2=cwd $3=kind $4=locator (reads PINNED_SET
  # via dynamic scope from build_pretty). No fork — runs per row on the render path.
  local _pid
  compute_pin_id "$1" "$2" "$3" "$4"
  [ -n "${PINNED_SET[$_pid]:-}" ] && _pinned=1 || _pinned=0
}
NO_SESSIONS_ROW=$'\t\t   '"${C_DONE}   no active Claude sessions — nothing running${Z}"
LABEL=$' ✳ claude sessions '      # ✳ Claude mark in the border title
PROMPT=$'  '                     # Nerd Font magnifier + gap (IosevkaTerm NFM)
declare -A GN=( [pinned]="PINNED" [needs-input]="NEEDS INPUT" [working]="WORKING" [review]="REVIEW" [unseen]="DONE" [completed]="COMPLETED" [idle]="IDLE" )

group_expanded() {  # $1 = group name -> true (0) if its rows should render in full.
  # completed/idle are the only foldable groups: the rest are what the picker exists to show.
  case "$1" in completed|idle) ;; *) return 0 ;; esac
  [ -r "$foldfile" ] && grep -qxF "$1" "$foldfile" 2>/dev/null
}

state_rank() {  # sets _sr: how much a state wants your attention (1 = most). Orders rows
  # inside a repo group, where "newest first" alone would bury the one asking a question.
  case "$1" in needs-input) _sr=1;; working) _sr=2;; review) _sr=3;; completed) _sr=4;; *) _sr=5;; esac
}

av_groupby() {  # sets _gb to the active grouping: "state" (default) or "repo"
  _gb="state"
  # shellcheck disable=SC2154  # groupbyfile is the parent script's global, like pinfile
  [ -f "$groupbyfile" ] && IFS= read -r _gb < "$groupbyfile" 2>/dev/null
  case "$_gb" in repo) ;; *) _gb="state";; esac
}

row_group_name() {  # $1 = cwd -> sets _gname: the row's display name, parent-prefixed when
  # another row shares the leaf (reads NAMECNT by dynamic scope, like row_pinned).
  local fwd="${1//\\//}" nm par
  fwd="${fwd%/}"; nm="${fwd##*/}"; [ -z "$nm" ] && nm="$1"
  if [ -n "$nm" ] && [ "${NAMECNT[$nm]:-0}" -gt 1 ]; then
    par="${fwd%/*}"; par="${par##*/}"
    [ -n "$par" ] && [ "$par" != "$nm" ] && nm="$par/$nm"
  fi
  _gname="$nm"
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
  # Keyless: `printf '\t\t...'` gives every row an empty KEY (and empty track SID, field 2 —
  # see build_pretty), the same treatment group headers get, so the --skip cursor logic
  # steps over these rather than landing on them.
  # No ▎ accent rule, deliberately: that bar marks group membership, and these rows belong
  # to no group — they print after the last one, so a bar would read as "more IDLE rows",
  # and every other barred non-header row in the list is selectable while these cannot be.
  # The two-space indent puts the label in the glyph column (where ●/▸ and the alt-N digits
  # sit): row level, outside any group. Colour alone carries the escalation.
  local host status outcome when age lbl
  while IFS= read -r host; do
    status="$(remote_status_for "$host")"
    [ -r "$status" ] || continue
    IFS=$'\t' read -r outcome when < "$status" || continue
    host_label "$host"; lbl="$_hl"
    case "$outcome" in
      unreachable) printf '\t\t  %s%s · unreachable%s\n' "$C_ERR" "$lbl" "$Z" ;;
      failed)      printf '\t\t  %s%s · fetch failed%s\n' "$C_ERR" "$lbl" "$Z" ;;
      ok)
        # A corrupt status file (partial write, disk error) can carry a non-numeric epoch;
        # under `set -u` the bare arithmetic below would abort the whole render. Mirror
        # fmt_age's own guard and treat garbage as maximally stale, so it still surfaces.
        case "$when" in ''|*[!0-9]*) when=0;; esac
        age=$(( now - when ))
        [ "$age" -gt "$AV_STALE_AFTER" ] && { fmt_age "$when"; printf '\t\t  %s%s · %s old%s\n' "$C_STALE" "$lbl" "$_age" "$Z"; }
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

fold_title_states() {  # upgrade `rows` from the mux pane title's state glyph. Runs after load_titles.
  # The hook registry stays authoritative; this only reaches what it cannot see — a hook row
  # that went stale (rows.sh: daemon-hosted jobs never fire UserPromptSubmit, so they stick).
  # Asymmetric on purpose, mirroring herdr's own rule priorities. A braille spinner is proof a
  # turn is RUNNING, so it may upgrade a row (herdr ranks it 1100, above everything). ✳ only
  # means "not mid-turn" and cannot tell idle from blocked, so it is parsed but never folded:
  # herdr ranks it 250, below every other rule, and every row here already carries a state, so
  # acting on it could only overwrite a better-sourced one.
  # needs-input IS overridden by a spinner, and that was measured rather than assumed. Sampling
  # #{pane_title} twice a second across a live turn on 2.1.223: a session blocked on a tool
  # permission prompt holds ✳ (30 stable samples), while a running turn cycles braille. So
  # braille cannot be a blocked session, and a needs-input row whose pane is mid-turn is stale
  # rather than waiting on Daniel. ✳ still never folds, which is the half that protects a row
  # genuinely waiting on him. Local host rows only: the title map is this machine's mux.
  local out="" L st host cwd rest kind
  while IFS= read -r L; do
    [ -z "$L" ] && continue
    st="${L%%$'\t'*}"; rest="${L#*$'\t'}"
    host="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
    cwd="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"        # rest = pane ts kind locator title git
    kind="${rest#*$'\t'}"; kind="${kind#*$'\t'}"; kind="${kind%%$'\t'*}"
    if [[ "$host" == "$selfhost" && "$kind" == "host" ]]; then
      title_for_cwd "$cwd"; state_from_title "$_title"
      [[ "$_tstate" == "working" ]] && st="working"
    fi
    out+="$st"$'\t'"$host"$'\t'"$cwd"$'\t'"$rest"$'\n'
  done <<< "$rows"
  rows="$out"
}
fold_seen_states() {  # completed -> unseen, when the work landed while you were looking away.
  # herdr splits one underlying state in two: idle is ready AND you have seen it; done is the
  # same state where the work finished unwatched. Across a dozen rows that is the difference
  # between a list you scan and a list you act on.
  #
  # The marker stores the row's ts as of the last focus, NOT a boolean. A boolean would latch on
  # first focus and the row could never be DONE again, which makes the feature work exactly once
  # per session.
  #
  # Keyed on host+cwd+kind rather than compute_pin_id, which prefers the locator. A pin names a
  # PANE; a pane dying is precisely when a daemon-hosted job finishes, so a pane-keyed marker
  # would evaporate at the one moment this exists for.
  #
  # Refines "completed" only. A review row (stopped with a dirty tree) keeps REVIEW: it is the
  # more actionable label and already has its own group.
  # An ABSENT sidecar means dormant, not "nothing seen". Treating it as nothing-seen would put
  # every completed row in DONE on a fresh setup, so the group would be the whole list at exactly
  # the moment you are deciding whether it is useful. The file appears the first time you focus
  # anything, which arms the feature; from then on an unfocused completed row is DONE, which is
  # the case this exists for. Deleting the sidecar disarms it again.
  [ -r "$seenfile" ] || return 0
  local -A SEEN=()
  local _k _v
  while IFS=$'\t' read -r _k _v; do
    [ -n "$_k" ] && SEEN["$_k"]="$_v"
  done < "$seenfile"
  local out="" L st host cwd rest kind ts mark
  while IFS= read -r L; do
    [ -z "$L" ] && continue
    st="${L%%$'\t'*}"; rest="${L#*$'\t'}"
    host="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
    cwd="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"        # rest = pane ts kind locator title git
    ts="${rest#*$'\t'}"; ts="${ts%%$'\t'*}"
    kind="${rest#*$'\t'}"; kind="${kind#*$'\t'}"; kind="${kind%%$'\t'*}"
    if [ "$st" = completed ]; then
      compute_seen_id "$host" "$cwd" "$kind"
      mark="${SEEN[$_sid]:-}"
      # Compared as strings, not numbers: any ts the marker did not capture means the session
      # has moved since you looked, and a ts format change can never turn into a silent -gt.
      [ "$ts" != "$mark" ] && st=unseen
    fi
    out+="$st"$'\t'"$host"$'\t'"$cwd"$'\t'"$rest"$'\n'
  done <<< "$rows"
  rows="$out"
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
  local W BADGEW=7 grp st host cwd pane ts kind locator title_reg gitmark name title bn scol stext cnt key glyph L _rest
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
  # Sort every row ONCE and tally per-group counts in pure bash, so the group loop needs no
  # per-group awk/sort — each of those was a process spawn, and spawns dominate render time
  # on Windows.
  local -a sorted GORDER; local -A GCNT=() NAMECNT=() GURG=()
  local GB _gb _sr _gname _gk
  av_groupby; GB="$_gb"
  if [ "$GB" = repo ]; then
    # Repo grouping puts every session for a checkout together, so "what is happening in this
    # project" reads in one place instead of scattered across five state groups. Inside a
    # group, order by attention (a question first) then recency — ts alone would bury it.
    # The extra spawns ride the non-default path only.
    mapfile -t sorted < <(printf '%s' "$rows" | awk -F'\t' '
      { r = 5
        if ($1 == "needs-input") r = 1; else if ($1 == "working") r = 2
        else if ($1 == "review") r = 3; else if ($1 == "completed") r = 4
        print r "\t" $0 }' | sort -t$'\t' -k1,1n -k6,6nr | cut -f2-)
  else
    mapfile -t sorted < <(printf '%s' "$rows" | sort -t$'\t' -k5,5nr)
  fi
  # Pass 1 — leaf-name tally, so the render can tell twins apart (same-named checkout on
  # another host / a worktree elsewhere) by prefixing the parent dir. It has to complete
  # before any group key is formed, since in repo mode the name IS the key.
  local -A SEENCWD=()
  for L in "${sorted[@]}"; do
    st="${L%%$'\t'*}"; [ -z "$st" ] && continue
    _rest="${L#*$'\t'}"; _rest="${_rest#*$'\t'}"          # skip state, host
    cwd="${_rest%%$'\t'*}"
    fwd="${cwd//\\//}"; fwd="${fwd%/}"; _leaf="${fwd##*/}"; [ -z "$_leaf" ] && _leaf="$cwd"
    # Count DISTINCT directories per leaf, not rows. The prefix exists to tell two different
    # checkouts apart; counting rows meant two sessions in the SAME directory also tripped it,
    # so a single repo rendered as "parent/leaf" — and under repo grouping that mangled name
    # became the group's own title.
    [ -n "${SEENCWD[$fwd]:-}" ] && continue
    SEENCWD[$fwd]=1
    [ -n "$_leaf" ] && NAMECNT[$_leaf]=$(( ${NAMECNT[$_leaf]:-0} + 1 ))
  done
  # Pass 2 — per-group counts, and (repo mode) the most urgent state in each group, which is
  # what colors its header: a collapsed-looking project still says whether anything needs you.
  for L in "${sorted[@]}"; do
    st="${L%%$'\t'*}"; [ -z "$st" ] && continue
    _rest="${L#*$'\t'}"; host="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
    cwd="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
    _rest="${_rest#*$'\t'}"                       # skip pane
    _rest="${_rest#*$'\t'}"                       # skip ts
    kind="${_rest%%$'\t'*}"; _rest="${_rest#*$'\t'}"
    locator="${_rest%%$'\t'*}"
    row_pinned "$host" "$cwd" "$kind" "$locator"
    if [ "$_pinned" = 1 ]; then PINCNT=$(( PINCNT + 1 )); continue; fi
    if [ "$GB" = repo ]; then row_group_name "$cwd"; _gk="$_gname"; else _gk="$st"; fi
    GCNT[$_gk]=$(( ${GCNT[$_gk]:-0} + 1 ))
    state_rank "$st"
    [ "$_sr" -lt "${GURG[$_gk]:-9}" ] && GURG[$_gk]="$_sr"
  done
  if [ "$GB" = repo ]; then
    GORDER=(pinned)
    if [ "${#GCNT[@]}" -gt 0 ]; then
      mapfile -t -O "${#GORDER[@]}" GORDER < <(printf '%s\n' "${!GCNT[@]}" | sort)
    fi
  else
    # `unseen` (the DONE group) must stay in this list. It postdates the branch this came
    # from, so the incoming version silently dropped it — a completed-but-unwatched row would
    # have rendered under COMPLETED again, quietly undoing the group it belongs in.
    GORDER=(pinned needs-input working review unseen completed idle)
  fi
  for grp in "${GORDER[@]}"; do
    if [ "$grp" = pinned ]; then cnt=$PINCNT; else cnt=${GCNT[$grp]:-0}; fi
    [ "$cnt" -eq 0 ] && continue
    [ "$first" -eq 0 ] && printf '\t\t\n'   # blank spacer between groups (empty KEY = no-op on select)
    first=0
    if ! group_expanded "$grp"; then
      # Collapsed: this landable fold row REPLACES the usual keyless header (never reached
      # for "pinned" — group_expanded always returns true for it). A fold header must be
      # selectable to be expandable, so it carries a sentinel key (fold:<group>) rather than
      # an empty one — see the --skip dispatch in executable_agentview. It is styled exactly
      # like the expanded header apart from the glyph and the parenthesized count, so folding
      # a group changes the affordance rather than reflowing the line.
      state_color "$grp"; scol="$_scol"
      printf 'fold:%s\tfold:%s\t%s%s%s %s%s%s %s%s%s%s %s(%s)%s\n' "$grp" "$grp" "$scol" "$GBAR" "$Z" \
        "$scol" "$FOLD_COLLAPSED" "$Z" "$C_BOLD" "$scol" "${GN[$grp]}" "$Z" "$C_DIM" "$cnt" "$Z"
      continue
    fi
    if [ "$grp" = pinned ]; then
      printf '\t\t%s%s%s %s★%s %s%s%s%s %s%s%s\n' "$C_PIN" "$GBAR" "$Z" "$C_PIN" "$Z" "$C_BOLD" "$C_PIN" "${GN[$grp]}" "$Z" "$C_DIM" "$cnt" "$Z"
    elif [ "$GB" = repo ]; then
      # The header wears the group's most urgent state, so a repo with a session waiting on
      # you is as visible as the NEEDS INPUT group used to be.
      case "${GURG[$grp]:-5}" in 1) scol="$C_NEED";; 2) scol="$C_WORK";; 3) scol="$C_REVIEW";; *) scol="$C_DONE";; esac
      printf '\t\t%s%s%s %s●%s %s%s%s%s %s%s%s\n' "$scol" "$GBAR" "$Z" "$scol" "$Z" "$C_BOLD" "$scol" "$grp" "$Z" "$C_DIM" "$cnt" "$Z"
    else
      state_color "$grp"; scol="$_scol"
      # An EXPANDED foldable group (completed/idle) still needs a landable key, the same
      # fold:<group> sentinel the collapsed header carries, so <enter> can re-collapse it.
      # The other three state headers can't be folded at all and stay keyless like spacers,
      # and keep the ● bullet — the fold glyph is reserved for headers <enter> can act on.
      case "$grp" in
        completed|idle) key="fold:$grp"; glyph="$FOLD_EXPANDED";;
        *)              key="";         glyph='●';;
      esac
      printf '%s\t%s\t%s%s%s %s%s%s %s%s%s%s %s%s%s\n' "$key" "$key" "$scol" "$GBAR" "$Z" \
        "$scol" "$glyph" "$Z" "$C_BOLD" "$scol" "${GN[$grp]}" "$Z" "$C_DIM" "$cnt" "$Z"
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
      # Two rows sharing a leaf name render identically — prefix the parent dir so they stay
      # tellable apart (full path remains in the CTRL+O card). In repo mode that same name is
      # the group key, so it is computed before the membership test, not after.
      row_group_name "$cwd"; name="$_gname"
      if [ "$grp" = pinned ]; then
        [ "$_pinned" = 1 ] || continue
      elif [ "$GB" = repo ]; then
        { [ "$name" = "$grp" ] && [ "$_pinned" = 0 ]; } || continue
      else
        { [ "$st" = "$grp" ] && [ "$_pinned" = 0 ]; } || continue
      fi
      # Prefer a registry-supplied title (sandbox rows carry repo·branch); else the
      # mux-correlated pane title (host rows on wezterm). Tabs would split the columns.
      # The mux title carries the state glyph as its first rune; strip it so only the session
      # name reaches the column (fold_title_states has already read it).
      if [ -n "$title_reg" ]; then title="$title_reg"; else title_for_cwd "$cwd"; state_from_title "$_title"; title="$_tname"; fi
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
      # Field 2 is the fzf --track identity: KEY embeds state/ts, which change on every
      # repaint, so tracking on KEY would lose the row the instant its own state changed.
      # compute_seen_id (host+cwd+kind) is what the DONE group already keys a session on
      # for the same reason — deliberately not the pane/locator, since a pane dying is
      # exactly when a daemon-hosted job finishes.
      compute_seen_id "$host" "$cwd" "$kind"
      printf '%s\t%s\t%s%s%s%s%s\n' "$key" "$_sid" "$left_c" "$sp" "$scol" "$stext" "$Z"
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
