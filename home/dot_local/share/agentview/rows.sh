# shellcheck shell=bash
# agentview · rows — where session rows come from: Claude's live registry, the hook
# sidecars, the Windows registry over /mnt/c, and the cached homelab snapshot. Produces
# the global `rows`; the render module turns it into a list. Needs common (win_roster).
# SC2154/SC2034: globals cross the module boundary in both directions — the loader assigns
# what this reads, and `rows` and the JQ_* fragments are consumed by its siblings.
# shellcheck disable=SC2154,SC2034

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
# remote_cache_for (homelab ssh snapshot, one per host) is defined in common.sh so do_remove
# can reach it.
rows=""

av_write_status() {  # $1=status path $2=outcome -> atomic tmp+mv write of "<outcome>\t<epoch>"
  # Same tmp+mv shape as the cache write below: a reader (host_status_rows) reads this file
  # with a plain `read`, and a `>` truncate landing mid-write would hand it an empty line —
  # an unreachable host rendering as silence, which is the exact bug this file exists to fix.
  local status="$1" outcome="$2" stmp="$1.tmp.$$"
  printf '%s\t%s\n' "$outcome" "$(date +%s)" > "$stmp" 2>/dev/null && mv -f "$stmp" "$status" 2>/dev/null \
    || rm -f "$stmp" 2>/dev/null
}

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
      (.jobId // ""), (.cwd // ""), (.name // ""),
      (if ((now - ((.statusUpdatedAt // .updatedAt // .startedAt // 0) / 1000)) > 600)
       then (.parkedJobId // "") else "" end) ] | join("\u001f")' "${sf[@]}" 2>/dev/null)
  [ -n "$jqout" ] || return 0
  while IFS="$US" read -r pid sid st ts upd kind job cwd name parked; do
    [ -n "$pid" ] && [ -n "$sid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    # Moving a conversation to the background hands its work to a job and leaves this process
    # sitting on the session list. Claude stamps "busy" at the handoff; if that job is later
    # killed rather than finishing, nothing writes a terminal status back, so the entry reads
    # busy forever — and `kill -0` keeps passing, because the TUI really is alive. Measured:
    # one session read WORKING for 100 minutes at 0% CPU on the list screen.
    #
    # The job directory is the liveness marker — present for every running job, gone once it
    # is killed or removed. Gone means nothing is working on this session's behalf.
    #
    # idle, NOT completed. The registry's own idle already folds to "completed", and a git
    # marker can lift that to REVIEW or DONE; all three assert an outcome, and a killed job
    # produced none. Only the observation is reportable: nothing is happening here.
    #
    # jq gates `parked` on a stale status so a park still settling — the job directory appears
    # as the job starts — is not flickered through IDLE on its way to running. The park is the
    # signal, not the staleness: an ordinary busy session is never downgraded however old its
    # status, because nothing here measures how long one tool call may legitimately take.
    if [ -n "$parked" ] && [ ! -d "$jobsdir/$parked" ]; then st="idle"; fi
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
  local host cache rrows
  while IFS= read -r host; do
    cache="$(remote_cache_for "$host")"
    [ -s "$cache" ] || continue
    # Read via stdin, not a path arg, so native jq.exe isn't handed an MSYS path it
    # can't open. Default mode applies the filter to each object in the concatenated
    # per-session stream (the cache is a `cat` of every remote *.json).
    rrows=$(MSYS_NO_PATHCONV=1 jq -r --argjson now "$now" "
      $JQ_TS | if \$ts > 0 and \$age > 86400 then empty else $JQ_ROW end" < "$cache" 2>/dev/null)
    [ -n "$rrows" ] && rows+="$rrows"$'\n'
  done < <(remote_hosts)
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

sample_usage() {  # write pin_id<TAB>cpu%<TAB>rssMB per local session, for the card to read.
  # Which of these agents is eating the machine is a question the picker could not answer at
  # all, and on a box that has been OOM-killed for it that is the question. agent-manager
  # answers it with a per-session process-tree gauge; this is the same measurement.
  #
  # Deliberately NOT on the render path: it reads a few hundred procfs files and sleeps to get
  # a real interval, so it lives in --refresh-remote (detached, already the home for slow work)
  # and the card reads its cache. Local sessions only — a Windows pid is not checkable from WSL
  # and a homelab one would need an ssh per row.
  #
  # CPU is a DELTA over that interval, not ps's `pcpu`: pcpu averages over the whole process
  # lifetime, so a session that hammered the CPU an hour ago and has been idle since still
  # reads busy. Expressed as a share of total machine capacity, so all sessions together can
  # be compared against the box.
  # shellcheck disable=SC2154  # usage_cache is the parent script's global, like remote_cache
  local tmp="$usage_cache.tmp.$$" f line rest pid ppid t1 rssp
  local -A PARENT=() T1=() T2=() RSSP=() KIDS=()
  local hz ncpu pagekb
  hz=$(getconf CLK_TCK 2>/dev/null); case "$hz" in ''|*[!0-9]*) hz=100;; esac
  ncpu=$(nproc 2>/dev/null); case "$ncpu" in ''|*[!0-9]*) ncpu=1;; esac
  pagekb=$(( $(getconf PAGESIZE 2>/dev/null || echo 4096) / 1024 ))
  [ -d /proc ] || return 0
  # The comm field is parenthesised and can itself contain spaces or ')', so every field is
  # counted from the LAST ')' — the standard way to parse /proc/pid/stat without being fooled
  # by a process that renamed itself.
  for f in /proc/[0-9]*/stat; do
    IFS= read -r line < "$f" 2>/dev/null || continue
    pid="${f#/proc/}"; pid="${pid%/stat}"
    rest="${line##*)}"                      # " S ppid pgrp ... " — field 3 onward
    # shellcheck disable=SC2086  # deliberate word-splitting of the fixed-width stat tail
    set -- $rest
    ppid="$2"; t1=$(( ${11:-0} + ${12:-0} )); rssp="${22:-0}"
    PARENT[$pid]="$ppid"; T1[$pid]="$t1"; RSSP[$pid]="$rssp"
    KIDS[$ppid]="${KIDS[$ppid]:-} $pid"
  done
  # Session pids, from the same state files the rows come from.
  local sf jqout sid spid shost scwd skind sloc
  shopt -s nullglob; sf=( "$statedir"/*.json ); shopt -u nullglob
  [ "${#sf[@]}" -gt 0 ] || return 0
  jqout=$(jq -r --arg self "$selfhost" '
    select((.host // "") == $self and ((.pid // "") | tostring) != "") |
    [((.pid) | tostring), (.host // ""), (.cwd // ""), (.kind // "host"), (.locator // "")]
    | join("")' "${sf[@]}" 2>/dev/null)
  [ -n "$jqout" ] || return 0
  # Descendant sets first, so the second sample only re-reads pids we actually care about.
  local -A TREE=() WANT=()
  local -a queue
  local p c
  while IFS=$'\037' read -r spid shost scwd skind sloc; do
    [ -n "$spid" ] && [ -n "${T1[$spid]:-}" ] || continue
    queue=( "$spid" ); TREE[$spid]=""
    while [ "${#queue[@]}" -gt 0 ]; do
      p="${queue[0]}"; queue=( "${queue[@]:1}" )
      TREE[$spid]="${TREE[$spid]} $p"; WANT[$p]=1
      for c in ${KIDS[$p]:-}; do queue+=( "$c" ); done
    done
  done <<< "$jqout"
  [ "${#WANT[@]}" -gt 0 ] || return 0
  sleep 0.5
  for p in "${!WANT[@]}"; do
    IFS= read -r line < "/proc/$p/stat" 2>/dev/null || continue
    rest="${line##*)}"
    # shellcheck disable=SC2086
    set -- $rest
    T2[$p]=$(( ${11:-0} + ${12:-0} ))
  done
  : > "$tmp" 2>/dev/null || return 0
  local dt=0 rsskb=0 cpu=0 _pid
  local -a OUTID=() OUTCPU=() OUTMEM=()
  local -A IDCNT=()
  while IFS=$'\037' read -r spid shost scwd skind sloc; do
    [ -n "${TREE[$spid]:-}" ] || continue
    dt=0; rsskb=0
    for p in ${TREE[$spid]}; do
      [ -n "${T2[$p]:-}" ] && dt=$(( dt + T2[$p] - ${T1[$p]:-0} ))
      rsskb=$(( rsskb + ${RSSP[$p]:-0} * pagekb ))
    done
    [ "$dt" -lt 0 ] && dt=0
    # ticks over half a second, as a percentage of every core: dt / (hz/2) / ncpu * 100.
    cpu=$(( dt * 200 / hz / ncpu ))
    [ "$cpu" -gt 100 ] && cpu=100
    compute_pin_id "$shost" "$scwd" "$skind" "$sloc"
    OUTID+=( "$_pid" ); OUTCPU+=( "$cpu" ); OUTMEM+=( "$(( rsskb / 1024 ))" )
    IDCNT[$_pid]=$(( ${IDCNT[$_pid]:-0} + 1 ))
  done <<< "$jqout"
  # A row identity is not always unique: background sessions started without a real pane all
  # record the same locator (wezterm:0 in practice), so several live sessions can share one
  # pin id. Keyed lookup would then hand a row its neighbour's numbers. Those entries are
  # written under "?" instead — no card can match it, so an ambiguous row simply shows no
  # usage, while the fleet total (which sums the file) still counts every session.
  local i
  for i in "${!OUTID[@]}"; do
    if [ "${IDCNT[${OUTID[$i]}]}" -gt 1 ]; then
      printf '?\t%s\t%s\n' "${OUTCPU[$i]}" "${OUTMEM[$i]}" >> "$tmp"
    else
      printf '%s\t%s\t%s\n' "${OUTID[$i]}" "${OUTCPU[$i]}" "${OUTMEM[$i]}" >> "$tmp"
    fi
  done
  mv -f "$tmp" "$usage_cache" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  return 0
}

refresh_one_remote() {  # $1 = host. Pull its state, fold its live registry in, replace its cache.
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
  # pre-registry homelab still renders. Multiplexed ssh reuses a persistent master socket
  # (ControlPersist) with fast detection of dead peers (ServerAliveInterval + ServerAliveCountMax),
  # and initial connections fail fast (ConnectTimeout).
  local host="$1" out rc cache status tmp
  cache="$(remote_cache_for "$host")"
  status="$(remote_status_for "$host")"
  tmp="$cache.tmp.$$"
  av_ssh_opts
  out=$(ssh "${AV_SSH_OPTS[@]}" -o BatchMode=yes "${HOST_SSH[$host]}" bash -s <<'REMOTE_FOLD' 2>/dev/null
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
  # Three outcomes, because two of them used to look identical to "no sessions":
  #   255      ssh could not connect, OR connected and then went silent long enough for the
  #            keepalive (ServerAliveInterval/ServerAliveCountMax) to kill it -- OpenSSH exits
  #            255 for "Timeout, server not responding" too, not just a failed connect. Both
  #            cases mean the host isn't answering right now, so both map to unreachable: the
  #            previous snapshot is the best data available either way.
  #   non-zero the host answered but its side failed
  #   0 + empty output is a LEGITIMATE empty roster and does replace the cache
  if [ "$rc" -eq 255 ]; then
    av_write_status "$status" unreachable
    return
  fi
  if [ "$rc" -ne 0 ]; then
    av_write_status "$status" failed
    return
  fi
  # `ok` is gated on the mv actually landing: if it fails (ENOSPC, a read-only $HOME) the
  # cache stays whatever it was while the status would otherwise claim "ok" -- a host that
  # reads fresh while its data is stale, the same lie this file exists to remove, just local.
  # Leaving the status untouched on failure is deliberate: its epoch keeps aging, which
  # self-signals staleness correctly, where writing a fresh unreachable/failed row would not.
  if printf '%s' "$out" > "$tmp" 2>/dev/null && mv -f "$tmp" "$cache" 2>/dev/null; then
    av_write_status "$status" ok
  else
    rm -f "$tmp" 2>/dev/null
  fi
}

gc_orphan_files() {  # remove agentview litter that nothing else ever collects:
  #   ~/.agentview-remote-cache               the single pre-split snapshot, retired when the
  #                                           remote cache became one file per host
  #   <file>.tmp.<pid>                        an atomic write whose writer died before its mv
  #   ~/.agentview-fzfport.<pid>              the picker's --listen port; the EXIT trap removes
  #                                           it normally, a SIGKILLed picker does not
  #   .agentview-remote-{cache,status}.<host> for a host no longer in HOST_SSH
  # Runs once per --refresh-remote, deliberately NOT on the render path: none of this changes
  # what the picker shows, and the render is what the freshness work spent its effort keeping
  # fast. Every rm is best-effort — losing a race to another refresh is not an error.
  local hosts f pid host mins dirs
  hosts="$(remote_hosts)"
  # An empty host table means the caller never loaded one, NOT that every host retired. Acting
  # on that reading would delete the cache of every live host and blank the picker's remote
  # rows, so refuse the whole pass rather than the per-host branch alone.
  [ -n "$hosts" ] || return 0

  rm -f "$HOME/.agentview-remote-cache" 2>/dev/null

  # A dead writer alone is not enough to condemn a tmp file: pids recycle, so one whose number
  # got reused would never be collected, and a live writer mid-mv must never be touched. Require
  # both — a writer that is gone AND a file that has sat unchanged longer than a refresh cycle.
  mins=$(( REAP_GRACE / 60 )); [ "$mins" -lt 1 ] && mins=1
  dirs=( "$HOME" "$HOME/.claude" )
  [ -n "${windir:-}" ] && [ -d "$windir" ] && dirs+=( "$windir" )
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    pid="${f##*.}"
    case "$pid" in ''|*[!0-9]*) continue;; esac
    kill -0 "$pid" 2>/dev/null && continue
    rm -f "$f" 2>/dev/null
  done < <(find "${dirs[@]}" -maxdepth 1 -type f \
             \( -name '.agentview-*.tmp.*' -o -name 'agent-view-*.tmp.*' \
                -o -name '*.json.tmp.*' -o -name '.agentview-fzfport.*' \) \
             -mmin "+$mins" 2>/dev/null)

  # Retired hosts. Gated hardest of the four: this is the only predicate whose false positive
  # deletes live data rather than litter. Host names carrying a dot would mis-split here; the
  # HOST_SSH keys do not, and a new one with a dot would break remote_cache_for's readers too.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    host="${f##*.}"
    [ -n "$host" ] || continue
    printf '%s\n' "$hosts" | grep -qxF "$host" && continue
    rm -f "$f" 2>/dev/null
  done < <(find "$HOME" -maxdepth 1 -type f \
             \( -name '.agentview-remote-cache.*' -o -name '.agentview-remote-status.*' \) \
             ! -name '*.tmp.*' 2>/dev/null)
}

refresh_remote() {  # fan out across every configured host, concurrently
  # Serial would cost the sum of the handshakes on a cold start. This runs off the render
  # path already, but the picker live-reloads when it finishes, so the wait is visible.
  local host p pids=()
  while IFS= read -r host; do
    [ -n "$host" ] || continue
    refresh_one_remote "$host" &
    pids+=("$!")
  done < <(remote_hosts)
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
}

post_reload() {  # $1 = portfile written by fzf's start bind. POST a reload into the live picker.
  # Shared by --refresh-remote (startup + CTRL+F) and the watch loop below, so there is one
  # curl call to keep working instead of two copies drifting apart. Missing curl or an empty
  # port degrades quietly -- the picker just keeps showing what it already has.
  local pf="$1" p self
  command -v curl >/dev/null 2>&1 || return 0
  [ -n "$pf" ] || return 0
  for _ in $(seq 1 40); do [ -s "$pf" ] && break; sleep 0.05; done   # await fzf's port (start-bind)
  p=$(cat "$pf" 2>/dev/null)
  self="${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}"
  [ -n "$p" ] && curl -s -XPOST "127.0.0.1:$p" \
      --data "reload('$self' --body)+refresh-preview" >/dev/null 2>&1
  return 0
}

# How long a quiet picker waits before re-fetching the remote hosts. Local changes do not
# wait for this -- they arrive as inotify events. Validated once here, not just defaulted: a
# non-numeric override would make every `sleep`/`inotifywait -t` below fail or return
# instantly, turning the loop into a busy-spin (see av_watch_once). A floor of 1, not a reject
# of 0: "0" is all-digits and would otherwise sail through as a valid interval, and `sleep 0`
# returns in about 1ms -- which also defeats the floor-sleep backstop below, since that backstop
# IS a `sleep "$AV_WATCH_INTERVAL"`. Raising instead of rejecting also reads "as responsive as
# possible" the way someone setting 0 probably meant it, rather than silently landing on 30.
AV_WATCH_INTERVAL="${AGENT_VIEW_WATCH_INTERVAL:-30}"
case "$AV_WATCH_INTERVAL" in ''|*[!0-9]*) AV_WATCH_INTERVAL=30 ;; esac
[ "$AV_WATCH_INTERVAL" -ge 1 ] || AV_WATCH_INTERVAL=1

# Seconds since the LEAST recently fetched host, read from the status sidecars
# refresh_one_remote already writes ("<outcome>\t<epoch>"). Reusing them keeps the cadence honest
# without introducing new state to keep in sync, and a host with no sidecar reads as epoch 0 --
# infinitely stale -- so the first iteration fetches instead of waiting to discover the hosts.
av_remote_age() {  # -> _av_remote_age (integer seconds)
  local host sf ts oldest now
  now=$(date +%s)
  oldest=""
  while IFS= read -r host; do
    [ -n "$host" ] || continue
    sf="$(remote_status_for "$host")"
    ts=$(cut -f2 "$sf" 2>/dev/null)
    case "$ts" in ''|*[!0-9]*) ts=0 ;; esac
    if [ -z "$oldest" ] || [ "$ts" -lt "$oldest" ]; then oldest="$ts"; fi
  done < <(remote_hosts)
  _av_remote_age=$(( now - ${oldest:-0} ))
}

av_watch_once() {  # $1 = portfile. One iteration: wait for a local change or time out.
  # The blocking wait runs BACKGROUNDED + `wait`ed on, not as a plain foreground command: bash
  # forwards a signal to a shell blocked in `wait` immediately, but does NOT forward one to a
  # shell blocked on a synchronous foreground child -- that child would keep running as an
  # orphan for up to the full interval after the picker's EXIT trap tries to kill this loop.
  # _av_watch_child is deliberately NOT local: av_watch_loop's TERM trap has to reach it.
  local rc
  # A freshly-provisioned box has no statedir until the register hook's first write --
  # inotifywait can't watch a path that doesn't exist, and would error out (rc 1) rather than
  # time out (rc 2), which is exactly the busy-spin case handled below.
  # Both, and for the same reason: inotifywait against a missing path exits 1 (an error), not 2
  # (a timeout), and rc 1 falls into the floor-sleep branch below -- which would quietly turn
  # the whole loop into a plain timer on a box that has not written either directory yet.
  mkdir -p "$statedir" "$sessionsdir" 2>/dev/null
  if command -v inotifywait >/dev/null 2>&1; then
    # -qq stays silent. 2 means "timed out with no event", which is the cue to look at the
    # remote hosts; 0 means a real event fired.
    # $sessionsdir is Claude's own live registry. Daemon-hosted bg jobs never fire the hook that
    # writes $statedir, so without this a local bg job changing state waited for the remote
    # timer. Measured 2026-08-06: 0.74 events/min across the whole registry, against the two
    # repaints a minute the interval already causes -- no debounce needed.
    inotifywait -qq -t "$AV_WATCH_INTERVAL" \
      -e close_write -e create -e delete -e moved_to "$statedir" "$sessionsdir" >/dev/null 2>&1 &
    _av_watch_child=$!
    wait "$_av_watch_child"
    rc=$?
  else
    # No inotify-tools on this machine. Degrade to a plain timer rather than stopping: a
    # picker that silently never repaints is the bug this task exists to fix.
    sleep "$AV_WATCH_INTERVAL" &
    _av_watch_child=$!
    wait "$_av_watch_child"
    rc=$?
    [ "$rc" -eq 0 ] && rc=2   # a completed sleep normalizes to "timeout", same as inotifywait's own
  fi
  # 0 (a real event) and 2 (a clean timeout, from either path above) both already took roughly
  # the interval. Anything else -- inotifywait erroring out (an exhausted inotify watch/instance
  # limit, the target vanishing mid-run) or `sleep` itself failing -- returns near-instantly, so
  # without this floor wait the loop would busy-spin: post_reload's curl and, every iteration,
  # refresh_remote's ssh calls firing as fast as the CPU allows instead of once per interval.
  case "$rc" in
    0|2) : ;;
    *) sleep "$AV_WATCH_INTERVAL" & _av_watch_child=$!; wait "$_av_watch_child"; rc=2 ;;
  esac
  # A timeout still fetches -- nothing local moved, so the remotes are the only thing that can
  # have. But elapsed time fetches too: without it, refresh_remote runs only after an interval of
  # local QUIET, and a steady trickle of local events postpones it indefinitely. That was latent
  # while $statedir alone was nearly silent; watching $sessionsdir makes it reachable.
  av_remote_age
  if [ "$rc" -eq 2 ] || [ "$_av_remote_age" -ge "$AV_WATCH_INTERVAL" ]; then
    refresh_remote
  fi
  post_reload "$1"
  return 0
}

av_watch_loop() {  # $1 = portfile. Runs until the picker's EXIT trap kills it.
  # `kill "$watch_pid"` (executable_agentview's EXIT trap) sends TERM to this process. Trapping
  # it here and killing the in-flight child is what makes that kill take effect immediately
  # instead of after up to a full AV_WATCH_INTERVAL -- see the comment in av_watch_once.
  trap 'kill "${_av_watch_child:-}" 2>/dev/null; exit 0' TERM
  while :; do av_watch_once "$1"; done
}
