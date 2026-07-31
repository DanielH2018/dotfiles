# shellcheck shell=bash
# agentview · actions — destructive/mutating row operations behind CTRL+X, CTRL+P and
# CTRL+R: purge a session on any of the three hosts, toggle its pin, send /rename.
# Sourced by ~/.local/bin/agentview; needs common (win_roster) and focus (remote_alias).

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
  ssh -o ConnectTimeout=4 -o BatchMode=yes "$alias" "$script" </dev/null >/dev/null 2>&1
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

av_send_text() {  # $1=host $2=locator $3=text -> deliver text into the session's pane as ONE
  # user message and submit it. tmux locally or over ssh; wezterm locally.
  #
  # Two things this deliberately does NOT do, both learned from YoanWai/agent-manager:
  #   * `tmux send-keys -l` is not used. It silently stops at ~1024 bytes, so a long prompt
  #     arrives truncated with no error anywhere — fine for a short /rename, wrong the moment
  #     arbitrary text goes through the same path. load-buffer has no such limit.
  #   * The submitting Enter is a SEPARATE call, after the paste has ended. Sent inside the
  #     paste (the old `"$text\r"` form), a TUI doing paste-burst detection can swallow it and
  #     leave the text sitting unsent in its composer. `paste-buffer -p` keeps the bracketed-
  #     paste markers so the pane app knows where the burst ends; -d drops the buffer after.
  # Bracketed paste is also what makes a multi-line message safe: typed literally, each
  # newline would submit a partial prompt.
  local host="$1" loc="$2" text="$3" backend rest sock pane cmd sshalias tmp buf rc=0
  backend="${loc%%:*}"; rest="${loc#*:}"
  case "$backend" in
    tmux)
      # rest = <socket>:<session>:<pane>; socket + sanitized session carry no ':'.
      pane="${rest##*:}"; rest="${rest%:*}"; sock="${rest%:*}"
      [ -n "$pane" ] && [ -n "$sock" ] || return 1
      buf="av_send_$$"
      if [ -n "$host" ] && ! is_local_host "$host"; then
        sshalias=$(remote_alias "$host")
        # The text travels on ssh's STDIN, never inside the command string: quoting a
        # multi-line prompt through a remote shell is exactly the kind of escaping that
        # breaks on the first unusual character.
        # shellcheck disable=SC2016  # $f is the REMOTE shell's variable — must not expand here
        printf -v cmd 'f=$(mktemp) || exit 1; cat > "$f"; tmux -S %q load-buffer -b %q "$f"; tmux -S %q paste-buffer -p -d -b %q -t %q; tmux -S %q send-keys -t %q Enter; rm -f "$f"' \
          "$sock" "$buf" "$sock" "$buf" "$pane" "$sock" "$pane"
        printf '%s' "$text" | ssh -o ConnectTimeout=4 -o BatchMode=yes "$sshalias" "$cmd" >/dev/null 2>&1 || rc=1
      else
        tmp=$(mktemp "${TMPDIR:-/tmp}/av-send.XXXXXX") || return 1
        printf '%s' "$text" > "$tmp"
        tmux -S "$sock" load-buffer -b "$buf" "$tmp" 2>/dev/null || rc=1
        rm -f "$tmp" 2>/dev/null
        [ "$rc" -eq 0 ] || return 1
        tmux -S "$sock" paste-buffer -p -d -b "$buf" -t "$pane" 2>/dev/null || {
          tmux -S "$sock" delete-buffer -b "$buf" 2>/dev/null; return 1; }
        tmux -S "$sock" send-keys -t "$pane" Enter 2>/dev/null
      fi ;;
    wezterm)
      pane="$rest"; [ -n "$pane" ] || return 1
      # A Windows-host row and a WSL-host row are panes of the SAME GUI, and pane ids are
      # GUI-global — so the is_windows_host split this used to carry was answering the wrong
      # question. av_wezterm picks the cli that can actually reach that GUI from here.
      # No --no-paste on the payload: that types the text as raw keystrokes, so a newline
      # inside it acts as Enter and submits a partial message. Bracketed paste delivers it
      # as one unit; the Enter follows as its own call, outside the burst.
      av_wezterm send-text --pane-id "$pane" -- "$text" >/dev/null 2>&1 || return 1
      av_wezterm send-text --no-paste --pane-id "$pane" -- $'\r' >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
  return "$rc"
}

av_send_rename() {  # $1=host $2=locator $3=name -> run Claude's OWN /rename in the pane.
  av_send_text "$1" "$2" "/rename $3"
}

av_row_sendable() {  # $1=state $2=locator -> 0 when text can be typed into this row's pane.
  # Sets _why to the refusal for the caller to print. Shared by CTRL+R and CTRL+T so the two
  # cannot drift on what counts as a reachable, safe-to-interrupt session.
  local state="$1" locator="$2" backend
  _why=""
  backend="${locator%%:*}"
  if [ -z "$locator" ] || [ -z "$backend" ] || [ "$backend" = "none" ]; then
    _why="this session has no tmux/wezterm pane to type into"; return 1
  fi
  if [ "$backend" = "bg" ]; then
    _why="a background session has no pane — <enter> attaches it first"; return 1
  fi
  # Never inject into a working session: the keys would land mid-task, where Claude's input
  # box is not accepting a new message and the text is simply lost.
  if [ "$state" = "working" ]; then
    _why="session is working — send when it is idle so the keys land at the input prompt"; return 1
  fi
  return 0
}

do_send() {  # $1 = KEY -> type a message into the selected session's pane (CTRL+T), so the
  # agent receives it as a user message without you attaching. The reply lands in the pane;
  # the picker just delivers it.
  local key="$1" host state locator msg
  host=$(printf '%s' "$key" | cut -d"$US" -f1)
  state=$(printf '%s' "$key" | cut -d"$US" -f3)
  locator=$(printf '%s' "$key" | cut -d"$US" -f8)
  [ -n "$locator" ] || return 0
  if ! av_row_sendable "$state" "$locator"; then
    printf '\n  agentview: %s.\n' "$_why" >&2; sleep 1.5; return 0
  fi
  printf '\n  send a message to this session:\n' >&2
  IFS= read -r -e -p '  message> ' msg || return 0
  [ -n "$msg" ] || return 0
  av_send_text "$host" "$locator" "$msg"
  return 0
}

do_rename() {  # $1 = KEY -> run Claude's own /rename in the session's pane (CTRL+R). Types
  # "/rename <name>" + Enter into the tmux/wezterm pane so Claude executes the real command
  # (writing its own custom-title). Needs an addressable pane (not none:) and an idle session
  # — never inject into a working one, where the keys would land mid-task. Remote tmux over ssh.
  local key="$1" host state locator name
  host=$(printf '%s' "$key" | cut -d"$US" -f1)
  state=$(printf '%s' "$key" | cut -d"$US" -f3)
  locator=$(printf '%s' "$key" | cut -d"$US" -f8)
  [ -n "$locator" ] || return 0
  if ! av_row_sendable "$state" "$locator"; then
    printf '\n  agentview: %s — rename it from inside the session instead.\n' "$_why" >&2
    sleep 1.5; return 0
  fi
  printf '\n  send /rename to this session in Claude:\n' >&2
  IFS= read -r -e -p '  new name> ' name || return 0
  name="${name//$'\n'/ }"; name="${name//$'\r'/ }"
  [ -n "$name" ] || return 0
  av_send_rename "$host" "$locator" "$name"
  return 0
}
