# shellcheck shell=bash
# agentview · rows — where session rows come from: Claude's live registry, the hook
# sidecars, the Windows registry over /mnt/c, and the cached homelab snapshot. Produces
# the global `rows`; the render module turns it into a list. Needs common (win_roster).

# ---- shared row/prune jq fragments + homelab cache ----
# Row = state<TAB>host<TAB>cwd<TAB>pane<TAB>ts<TAB>kind<TAB>locator<TAB>title<TAB>git. `PRUNE`
# (7d) drops the file; between 1 and 7 days a session is hidden but its file is kept.
# git = the "not-done" marker (⚠ dirty / ↑N) stamped by the state hook — trails the row so
# older 8-field readers are unaffected; the render uses it to reclassify completed -> review.
JQ_ROW='[(.state // "idle"), (.host // "?"), (.cwd // ""), (.pane // ""), $ts, (.kind // "host"), (.locator // ""), (.title // ""), (.git // "")] | @tsv'
JQ_TS='((.ts // 0)|tonumber? // 0) as $ts | ($now - $ts) as $age'
# Pin identity (mirrors compute_pin_id + JQ_ROW's field defaults): a real locator names the
# pane; else host|cwd|kind, US-joined (). Lets gc_pins reconcile the pin sidecar.
JQ_PINID='(.locator // "") as $l | (if ($l != "" and (($l|split(":")|.[0]) != "none")) then $l else ((.host // "?") + "" + (.cwd // "") + "" + (.kind // "host")) end)'
PRUNE=$(( 7 * 86400 ))
# How settled a Windows registry entry must be before reap_windows_rows will believe the daemon
# roster over it. The row and the daemon registration are written by INDEPENDENT paths — a state
# hook writes the file, the session itself handshakes with the daemon — so a brand-new session is
# briefly on disk yet absent from the roster; without this it could be reaped mid-birth. Only ever
# delays reaping a genuinely dead row by one refresh.
REAP_GRACE=120
# remote_cache (homelab ssh snapshot) is defined near the top so do_remove can reach it.
rows=""

# Claude's own per-process registry (~/.claude/sessions/<pid>.json) is the authoritative
# live view. Daemon-hosted background jobs (`claude agents`) never fire UserPromptSubmit
# for daemon-mediated replies or --reply-on-resume launches, so their hook rows go stale
# (stuck needs-input while actually busy) or never exist at all. Each render folds the
# registry in: a live status overrides a hook row's state/ts, and busy/waiting sessions
# with no hook row are synthesized. Idle ones are NOT synthesized — the daemon's
# pre-warmed spare processes register as idle sessions and would render as phantoms.
declare -A SMAP=() SMAP_UPD=() SMAP_USED=()
load_session_map() {  # SMAP[sid] = state<TAB>ts<TAB>kind<TAB>job<TAB>cwd<TAB>name (live pids only)
  local sf jqout pid sid st ts upd kind job cwd name
  SMAP=(); SMAP_UPD=(); SMAP_USED=()
  shopt -s nullglob; sf=( "$sessionsdir"/*.json ); shopt -u nullglob
  [ "${#sf[@]}" -gt 0 ] || return 0
  # ONE jq over the dir (process spawns dominate on Windows). Dead pids and duplicate
  # session ids (a resume under a new pid leaves the old file behind) filter in bash:
  # kill -0 is a builtin, and the newest updatedAt wins. Files without a status are
  # transient sdk/spare processes — skipped in jq. Timestamps there are ms; ts is
  # emitted in seconds for the row, updatedAt kept raw for the dedupe. US-joined, NOT
  # @tsv: tab is IFS whitespace, so read would collapse an empty field (e.g. no jobId)
  # and shift every later column.
  jqout=$(jq -r '
    select(((.status // "") != "") and ((.sessionId // "") != "")) |
    [ (.pid // 0 | tostring), .sessionId,
      (if .status == "busy" then "working" elif .status == "waiting" then "needs-input" else "completed" end),
      (((.statusUpdatedAt // .updatedAt // .startedAt // 0) / 1000) | floor | tostring),
      ((.updatedAt // .startedAt // 0) | tostring),
      (if (.kind // "") == "bg" then "bg" else "host" end),
      (.jobId // ""), (.cwd // ""), (.name // "") ] | join("\u001f")' "${sf[@]}" 2>/dev/null)
  [ -n "$jqout" ] || return 0
  while IFS="$US" read -r pid sid st ts upd kind job cwd name; do
    [ -n "$pid" ] && [ -n "$sid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    if [ -n "${SMAP_UPD[$sid]:-}" ] && [ "${SMAP_UPD[$sid]}" -ge "$upd" ] 2>/dev/null; then continue; fi
    SMAP_UPD[$sid]="$upd"
    SMAP[$sid]="$st"$'\t'"$ts"$'\t'"$kind"$'\t'"$job"$'\t'"$cwd"$'\t'"$name"
  done <<< "$jqout"
}

merge_session_row() {  # $1=9-col row $2=sid -> sets _mrow with the live state folded in.
  # Hook fields the registry can't know (locator/pane/cwd, a /rename'd title, the git
  # marker) survive; state+ts come from the registry, and a bg session's kind flips to
  # "bg" so the jump path knows there is no pane. Non-host kinds (sandbox) keep their own
  # lifecycle.
  local row="$1" sid="$2" m st host cwd pane ts kind locator title git lst lts lkind ljob
  _mrow="$1"
  [ -n "$sid" ] || return 0
  m="${SMAP[$sid]:-}"; [ -n "$m" ] || return 0
  st="${row%%$'\t'*}"; row="${row#*$'\t'}"
  host="${row%%$'\t'*}"; row="${row#*$'\t'}"
  cwd="${row%%$'\t'*}"; row="${row#*$'\t'}"
  pane="${row%%$'\t'*}"; row="${row#*$'\t'}"
  ts="${row%%$'\t'*}"; row="${row#*$'\t'}"
  kind="${row%%$'\t'*}"; row="${row#*$'\t'}"
  locator="${row%%$'\t'*}"; row="${row#*$'\t'}"
  title="${row%%$'\t'*}"; git="${row#*$'\t'}"
  [ "$kind" = "host" ] || return 0
  lst="${m%%$'\t'*}"; m="${m#*$'\t'}"
  lts="${m%%$'\t'*}"; m="${m#*$'\t'}"
  lkind="${m%%$'\t'*}"; m="${m#*$'\t'}"
  ljob="${m%%$'\t'*}"; m="${m#*$'\t'}"
  m="${m#*$'\t'}"                                   # skip registry cwd; hook cwd wins
  SMAP_USED[$sid]=1
  [ -z "$title" ] && title="$m"                     # registry name fills an empty title
  if [ "$lkind" = "bg" ]; then
    kind="bg"
    # No pane exists for a daemon session — carry the JOB id as the focus target so
    # the jump can `claude attach` it (attach matches jobId, NOT the session uuid).
    # A real pane locator (bg launched from a terminal that captured one) would point
    # at the spawning pane, not the session: replace it. No jobId -> roster fallback.
    locator="bg:$ljob"
  fi
  # The live registry reports idle as "completed" — but a stop with an uncommitted/unpushed
  # tree (the hook stamped a git marker) is REVIEW, not done. Re-derive it here, since the
  # fold discards the hook's own state. Only an idle/completed fold is upgraded: a busy or
  # waiting session stays working/needs-input even with a dirty tree.
  [ "$lst" = "completed" ] && [ -n "$git" ] && lst="review"
  _mrow="$lst"$'\t'"$host"$'\t'"$cwd"$'\t'"$pane"$'\t'"$lts"$'\t'"$kind"$'\t'"$locator"$'\t'"$title"$'\t'"$git"
}

av_neutralize_locator() {  # $1 = 9-col row -> _mrow = the row with a none: locator (pane cleared).
  # For a host row whose sid the live registry can't confirm: its recorded pane id may since
  # have been reassigned to another session, so strip it rather than risk a wrong-pane jump.
  # State/title/git survive so the row still renders and self-heals once the registry confirms it.
  local r="$1" st host cwd ts kind title git
  st="${r%%$'\t'*}"; r="${r#*$'\t'}"
  host="${r%%$'\t'*}"; r="${r#*$'\t'}"
  cwd="${r%%$'\t'*}"; r="${r#*$'\t'}"
  r="${r#*$'\t'}"                                   # drop pane
  ts="${r%%$'\t'*}"; r="${r#*$'\t'}"
  kind="${r%%$'\t'*}"; r="${r#*$'\t'}"
  r="${r#*$'\t'}"                                   # drop locator
  title="${r%%$'\t'*}"; git="${r#*$'\t'}"
  _mrow="$st"$'\t'"$host"$'\t'"$cwd"$'\t'$'\t'"$ts"$'\t'"$kind"$'\t'"none:"$'\t'"$title"$'\t'"$git"
}

synth_session_rows() {  # rows for live busy/waiting sessions the hook registry never saw
  local sid m st ts kind job cwd name locator
  for sid in "${!SMAP[@]}"; do
    [ -n "${SMAP_USED[$sid]:-}" ] && continue
    m="${SMAP[$sid]}"
    st="${m%%$'\t'*}"; m="${m#*$'\t'}"
    ts="${m%%$'\t'*}"; m="${m#*$'\t'}"
    kind="${m%%$'\t'*}"; m="${m#*$'\t'}"
    job="${m%%$'\t'*}"; m="${m#*$'\t'}"
    cwd="${m%%$'\t'*}"; name="${m#*$'\t'}"
    [ "$st" = "completed" ] && continue              # idle = maybe a spare — a hookless
    # Only DAEMON bg jobs legitimately lack a hook row (they fire no UserPromptSubmit). An
    # interactive session registers its hook row on the first prompt, so synthesizing it here
    # would flash a nameless, un-jumpable (none:) placeholder — its auto "<leaf>-<hex>" name,
    # no locator — for the render or two before the hook lands. Skip non-bg: an interactive
    # session appears once its own hook row exists (with a real locator + title).
    [ "$kind" = "bg" ] || continue
    rows+="$st"$'\t'"$selfhost"$'\t'"$cwd"$'\t'$'\t'"$ts"$'\t'"$kind"$'\t'"bg:$job"$'\t'"$name"$'\t'$'\n'
  done                                               # bg session shows once it works/waits
}

gather_local_rows() {  # append local session rows to global `rows`, prune >7d + dead-pid leaks
  local local_files jqout jqlines i l _lr _lpid _lsid _mrow
  # ONE jq over the whole state dir (process spawns dominate on Windows at ~55ms each,
  # so a per-file loop was pure overhead). Command substitution — NOT `< <(...)` — so
  # jq FULLY exits, releasing its read handles, before we prune: on Windows an open
  # handle blocks the rm. jq emits exactly one tagged line per file IN ARGUMENT ORDER
  # (P=prune>7d / H=hide 1–7d / L<TAB>pid<TAB>row=local host, prune if the pid is dead /
  # R<TAB>row) so lines align 1:1 with local_files and we
  # prune via the bash glob path (rm-able on MSYS; jq's own input_filename comes back
  # in a drive form rm rejects). On a count mismatch (a corrupt file made jq drop a
  # record) we skip ALL pruning that run rather than risk rm-ing the wrong file.
  load_session_map
  shopt -s nullglob; local_files=( "$statedir"/*.json ); shopt -u nullglob
  if [ "${#local_files[@]}" -gt 0 ]; then
  jqout=$(jq -r --argjson now "$now" --argjson prune "$PRUNE" --arg self "$selfhost" "
      $JQ_TS | (.pid // \"\" | tostring) as \$pid | (.session // .key // \"\" | tostring) as \$sid |
      if   \$ts > 0 and \$age > \$prune then \"P\"
      elif \$ts > 0 and \$age > 86400  then \"H\"
      elif (.kind // \"host\") == \"host\" and (.host // \"\") == \$self and \$pid != \"\"
           then \"L\t\" + \$pid + \"\t\" + \$sid + \"\t\" + ($JQ_ROW)
      else \"R\t\" + \$sid + \"\t\" + ($JQ_ROW) end" "${local_files[@]}" 2>/dev/null)
  jqlines=(); [ -n "$jqout" ] && mapfile -t jqlines <<< "$jqout"
  if [ "${#jqlines[@]}" -eq "${#local_files[@]}" ]; then
    for i in "${!local_files[@]}"; do
      case "${jqlines[$i]}" in
        P)  rm -f "${local_files[$i]}" 2>/dev/null ;;
        L*) _lr="${jqlines[$i]#L$'\t'}"; _lpid="${_lr%%$'\t'*}"       # L<TAB>pid<TAB>sid<TAB>row
            _lr="${_lr#*$'\t'}"; _lsid="${_lr%%$'\t'*}"
            if ! kill -0 "$_lpid" 2>/dev/null; then
              rm -f "${local_files[$i]}" 2>/dev/null                  # process gone -> leaked, prune
            elif [ -n "${SMAP[$_lsid]:-}" ]; then
              merge_session_row "${_lr#*$'\t'}" "$_lsid"; rows+="$_mrow"$'\n'   # live session: fold + render
            else
              # kill -0 is NOT pid-reuse-safe: a dead session whose pid the OS recycled to a live
              # process still passes it, yet the stale row's recorded pane id may since have been
              # reassigned by the mux to a DIFFERENT session — trusting it misroutes <enter> (the
              # Clipboard->memory bug). SMAP (load_session_map: keyed by sessionId, dead-pid-filtered)
              # is authoritative for liveness; when it can't confirm this sid, keep rendering the row
              # (a live session momentarily missing from the registry must not vanish) but scrub the
              # unverified locator so the jump can't land on a stranger's pane.
              av_neutralize_locator "${_lr#*$'\t'}"; rows+="$_mrow"$'\n'
            fi ;;
        R*) _lr="${jqlines[$i]#R$'\t'}"; _lsid="${_lr%%$'\t'*}"       # R<TAB>sid<TAB>row
            merge_session_row "${_lr#*$'\t'}" "$_lsid"; rows+="$_mrow"$'\n' ;;
      esac
    done
  else
    for l in "${jqlines[@]}"; do
      case "$l" in
        L*) _lr="${l#L$'\t'}"; _lr="${_lr#*$'\t'}"                    # count mismatch: render, never rm
            rows+="${_lr#*$'\t'}"$'\n' ;;
        R*) _lr="${l#R$'\t'}"; rows+="${_lr#*$'\t'}"$'\n' ;;
      esac
    done
  fi
  fi
  synth_session_rows
}

gather_remote_rows() {  # append cached homelab rows to `rows` (display-filtered, never pruned)
  local rrows
  [ -s "$remote_cache" ] || return
  # Read via stdin, not a path arg, so native jq.exe isn't handed an MSYS path it
  # can't open. Default mode applies the filter to each object in the concatenated
  # per-session stream (the cache is a `cat` of every remote *.json).
  rrows=$(MSYS_NO_PATHCONV=1 jq -r --argjson now "$now" "
    $JQ_TS | if \$ts > 0 and \$age > 86400 then empty else $JQ_ROW end" < "$remote_cache" 2>/dev/null)
  [ -n "$rrows" ] && rows+="$rrows"$'\n'
}

gather_windows_rows() {  # append Windows-side rows (same machine, via /mnt/c). No dead-pid
  # prune — the pids are Windows pids not checkable from WSL; rely on the Windows SessionEnd
  # hook + the 7-day age prune. One jq over the dir (MSYS_NO_PATHCONV keeps the C:\ cwds intact),
  # emitting P=prune>7d / R<TAB>row IN ARGUMENT ORDER so lines align 1:1 with the glob — same
  # count-mismatch guard as gather_local_rows (render, never rm) against a corrupt file.
  local wfiles jqout jqlines i
  [ "$winhost" != "$selfhost" ] || return    # no distinct Windows source (or we ARE the win host)
  [ -d "$windir" ] || return
  shopt -s nullglob; wfiles=( "$windir"/*.json ); shopt -u nullglob
  [ "${#wfiles[@]}" -gt 0 ] || return
  jqout=$(MSYS_NO_PATHCONV=1 jq -r --argjson now "$now" --argjson prune "$PRUNE" "
      $JQ_TS | if \$ts > 0 and \$age > \$prune then \"P\" else \"R\t\" + ($JQ_ROW) end" "${wfiles[@]}" 2>/dev/null)
  jqlines=(); [ -n "$jqout" ] && mapfile -t jqlines <<< "$jqout"
  if [ "${#jqlines[@]}" -eq "${#wfiles[@]}" ]; then
    for i in "${!wfiles[@]}"; do
      case "${jqlines[$i]}" in
        P)  rm -f "${wfiles[$i]}" 2>/dev/null ;;
        R*) rows+="${jqlines[$i]#R$'\t'}"$'\n' ;;
      esac
    done
  else
    for i in "${jqlines[@]}"; do case "$i" in R*) rows+="${i#R$'\t'}"$'\n';; esac; done
  fi
}

reap_windows_rows() {  # delete $windir entries whose session the Windows daemon no longer runs.
  # This is the Windows half of gather_local_rows' dead-pid prune. A local row is dropped the
  # moment `kill -0` fails; Windows pids are not checkable from WSL, so the daemon roster stands
  # in as the liveness oracle and the POLICY matches — gone is gone, no 7-day wait. Without this
  # a session whose SessionEnd hook never fired (tab killed, crash) leaves a file behind that
  # renders as a phantom row offering a jump nothing can serve.
  # Runs ONLY from --refresh-remote, i.e. detached and off the render path: win_roster costs
  # ~0.7s where a single 55ms process spawn already hurts, and the reload that job POSTs is what
  # makes the reaped rows vanish from the open picker.
  # Two deliberate refusals to act: an unreachable roster reaps NOTHING (unknown is not death,
  # or one broken query would wipe every Windows row), and an entry younger than REAP_GRACE is
  # spared so a just-started session cannot be reaped before it registers.
  local wfiles out live jqout jqlines i
  [ "$winhost" != "$selfhost" ] || return    # same guard as gather_windows_rows
  [ -d "$windir" ] || return
  shopt -s nullglob; wfiles=( "$windir"/*.json ); shopt -u nullglob
  [ "${#wfiles[@]}" -gt 0 ] || return
  out=$(win_roster) || return
  live=$(printf '%s' "$out" | jq -c '[.[] | (.sessionId // "") | select(. != "")]' 2>/dev/null) || return
  [ -n "$live" ] || return
  # One jq over the dir emitting K/D per file IN ARGUMENT ORDER so lines align 1:1 with the glob
  # and we rm via the bash path (jq's own input_filename comes back in a drive form rm rejects on
  # MSYS). On a count mismatch reap nothing this run — same guard, same reason, as the gathers.
  jqout=$(MSYS_NO_PATHCONV=1 jq -r --argjson now "$now" --argjson live "$live" \
      --argjson grace "$REAP_GRACE" "
      $JQ_TS | (.session // .key // \"\" | tostring) as \$sid |
      if \$sid == \"\" or \$age < \$grace or (\$live | index(\$sid)) then \"K\" else \"D\" end
      " "${wfiles[@]}" 2>/dev/null)
  jqlines=(); [ -n "$jqout" ] && mapfile -t jqlines <<< "$jqout"
  [ "${#jqlines[@]}" -eq "${#wfiles[@]}" ] || return
  for i in "${!wfiles[@]}"; do
    [ "${jqlines[$i]}" = "D" ] && rm -f "${wfiles[$i]}" 2>/dev/null
  done
  return 0
}

sync_windows_rows() {  # write $windir rows for live Windows sessions that never registered one.
  # The registry is written by STATE HOOKS, so a row only exists once a session submits a prompt
  # or ends a turn. A session that starts (or resumes) and is then left idle fires neither, so it
  # runs with no file and the picker cannot see it — the reap is not involved, there was never a
  # row to reap. The SessionStart hook now covers new sessions, but only on hosts already running
  # that config; the daemon roster covers the rest, and it already knows everything a row needs.
  # CREATE-ONLY: an existing file is left ALONE. A hook-written row carries the pane and locator
  # the roster cannot supply, so overwriting one would downgrade a direct jump to "no pane".
  # Runs from --refresh-remote right after reap_windows_rows, sharing its memoized roster query.
  local out entries sid cwd title kind state ts bgid locator file tmp
  [ "$winhost" != "$selfhost" ] || return    # same guard as gather_windows_rows
  [ -d "$windir" ] || return
  out=$(win_roster) || return
  # Roster status maps onto picker states exactly as refresh_remote's homelab fold does
  # (busy -> working, waiting -> needs-input, anything else -> idle). Background sessions get a
  # bg:<id> locator so <enter> attaches via the daemon; an interactive one has no pane WSL can
  # name, so it stays none: and the jump path re-resolves it against the roster at <enter> time.
  # Fields are US-joined, NOT @tsv: @tsv escapes backslashes, so a Windows cwd came back as
  # C:\\Users\\daniel and got written to disk doubled. join() applies no escaping — the field
  # separator is safe instead because `clean` strips US (and newlines, which would split a row).
  # The class is written with SINGLE backslashes so jq's own string parser turns them into the
  # real control characters: "\\u001f" would reach Oniguruma as an escape it does not know and
  # degrade into the literal set {u,0,1,f}, which silently ate the 0 out of an agent id.
  entries=$(printf '%s' "$out" | jq -r '
      def clean: (. // "") | tostring | gsub("[\n\r]"; " ") | gsub("\u001f"; " ");
      .[] | select((.sessionId // "") != "") |
      [ (.sessionId|clean), (.cwd|clean), (.name|clean),
        (if (.kind // "") == "background" then "bg" else "host" end),
        (if (.status // "") == "busy" then "working"
         elif (.status // "") == "waiting" then "needs-input" else "idle" end),
        ((.startedAt // 0) / 1000 | floor | tostring), (.id|clean) ] | join("\u001f")' 2>/dev/null) || return
  [ -n "$entries" ] || return
  while IFS=$'\037' read -r sid cwd title kind state ts bgid; do
    [ -n "$sid" ] || continue
    file="$windir/$sid.json"
    [ -e "$file" ] && continue
    case "$ts" in ''|*[!0-9]*) ts=0;; esac
    locator="none:"; [ "$kind" = "bg" ] && [ -n "$bgid" ] && locator="bg:$bgid"
    tmp="$file.tmp.$$"
    # Same schema and same atomic temp+mv as the hook's av_write_full, so a row this writes is
    # indistinguishable to every reader (and to the reap) from one a hook wrote.
    if MSYS_NO_PATHCONV=1 jq -nc --arg key "$sid" --arg session "$sid" --arg cwd "$cwd" \
         --arg title "$title" --arg state "$state" --arg host "$winhost" --arg kind "$kind" \
         --arg locator "$locator" --argjson ts "$ts" \
         '{key:$key,run:"",kind:$kind,cwd:$cwd,title:$title,state:$state,host:$host,ts:$ts,
           backend:($locator|split(":")[0]),locator:$locator,pane:"",session:$session,pid:"",git:""}' \
         > "$tmp" 2>/dev/null; then
      mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    else
      rm -f "$tmp" 2>/dev/null
    fi
  done <<< "$entries"
  return 0
}

refresh_remote() {  # pull homelab state over ssh, fold its live registry in, replace the cache
  local out rc tmp="$remote_cache.tmp.$$"
  # Mirror the LOCAL live-registry override (load_session_map + merge_session_row) on the
  # homelab so cached remote rows can't go stale. A remote session's hook state
  # (~/.claude/agent-view/<sid>.json) LAGS: an idle/permission Notification writes
  # "needs-input" and NO later hook fires when the user merely reads the pane over ssh — so
  # the picker showed a sticky needs-input. Claude's own per-process registry
  # (~/.claude/sessions/<pid>.json) is the live truth, but only the owning host can read it
  # AND kill -0 its pids, so the fold MUST run remote-side: `ssh bash -s` feeds it the heredoc
  # below. Each HOST row's state/ts is rewritten from the live status (busy->working,
  # waiting->needs-input, idle/else->completed), newest updatedAt winning per session, dead
  # pids skipped, sdk/spare processes ignored. A session with no live registry entry (older
  # claude, or a genuinely gone process) passes its raw hook row through unchanged, so a
  # pre-registry homelab still renders. One-shot ssh (NO ControlMaster) bounded by
  # ConnectTimeout — we KEEP the old snapshot only when ssh itself can't connect (rc 255),
  # not when there simply are no remote sessions.
  out=$(ssh -o ConnectTimeout=3 -o BatchMode=yes daniel-server bash -s <<'REMOTE_FOLD' 2>/dev/null
set -u; shopt -s nullglob
declare -A M UPD
# sid -> "state<TAB>ts<TAB>kind<TAB>jobId" from live, non-sdk, alive-pid sessions (newest
# updatedAt wins). kind/jobId carry the daemon identity the hook row cannot know — see the
# bg rewrite below. jobId is emitted LAST because it is the only field that can be empty and
# tab is IFS whitespace: a middle empty would collapse and shift every later column.
for sf in "$HOME/.claude/sessions"/*.json; do
  line=$(jq -r '
    select(((.status // "") != "") and ((.sessionId // "") != "") and (((.entrypoint // "") | startswith("sdk")) | not)) |
    [ (.pid // 0 | tostring), .sessionId,
      (if .status == "busy" then "working" elif .status == "waiting" then "needs-input" else "completed" end),
      (((.statusUpdatedAt // .updatedAt // .startedAt // 0) / 1000) | floor | tostring),
      ((.updatedAt // .startedAt // 0) | tostring),
      (if (.kind // "") == "bg" then "bg" else "host" end),
      (.jobId // "") ] | @tsv' "$sf" 2>/dev/null)
  [ -n "$line" ] || continue
  IFS=$'\t' read -r pid sid st ts upd lkind ljob <<< "$line"
  [ -n "$pid" ] && [ -n "$sid" ] || continue
  kill -0 "$pid" 2>/dev/null || continue
  if [ -n "${UPD[$sid]:-}" ] && [ "${UPD[$sid]}" -ge "$upd" ] 2>/dev/null; then continue; fi
  UPD[$sid]="$upd"; M[$sid]="$st"$'\t'"$ts"$'\t'"$lkind"$'\t'"${ljob:-}"
done
# Emit each hook row, its HOST state/ts overridden by the live registry when present.
for af in "$HOME/.claude/agent-view"/*.json; do
  sid=$(jq -r '.session // .key // ""' "$af" 2>/dev/null)
  kind=$(jq -r '.kind // "host"' "$af" 2>/dev/null)
  ov="${M[$sid]:-}"
  if [ -n "$ov" ] && [ "$kind" = "host" ]; then
    st="${ov%%$'\t'*}"; ov="${ov#*$'\t'}"
    ts="${ov%%$'\t'*}"; ov="${ov#*$'\t'}"
    lkind="${ov%%$'\t'*}"; ljob="${ov#*$'\t'}"
    # Idle folds to "completed"; a dirty/unpushed tree (a stamped .git marker) is REVIEW —
    # keep .git and re-derive, mirroring the local merge_session_row upgrade.
    # A daemon bg job has no pane on either side, so its hook row carries a none: locator the
    # jump path can only reject. Flip kind to bg and carry the JOB id as the focus target
    # (attach matches jobId, NOT the session uuid) — the same swap merge_session_row makes
    # locally, so <enter> reaches `claude attach` over ssh instead of reporting "no pane".
    jq -c --arg s "$st" --argjson t "${ts:-0}" --arg k "$lkind" --arg j "$ljob" \
      '.state=(if $s=="completed" and ((.git // "")!="") then "review" else $s end) | .ts=$t
       | if $k == "bg" then .kind="bg" | .locator="bg:"+$j | .backend="bg" else . end' "$af" 2>/dev/null
  else
    jq -c '.' "$af" 2>/dev/null
  fi
done
REMOTE_FOLD
)
  rc=$?
  [ "$rc" -eq 255 ] && return
  printf '%s' "$out" > "$tmp" 2>/dev/null && mv -f "$tmp" "$remote_cache" 2>/dev/null || rm -f "$tmp" 2>/dev/null
}
