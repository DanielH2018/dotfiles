# shellcheck shell=bash
# agentview · actions — destructive/mutating row operations behind CTRL+X, CTRL+P and
# CTRL+R: purge a session on any of the three hosts, toggle its pin, send /rename.
# Sourced by ~/.local/bin/agentview; needs common (win_roster) and focus (remote_alias).
# SC2154: the loader assigns the shared globals this module reads, and shellcheck cannot
# follow a sourced fragment back to it. SC1087: `$E[` builds an ANSI escape, not an array
# index. Both are properties of the module layout above, not of any one line.
# shellcheck disable=SC2154,SC1087

av_purge_local() {  # $1=sid -> REALLY stop + delete a local session. Find Claude's live
  # process via ~/.claude/sessions/<pid>.json whose sessionId == sid (authoritative, and
  # pid-reuse-safe by construction — only the pid Claude currently maps to this session is
  # signalled), kill it, then `claude rm` removes Claude's record + any worktree. AV_KILLCMD
  # is a test seam (defaults to the real kill).
  local sid="$1" pf pid
  [ -n "$sid" ] || return 0
  shopt -s nullglob
  for pf in "$HOME/.claude/sessions"/*.json; do
    [ "$(jq -r '.sessionId // ""' "$pf" 2>/dev/null)" = "$sid" ] || continue
    pid=$(jq -r '.pid // ""' "$pf" 2>/dev/null)
    [ -n "$pid" ] && "${AV_KILLCMD:-kill}" "$pid" 2>/dev/null
  done
  shopt -u nullglob
  command -v claude >/dev/null 2>&1 && claude rm "$sid" </dev/null >/dev/null 2>&1
  return 0
}

av_purge_windows() {  # $1=sid -> stop a Windows Claude session + drop its row, over /mnt/c.
  # The Windows pid is in the row; taskkill.exe /F ends it (WSL's `kill` can't reach a Windows
  # pid). Windows-side `claude rm` isn't cleanly reachable from WSL, so Claude's own session
  # record is left for the Windows side to reap; the agentview row is removed here. AV_WINKILL
  # is a test seam (defaults to the real taskkill.exe).
  local sid="$1" f pid roster
  [ -n "$sid" ] || return 0
  f="$windir/$sid.json"
  pid=$(jq -r '.pid // ""' "$f" 2>/dev/null)
  # A row sync_windows_rows synthesized from the daemon roster carries no pid — only the daemon
  # knows it. Deleting the file alone would not be a removal: the next --refresh-remote asks the
  # roster, still sees the job, and writes the row straight back. So ask the roster for the pid.
  [ -z "$pid" ] && roster=$(win_roster) && pid=$(printf '%s' "$roster" | jq -r --arg sid "$sid" '
    .[] | select((.sessionId // "") == $sid) | (.pid // "" | tostring)' 2>/dev/null | head -1)
  [ -n "$pid" ] && "${AV_WINKILL:-taskkill.exe}" /PID "$pid" /F >/dev/null 2>&1
  rm -f "$f" 2>/dev/null
  return 0
}

av_purge_remote() {  # $1=alias $2=sid -> the same stop+delete on the remote over ssh, incl.
  # dropping the remote's own registry file. sid is a uuid (literal under %q); $HOME and the
  # sessionId lookup evaluate on the remote.
  local alias="$1" sid="$2" script
  [ -n "$sid" ] || return 0
  printf -v script 's=%q; for pf in "$HOME/.claude/sessions/"*.json; do [ -f "$pf" ] || continue; if [ "$(jq -r ".sessionId // \"\"" "$pf" 2>/dev/null)" = "$s" ]; then p="$(jq -r ".pid // \"\"" "$pf" 2>/dev/null)"; [ -n "$p" ] && kill "$p" 2>/dev/null; fi; done; command -v claude >/dev/null 2>&1 && claude rm "$s" </dev/null >/dev/null 2>&1; rm -f "$HOME/.claude/agent-view/$s.json" 2>/dev/null' "$sid"
  av_ssh_opts
  ssh "${AV_SSH_OPTS[@]}" -o BatchMode=yes "$alias" "$script" </dev/null >/dev/null 2>&1
}

# Does THIS registry record describe the row CTRL+X selected? Emits M/N, and every do_remove
# branch matches with it so the three registries can't drift apart. $sid wins when we resolved
# one (see av_sid_for_job) — a bg row's KEY locator is render-time-only and matches no file.
# Otherwise the locator names the row, and a legacy row that never recorded one falls back to
# host+cwd+kind. Both cwds go through `norm`: the KEY's arrives @tsv-doubled ("C:\\Users\\daniel")
# while the registry stores it single, so a raw == could never fire for a Windows path.
JQ_ROWMATCH='((.locator // "")) as $l | ((.session // .key // "")) as $s |
  if   ($sid != "" and $s == $sid)                                       then "M"
  elif ($sid == "" and $loc != "" and $l == $loc)                        then "M"
  elif ($loc == "" and ((.cwd // "")|norm) == ($cwd|norm)
        and (.host // "") == $host and (.kind // "host") == $kind)       then "M"
  else "N" end'

av_sid_for_job() {  # $1=jobId -> echo the session id Claude's live registry maps that job to.
  # A daemon session's row is written by the state hook under its SESSION id and still says
  # kind=host / locator=none:, but the render (merge_session_row) hands the picker a KEY saying
  # kind=bg / locator=bg:<jobId>. Matching that KEY's locator against the file's therefore never
  # fires — which is what made CTRL+X a no-op on every background session. The registry is the
  # only thing that knows job -> session, so ask it and match on the session id instead.
  local job="$1" sf
  [ -n "$job" ] || return 1
  shopt -s nullglob; sf=( "$sessionsdir"/*.json ); shopt -u nullglob
  [ "${#sf[@]}" -gt 0 ] || return 1
  jq -r --arg job "$job" 'select((.jobId // "") == $job) | (.sessionId // "")' "${sf[@]}" 2>/dev/null \
    | grep -m1 . || return 1
}

do_remove() {  # $1 = KEY -> REALLY remove the session (CTRL+X, confirmed): stop its process
  # (pid-reuse-guarded) + `claude rm` its record/worktree + drop the registry row, so a live
  # session can't reappear. Local rows act locally; remote rows act on their host over ssh,
  # then the row is filtered from the ssh cache. An empty KEY (header/spacer) is a no-op.
  local key="$1" host cwd kind locator f m sid rowsid ans name tmp="$remote_cache.tmp.$$"
  local state ts title agetxt sname disp l1 l2 r2 hdr w d e z cdim cfg cred
  host=$(printf '%s' "$key" | cut -d"$US" -f1)
  cwd=$(printf '%s' "$key" | cut -d"$US" -f2)
  state=$(printf '%s' "$key" | cut -d"$US" -f3)
  ts=$(printf '%s' "$key" | cut -d"$US" -f4)
  title=$(printf '%s' "$key" | cut -d"$US" -f5)
  kind=$(printf '%s' "$key" | cut -d"$US" -f7)
  locator=$(printf '%s' "$key" | cut -d"$US" -f8)
  [ -n "$cwd" ] || [ -n "$locator" ] || return 0
  rowsid=""
  name=$(basename "${cwd//\\//}" 2>/dev/null)
  # Confirm in a chooser, not a raw read: inside tmux this bind runs under execute-silent,
  # which hands the child /dev/null for stdin — a `read` there would block forever. Cancel is
  # the first row (and so the default) precisely because a stray <enter> must never destroy
  # a live session.
  #
  # The KEY already carries the whole row, so the popup names WHAT is about to die — task,
  # machine, state, path — rather than just a folder basename. Same age wording as --card.
  agetxt=""
  case "$ts" in ''|*[!0-9]*) :;; *)
    if [ "$ts" -gt 0 ]; then d=$(( now - ts )); [ "$d" -lt 0 ] && d=0
      if   [ "$d" -lt 60 ];    then agetxt="${d}s ago"
      elif [ "$d" -lt 3600 ];  then agetxt="$((d/60))m ago"
      elif [ "$d" -lt 86400 ]; then agetxt="$((d/3600))h ago"
      else agetxt="$((d/86400))d ago"; fi
    fi;;
  esac
  case "$state" in needs-input) sname="needs input";; working) sname="working";;
    review) sname="review";; completed) sname="completed";; *) sname="idle";; esac
  host_label "$host"
  disp="$cwd"; case "$disp" in "$HOME"/*) disp="~${disp#"$HOME"}";; esac
  e=$'\033'; z="$e[0m"
  cdim="$e[38;2;108;112;134m"; cfg="$e[38;2;205;214;244m"; cred="$e[38;2;243;139;168m"
  l1="${title:-$name} · ${_hl:-$host} · ${sname}${agetxt:+ · $agetxt}"
  l2="$disp"
  r2='Remove  · kills the process, deletes the worktree'
  # Size to content so the box has no dead rows: 2 header + 2 options + fzf's own border.
  w=${#l1}; [ "${#l2}" -gt "$w" ] && w=${#l2}; [ "${#r2}" -gt "$w" ] && w=${#r2}
  w=$(( w + 6 )); [ "$w" -lt 46 ] && w=46; [ "$w" -gt 88 ] && w=88
  hdr="${cfg}${l1}${z}"$'\n'"${cdim}${l2}${z}"
  ans=$(printf '%s\n' "Cancel" "${cred}Remove${z}${cdim}${r2#Remove}${z}" \
    | av_pick "$w" 6 --ansi --no-sort --no-input --info=hidden --layout=reverse \
      --border=rounded --border-label=' remove session ' --border-label-pos=3 \
      --pointer='▌' --highlight-line --header-first --header "$hdr" \
      --color='pointer:#f38ba8' 2>/dev/null)
  # --ansi hands back the ORIGINAL line, escape codes and all, so strip them before matching.
  ans=$(printf '%s' "$ans" | sed -e 's/\x1b\[[0-9;:]*m//g')
  case "$ans" in Remove*) ;; *) return 0 ;; esac
  if is_windows_host "$host"; then                  # same machine, Windows-side registry
    shopt -s nullglob
    for f in "$windir"/*.json; do
      m=$(MSYS_NO_PATHCONV=1 jq -r --arg sid "" --arg loc "$locator" --arg cwd "$cwd" \
        --arg host "$host" --arg kind "$kind" "$JQ_NORM$JQ_ROWMATCH" "$f" 2>/dev/null)
      if [ "$m" = "M" ]; then
        sid=$(jq -r '.session // .key // ""' "$f" 2>/dev/null); av_purge_windows "$sid"
      fi
    done
    shopt -u nullglob
    return 0
  fi
  if [ -n "$host" ] && ! is_local_host "$host"; then
    [ -s "$remote_cache" ] || return 0
    # Pull the row's sid so we can stop it on the remote, then filter it from the cache.
    sid=$(MSYS_NO_PATHCONV=1 jq -r --arg sid "" --arg loc "$locator" --arg cwd "$cwd" \
      --arg host "$host" --arg kind "$kind" \
      "$JQ_NORM select(($JQ_ROWMATCH) == \"M\") | (.session // .key // \"\")" \
      < "$remote_cache" 2>/dev/null | head -1)
    [ -n "$sid" ] && av_purge_remote "$(remote_alias "$host")" "$sid"
    MSYS_NO_PATHCONV=1 jq -c --arg sid "" --arg loc "$locator" --arg cwd "$cwd" \
      --arg host "$host" --arg kind "$kind" \
      "$JQ_NORM select((($JQ_ROWMATCH) == \"M\") | not)" \
      < "$remote_cache" > "$tmp" 2>/dev/null && mv -f "$tmp" "$remote_cache" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    return 0
  fi
  # Local (this host). A bg:<jobId> locator is a RENDER-TIME identity no row stores — resolve it
  # to the session id the file is keyed by. Only here: the Windows and homelab registries live on
  # other sides of a boundary, and THIS machine's job ids say nothing about theirs. Empty when the
  # row already stores its own bg: locator, or the registry has no such job — both fall through
  # to the locator arm.
  case "$locator" in bg:?*) rowsid=$(av_sid_for_job "${locator#bg:}") || rowsid="" ;; esac
  shopt -s nullglob
  for f in "$statedir"/*.json; do
    m=$(jq -r --arg sid "$rowsid" --arg loc "$locator" --arg cwd "$cwd" \
      --arg host "$host" --arg kind "$kind" "$JQ_NORM$JQ_ROWMATCH" "$f" 2>/dev/null)
    if [ "$m" = "M" ]; then
      sid=$(jq -r '.session // .key // ""' "$f" 2>/dev/null)
      av_purge_local "$sid"
      rm -f "$f" 2>/dev/null
    fi
  done
  shopt -u nullglob
  return 0
}

do_pin() {  # $1 = KEY -> toggle this row's pin in the sidecar (CTRL+P). Works for local AND
  # remote rows — the pin is keyed by identity, not by a local file. A header/spacer row
  # (empty KEY) is a no-op.
  local key="$1" host cwd kind locator tmp="$pinfile.tmp.$$" _pid
  host=$(printf '%s' "$key" | cut -d"$US" -f1)
  cwd=$(printf '%s' "$key" | cut -d"$US" -f2)
  kind=$(printf '%s' "$key" | cut -d"$US" -f7)
  locator=$(printf '%s' "$key" | cut -d"$US" -f8)
  [ -n "$cwd" ] || [ -n "$locator" ] || return 0
  compute_pin_id "$host" "$cwd" "$kind" "$locator"
  if [ -f "$pinfile" ] && grep -qxF -- "$_pid" "$pinfile" 2>/dev/null; then
    # grep -v exits 1 (not an error) when it filters out the ONLY line — accept 0 and 1 so
    # unpinning the last pin still writes the now-empty file; only a real error (>=2) aborts.
    local rc
    grep -vxF -- "$_pid" "$pinfile" > "$tmp" 2>/dev/null; rc=$?
    if [ "$rc" -le 1 ]; then mv -f "$tmp" "$pinfile" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    else rm -f "$tmp" 2>/dev/null; fi
  else
    printf '%s\n' "$_pid" >> "$pinfile" 2>/dev/null
  fi
  return 0
}

av_send_rename() {  # $1=host $2=locator $3=name -> type "/rename <name>" + Enter into the
  # session's pane so Claude runs its OWN /rename. tmux locally or over ssh; wezterm locally.
  local host="$1" loc="$2" name="$3" backend rest sock pane cmd sshalias
  backend="${loc%%:*}"; rest="${loc#*:}"
  case "$backend" in
    tmux)
      # rest = <socket>:<session>:<pane>; socket + sanitized session carry no ':'.
      pane="${rest##*:}"; rest="${rest%:*}"; sock="${rest%:*}"
      [ -n "$pane" ] && [ -n "$sock" ] || return 1
      if [ -n "$host" ] && ! is_local_host "$host"; then
        sshalias=$(remote_alias "$host")
        printf -v cmd 'tmux -S %q send-keys -t %q -l %q; tmux -S %q send-keys -t %q Enter' \
          "$sock" "$pane" "/rename $name" "$sock" "$pane"
        av_ssh_opts
        ssh "${AV_SSH_OPTS[@]}" -o BatchMode=yes "$sshalias" "$cmd" </dev/null >/dev/null 2>&1
      else
        tmux -S "$sock" send-keys -t "$pane" -l "/rename $name" 2>/dev/null
        tmux -S "$sock" send-keys -t "$pane" Enter 2>/dev/null
      fi ;;
    wezterm)
      pane="$rest"; [ -n "$pane" ] || return 1
      # A Windows-host row and a WSL-host row are panes of the SAME GUI, and pane ids are
      # GUI-global — so the is_windows_host split this used to carry was answering the wrong
      # question. av_wezterm picks the cli that can actually reach that GUI from here.
      av_wezterm send-text --no-paste --pane-id "$pane" "/rename $name"$'\r' >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
  return 0
}

do_rename() {  # $1 = KEY -> run Claude's own /rename in the session's pane (CTRL+R). Types
  # "/rename <name>" + Enter into the tmux/wezterm pane so Claude executes the real command
  # (writing its own custom-title). Needs an addressable pane (not none:) and an idle session
  # — never inject into a working one, where the keys would land mid-task. Remote tmux over ssh.
  local key="$1" host state locator backend name
  host=$(printf '%s' "$key" | cut -d"$US" -f1)
  state=$(printf '%s' "$key" | cut -d"$US" -f3)
  locator=$(printf '%s' "$key" | cut -d"$US" -f8)
  [ -n "$locator" ] || return 0
  backend="${locator%%:*}"
  if [ -z "$backend" ] || [ "$backend" = "none" ]; then
    printf '\n  agentview: this session has no tmux/wezterm pane, so Claude'\''s /rename can'\''t\n  be sent to it — rename it from inside the session instead.\n' >&2; sleep 1.5; return 0
  fi
  if [ "$state" = "working" ]; then
    printf '\n  agentview: session is working — rename it when idle so the keys land at the\n  input prompt, not mid-task.\n' >&2; sleep 1.5; return 0
  fi
  printf '\n  send /rename to this session in Claude:\n' >&2
  IFS= read -r -e -p '  new name> ' name || return 0
  name="${name//$'\n'/ }"; name="${name//$'\r'/ }"
  [ -n "$name" ] || return 0
  av_send_rename "$host" "$locator" "$name"
  return 0
}
