# shellcheck shell=bash
# agentview · focus — everything that turns a row into a focused terminal: locator
# activation, pane resolution, ssh attach for remote rows, Windows-side focus/respawn.
# Sourced by ~/.local/bin/agentview; needs common (win_roster), the JQ_* fragments, and
# actions (do_fold, for jump_or_report's fold: case) — every mode that calls jump_or_report
# loads actions too. The one mode that loads this module without it is --resolve, which
# only calls resolve_key and never jump_or_report.
# SC2154: the loader assigns the shared globals this module reads, and shellcheck cannot
# follow a sourced fragment back to it.
# shellcheck disable=SC2154

# ---- backend focus (the ONLY terminal-specific code) --------------------------
av_activate_locator() {  # $1 = "backend:rest"; returns 0 if it handled focus, else 1
  local loc="$1" backend rest sock tp pane_id _r session
  backend="${loc%%:*}"; rest="${loc#*:}"
  case "$backend" in
    wezterm)
      [ -z "$rest" ] && return 1
      av_wezterm_bin || return 1
      # Immediate activate + a detached, SIGHUP-immune re-activate 0.25s later so
      # closing the picker pane can't steal focus back over the jump.
      av_wezterm --prefer-mux activate-pane --pane-id "$rest" 2>/dev/null
      nohup bash -c "sleep 0.25; '$_wezbin' cli --no-auto-start --prefer-mux activate-pane --pane-id '$rest'" \
        >/dev/null 2>&1 </dev/null &
      return 0 ;;
    tmux)
      command -v tmux >/dev/null 2>&1 || return 1
      # rest = <socket>:<session>:<pane_id>; socket + sanitized session carry no ':'.
      pane_id="${rest##*:}"; _r="${rest%:*}"
      session="${_r##*:}"                      # the attach target when we're not a client
      sock="${_r%:*}"                          # drops the trailing :<session>
      tp="$pane_id"
      [ -z "$tp" ] && return 1
      # Focus the target pane server-side, then bring a client onto it.
      tmux -S "$sock" select-window -t "$tp" 2>/dev/null
      tmux -S "$sock" select-pane -t "$tp" 2>/dev/null
      if [ -n "${TMUX:-}" ]; then
        # Already a tmux client (e.g. the prefix+g popup): move it to the pane. tmux
        # can't raise the OS window hosting the client (documented limitation).
        tmux -S "$sock" switch-client -t "$tp" 2>/dev/null
      else
        # Bare shell: switch-client has no client to move ("no current client"), so
        # attach THIS terminal to the session — the select-pane above lands us on it.
        [ -n "$session" ] || return 1
        tmux -S "$sock" attach-session -t "$session"
      fi
      return 0 ;;
    *) return 1 ;;   # none / unknown -> caller falls back to cwd-correlation
  esac
}

resolve_key() {  # $1 = KEY -> echoes the CLIENT-side pane id to jump to (or nothing)
  # Legacy cwd-correlation for rows with no locator: the stored pane id is only valid
  # in the mux where it was recorded, so it can't be trusted across the local vs.
  # homelab windows. Needs `wezterm cli list`.
  # Stays on the LOCAL cli rather than av_wezterm: this asks what the cli's OWN gui is showing,
  # and routing it to wezterm.exe would put a ~0.4s interop round trip in the render path. From
  # WSL it therefore answers nothing and the caller falls back, exactly as it did before —
  # --no-auto-start only stops that empty answer from costing a stray mux daemon.
  local key="$1" scwd list target
  scwd=$(printf '%s' "$key" | cut -d"$US" -f2)
  [ -z "$scwd" ] && return
  command -v wezterm >/dev/null 2>&1 || return
  # Reuse the render's mux snapshot when we're jumping in-process; only the
  # standalone --resolve/--jump invocations need their own `list` call.
  list="${PANELIST:-}"
  [ -z "$list" ] && list=$(wezterm cli --no-auto-start --prefer-mux list --format json 2>/dev/null)
  [ -z "$list" ] && return
  # Prefer a cwd match whose pane is non-shell (Claude's pane); fall back to any
  # cwd match if every candidate at that cwd is a plain shell.
  target=$(printf '%s' "$list" | MSYS_NO_PATHCONV=1 jq -r --arg cwd "$scwd" "
    $JQ_NORM
    (\$cwd|norm) as \$w | [ .[] | (.cwd|norm) as \$c
      | select(\$c==\$w or (\$w|startswith(\$c)) or (\$c|startswith(\$w)))
      | select($JQ_NONSHELL)
      | .pane_id ] | first // empty" 2>/dev/null)
  [ -z "$target" ] && target=$(printf '%s' "$list" | MSYS_NO_PATHCONV=1 jq -r --arg cwd "$scwd" "
    $JQ_NORM
    (\$cwd|norm) as \$w | [ .[] | (.cwd|norm) as \$c
      | select(\$c==\$w or (\$w|startswith(\$c)) or (\$c|startswith(\$w))) | .pane_id ] | first // empty" 2>/dev/null)
  [ -n "$target" ] && printf '%s' "$target"
}


remote_alias() {  # $1 = row host -> ssh alias, from the HOST_SSH table (falls back to the
  # host name itself for an unmapped remote, rather than the old catch-all to daniel-server).
  printf '%s' "${HOST_SSH[$1]:-$1}"
}

remote_attach_bg() {  # $1=host $2=job id -> `claude attach` a REMOTE daemon session over ssh.
  # The remote analogue of av_jump_bg. A daemon-hosted job has no pane on either side, so the
  # only way in is the daemon's own client — and it must run on the OWNING host: the local
  # `claude` knows nothing about a session hosted elsewhere. Window reuse (cc-<job>) mirrors
  # av_open_claude_cmd, since `claude attach` leaves the session running when its client exits.
  local host="$1" job="$2" sshalias rcmd wname
  command -v ssh >/dev/null 2>&1 || return 1
  # Job ids come from the remote registry (hex/uuid). Reject anything else rather than quote
  # it: the remote command crosses ssh AND (inside tmux) a `sh -c`, where quoting a hostile
  # value is far easier to get wrong than refusing it.
  case "$job" in *[!a-zA-Z0-9._-]*) return 1;; esac
  sshalias=$(remote_alias "$host")
  # A non-interactive ssh gets a bare PATH — ~/.local/bin (where claude installs) is added by
  # the login shell we don't get — so extend PATH remotely. Written WITHOUT double quotes so
  # the string survives the tmux `sh -c` layer below with $HOME/$PATH still unexpanded, i.e.
  # resolved on the remote and not against this machine's environment.
  if [ -n "$job" ]; then rcmd="PATH=\$HOME/.local/bin:\$PATH claude attach $job"; wname="cc-$job"
  else rcmd="PATH=\$HOME/.local/bin:\$PATH claude agents"; wname="agents"; fi
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux select-window -t "=$wname" 2>/dev/null && return 0
    av_ssh_opts_str
    tmux new-window -n "$wname" "ssh $AV_SSH_OPTS_STR-t $sshalias '$rcmd'"
    tmux set-window-option automatic-rename off 2>/dev/null   # keep the name matchable
    return 0
  fi
  av_ssh_opts
  exec ssh "${AV_SSH_OPTS[@]}" -t "$sshalias" "$rcmd"
}

remote_attach() {  # $1=host $2=locator -> open a fresh view ssh-attached at the pane
  local host="$1" loc="$2" backend rest session pane sshalias rcmd
  backend="${loc%%:*}"; rest="${loc#*:}"
  [ "$backend" = "bg" ] && { remote_attach_bg "$host" "$rest"; return $?; }
  [ "$backend" = "tmux" ] || return 1        # only tmux remotes attach; others list-only
  # rest = <socket>:<session>:<pane>
  pane="${rest##*:}"; rest="${rest%:*}"; session="${rest##*:}"
  [ -n "$session" ] && [ -n "$pane" ] || return 1
  sshalias=$(remote_alias "$host")
  # Remote command: select the pane server-side, then attach the client. Two separate
  # tmux calls joined by a shell ';' (not tmux's '\;') so it survives the quoting layers
  # below. Errors (host down, session gone) surface IN the new view, never a silent no-op.
  rcmd="tmux select-pane -t '$pane' 2>/dev/null; tmux attach -t '$session'"
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    # Popup entry point (prefix+g): the picker is a display-popup that dies with its command,
    # so attaching in place would strand the session in a 90%x90% overlay. Use a window —
    # REUSING the one already attached to this remote session, or repeat jumps leak one each.
    # Same reuse trick av_open_claude_cmd applies to bg sessions.
    tmux select-window -t "=$session" 2>/dev/null && return 0
    av_ssh_opts_str
    tmux new-window -n "$session" "ssh $AV_SSH_OPTS_STR-t $sshalias \"$rcmd\""
    tmux set-window-option automatic-rename off 2>/dev/null   # keep the name matchable
    return 0
  fi
  # No tmux: the picker owns its terminal — the dedicated "Agent View" WezTerm tab runs
  # `agentview` as the tab's own command — so attach RIGHT HERE. exec replaces the picker and
  # the session lands in the tab you opened it from. There is deliberately NO `wezterm cli
  # spawn` branch: from WSL that binary reaches its own mux, not the Windows GUI, so it spawned
  # the attach into a pane no window displays. Worse, it was gated on $WEZTERM_PANE and sat
  # ABOVE this line, so whenever WezTerm exported that var it outranked the path that works and
  # the jump became a silent no-op. Errors (host down, session gone) surface here instead.
  command -v ssh >/dev/null 2>&1 || return 1
  av_ssh_opts
  exec ssh "${AV_SSH_OPTS[@]}" -t "$sshalias" "$rcmd"
}

resolve_windows_pane() {  # $1 = the row's cwd -> echo a live Windows pane id serving it (or nothing)
  # The Windows analogue of resolve_key: correlate by cwd against the live mux instead of
  # trusting a recorded pane id. Same two tiers — prefer a pane Claude retitled, fall back to
  # any pane at that cwd. A pane whose cwd norms to "" (the filesystem root) is dropped: every
  # row startswith("") so it would swallow the match and focus an unrelated pane.
  local scwd="$1" list target q
  [ -n "$scwd" ] || return
  [ -x "$WEZTERM_WIN" ] || return
  list=$("$WEZTERM_WIN" cli list --format json 2>/dev/null)
  [ -n "$list" ] || return
  q="$JQ_NORM
    (\$cwd|norm) as \$w | [ .[] | (.cwd|norm) as \$c
      | select(\$c != \"\" and (\$c==\$w or (\$w|startswith(\$c)) or (\$c|startswith(\$w))))"
  target=$(printf '%s' "$list" | MSYS_NO_PATHCONV=1 jq -r --arg cwd "$scwd" \
    "$q | select($JQ_NONSHELL) | .pane_id ] | first // empty" 2>/dev/null)
  [ -z "$target" ] && target=$(printf '%s' "$list" | MSYS_NO_PATHCONV=1 jq -r --arg cwd "$scwd" \
    "$q | .pane_id ] | first // empty" 2>/dev/null)
  [ -n "$target" ] && printf '%s' "$target"
}

win_path() {  # sets _wp = $1 as a forward-slash Windows path Git Bash accepts ("C:/Users/...")
  # A row KEY reaches us through @tsv, which doubles every backslash, so convert then collapse
  # the runs — exactly why JQ_NORM carries gsub("//+";"/"). No UNC paths live in this registry.
  local s="${1//\\//}"
  while [[ "$s" == *//* ]]; do s="${s//\/\///}"; done
  _wp="$s"
}

win_sid_for_row() {  # $1=locator $2=cwd -> echo this row's Windows session id (or nothing)
  # Same match predicate do_remove uses over $windir: trust the locator when the row has one,
  # else fall back to cwd. Every file in $windir is a Windows row, so host/kind add nothing.
  # Both cwds go through `norm` first — the KEY's arrives @tsv-doubled ("C:\\Users") while the
  # registry stores it single ("C:\Users"), so a raw == would never fire and this would quietly
  # degrade to a resume-less respawn.
  local loc="$1" cwd="$2" f sid
  [ -d "$windir" ] || return
  shopt -s nullglob
  for f in "$windir"/*.json; do
    sid=$(MSYS_NO_PATHCONV=1 jq -r --arg loc "$loc" --arg cwd "$cwd" "
      $JQ_NORM
      (\$cwd|norm) as \$w
      | select( (\$loc != \"\" and (.locator // \"\") == \$loc)
             or (\$w != \"\" and ((.cwd // \"\")|norm) == \$w) )
      | (.session // .key // \"\")" "$f" 2>/dev/null)
    [ -n "$sid" ] && break
  done
  shopt -u nullglob
  [ -n "$sid" ] && printf '%s' "$sid"
}

win_agent_live() {  # $1=sid -> echo the daemon's short agent id when that session is still LIVE.
  # 0 = live (id on stdout), 1 = the daemon does not have it, 2 = cannot tell. The distinction
  # matters: "no pane" is NOT "gone". A Windows session detaches from its terminal and keeps
  # running under `claude.exe daemon run`, which holds the pty on \\.\pipe\cc-daemon-*-pty-<id>
  # — that is what a --bg session IS. Panes are therefore a bad liveness proxy and the daemon's
  # own roster is the real one. Never fold 2 into 1: an unreachable oracle would otherwise read
  # as "everything is dead" and every row would look reapable.
  local sid="$1" out aid
  [ -n "$sid" ] || return 2
  out=$(win_roster) || return 2
  aid=$(printf '%s' "$out" | jq -r --arg sid "$sid" '
    .[] | select((.sessionId // "") == $sid) | (.id // "")' 2>/dev/null | head -1)
  [ -n "$aid" ] || return 1
  printf '%s' "$aid"
}

av_attach_windows() {  # $1=agent id -> open the LIVE background session in a new Windows tab.
  # `claude attach <id>` re-hosts the daemon's pty in this terminal and leaves the session
  # running when the tab closes, so repeat jumps cost nothing. It has to run Windows-side:
  # the daemon's pipes are Windows IPC that WSL cannot open, which is also why this is a new
  # tab and not the picker's own — see remote_attach for the backends that do land in place.
  local aid="$1"
  [ -x "$WEZTERM_WIN" ] || return 1
  [ -n "$aid" ] || return 1
  "$WEZTERM_WIN" cli spawn --domain-name local -- \
    "$WIN_GITBASH" -lc "exec claude attach $aid" >/dev/null 2>&1
}

av_respawn_windows() {  # $1=cwd $2=sid -> reopen the session in a NEW Windows tab. 0 on success.
  # Reached only once the daemon has disowned the session too, so there is nothing to attach to
  # and a fresh process is the only way back into the conversation. Mirrors spawn_windows_claude,
  # but lands in the row's own cwd and resumes its conversation.
  local cwd="$1" sid="$2" cmd _wp
  [ -x "$WEZTERM_WIN" ] || return 1
  [ -n "$cwd" ] || return 1
  win_path "$cwd"
  cmd="cd \"$_wp\" 2>/dev/null || cd; exec claude"
  [ -n "$sid" ] && cmd="$cmd --resume $sid"
  "$WEZTERM_WIN" cli spawn --domain-name local -- "$WIN_GITBASH" -lc "$cmd" >/dev/null 2>&1
}

av_activate_windows() {  # $1 = "wezterm:<pane_id>", $2 = the row's cwd -> focus a Windows WezTerm
  # pane from WSL via the Windows wezterm.exe. Pane-ids are GUI-global, so a WSL WezTerm tab can
  # activate a Windows-domain pane; activate-pane reuses the pane (no new tab). Only works when
  # the picker itself runs inside a WezTerm pane (else the cli can't reach the GUI). Mirrors the
  # local wezterm double-activate: immediate + a detached re-activate so closing the picker pane
  # can't steal focus back.
  #
  # The recorded id goes stale and stays stale: a Windows session that outlives its pane id (the
  # mux renumbers on a domain re-attach) keeps writing the old id, because the hook reads
  # $WEZTERM_PANE from the session's own frozen environment and caches it when unset — it cannot
  # notice it is wrong from the inside. So a dead id is re-resolved HERE, by cwd, and a jump that
  # still finds nothing returns non-zero: activate-pane's failure used to be swallowed and
  # reported as success, which is what made <enter> look like a no-op.
  #
  # Tier 3 covers the case neither id nor cwd can: the pane is gone but the process isn't, so
  # the row keeps refreshing and there is nothing to focus. Give it a new Windows tab rather
  # than report failure — a Windows pane can never be attached from WSL the way a tmux one can,
  # so a fresh pane is the only way back into that session.
  local loc="$1" scwd="${2:-}" pane="" sid aid
  [ -x "$WEZTERM_WIN" ] || return 1
  case "$loc" in wezterm:?*) pane="${loc#wezterm:}" ;; esac
  if [ -z "$pane" ] || ! "$WEZTERM_WIN" cli activate-pane --pane-id "$pane" >/dev/null 2>&1; then
    pane=$(resolve_windows_pane "$scwd")
    if [ -n "$pane" ]; then
      "$WEZTERM_WIN" cli activate-pane --pane-id "$pane" >/dev/null 2>&1 || pane=""
    fi
    if [ -z "$pane" ]; then
      sid=$(win_sid_for_row "$loc" "$scwd")
      # Ask the daemon before assuming the session died with its pane — a detached Windows
      # session is still LIVE and attachable, and `--resume`ing one forks a second process onto
      # the same transcript (the docs promise only that the two interleave, which is not a state
      # worth creating deliberately). Attach the running one; only respawn what is really gone.
      if aid=$(win_agent_live "$sid"); then
        av_attach_windows "$aid"; return $?
      fi
      # Not on the roster, or we could not reach it to ask (return 2). Reopening is the honest
      # fallback for the first and the only option for the second.
      av_respawn_windows "$scwd" "$sid"; return $?
    fi
  fi
  nohup bash -c "sleep 0.25; '$WEZTERM_WIN' cli activate-pane --pane-id '$pane'" \
    >/dev/null 2>&1 </dev/null &
  return 0
}

av_open_claude_cmd() {  # $1=claude subcommand string -> run it in a pane of the active
  # backend, REUSING a window that already targets the same session so repeated jumps
  # don't leak a ~400MB pane each (`claude attach` keeps the session alive after its
  # client exits). One window per bg session (cc-<short-sid>), one shared roster window.
  command -v claude >/dev/null 2>&1 || return 1
  local wname sid
  case "$1" in
    "attach "*) sid="${1#attach }"; wname="cc-${sid:0:8}";;
    *)          wname="agents";;
  esac
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux select-window -t "=$wname" 2>/dev/null && return 0   # reuse -> no window leak
    tmux new-window -n "$wname" "claude $1"
    tmux set-window-option automatic-rename off 2>/dev/null   # keep the name stable for reuse
    return 0
  fi
  # No tmux: the picker owns its terminal, so run the session HERE and it lands in the tab you
  # opened the picker from. No wezterm-spawn branch — see remote_attach for why that path was
  # both invisible and higher-priority than this one.
  # intentional word split of the subcommand
  # shellcheck disable=SC2086
  exec claude $1
}

av_jump_bg() {  # $1=locator -> a daemon-hosted bg session has no pane anywhere to
  # focus; `claude attach <sid>` (verified: the session keeps running when the attach
  # client exits) opens THE session. A bg row without a sid falls back to the roster.
  local sid=""
  case "$1" in bg:*) sid="${1#bg:}";; esac
  if [ -n "$sid" ]; then av_open_claude_cmd "attach $sid"
  else av_open_claude_cmd "agents"; fi
}

do_jump() {  # $1 = KEY -> focus the session. Remote rows attach in a fresh local tab;
  # local rows activate in-process (locator-direct, else legacy cwd-correlation);
  # kind=bg rows (daemon background jobs) open the agents UI — they have no pane.
  local key="$1" host kind locator t
  host=$(printf '%s' "$key" | cut -d"$US" -f1)
  kind=$(printf '%s' "$key" | cut -d"$US" -f7)
  locator=$(printf '%s' "$key" | cut -d"$US" -f8)
  if [ -n "$host" ] && ! is_local_host "$host"; then
    remote_attach "$host" "$locator"; return $?     # remote: never touch a local pane
  fi
  if is_windows_host "$host"; then                  # same machine, but a Windows WezTerm pane
    # cwd rides along as the fallback handle for when the recorded pane id is stale.
    av_activate_windows "$locator" "$(printf '%s' "$key" | cut -d"$US" -f2)"; return $?
  fi
  if [ "$kind" = "bg" ]; then av_jump_bg "$locator"; return $?; fi
  if [ -n "$locator" ] && [ "${locator%%:*}" != "none" ]; then
    av_activate_locator "$locator" && return 0
  fi
  t=$(resolve_key "$key"); [ -z "$t" ] && return 1
  av_wezterm_bin || return 1
  av_wezterm --prefer-mux activate-pane --pane-id "$t" 2>/dev/null
  nohup bash -c "sleep 0.25; '$_wezbin' cli --no-auto-start --prefer-mux activate-pane --pane-id '$t'" \
    >/dev/null 2>&1 </dev/null &
  return 0
}

jump_or_report() {  # $1 = KEY -> jump, or say why not. Every entry point that focuses a session
  # goes through here: a jump that fails silently is indistinguishable from a dead keybinding,
  # so the failure must reach the terminal AND the exit status.
  # A fold header has no session behind it, so toggling it (rather than falling into
  # do_jump, which would report "no pane found") is what a fold: key needs. --jump-nth's
  # awk (executable_agentview) already excludes fold: rows from its count, so this guard is
  # a safety net for a direct `agentview --jump fold:<group>`, not the normal path there.
  case "$1" in fold:*) do_fold "$1"; return 0 ;; esac
  do_jump "$1" && return 0
  printf 'agentview: no pane found for that session\n' >&2
  return 1
}
