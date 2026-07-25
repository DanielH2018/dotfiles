# shellcheck shell=bash
# agentview · spawn — interactive new-session flow (CTRL+N) and its backend launchers.
# Sourced by ~/.local/bin/agentview for --spawn only; relies on the config globals,
# av_pick and av_wezterm that the main script defines before loading this.

# ---- new-session spawn (bonus): start a claude-sandbox session from the picker ----
# Repos live under ~/Repositories (claude-sandbox's own convention); the launcher is on
# PATH or at its deployed path. Both overridable (tests / non-standard layouts).
repos_root="${SANDBOX_REPOS_ROOT:-$HOME/Repositories}"
sandbox_bin="${CLAUDE_SANDBOX_BIN:-}"
if [ -z "$sandbox_bin" ]; then
  if command -v claude-sandbox >/dev/null 2>&1; then sandbox_bin="claude-sandbox"
  else sandbox_bin="$HOME/.claude/sandbox/claude-sandbox"; fi
fi

# Named-session launchers (jumpable): prefer them on PATH, else their deployed path.
ct_bin="${AGENT_VIEW_CT_BIN:-}"
if [ -z "$ct_bin" ]; then
  if command -v ct >/dev/null 2>&1; then ct_bin="ct"; else ct_bin="$HOME/.local/bin/ct"; fi
fi
cts_bin="${AGENT_VIEW_CTS_BIN:-}"
if [ -z "$cts_bin" ]; then
  if command -v cts >/dev/null 2>&1; then cts_bin="cts"; else cts_bin="$HOME/.local/bin/cts"; fi
fi

# First row of the repo pick: no repo at all -> a plain HOST claude session (no sandbox).
host_row='[no repo · plain claude]'

spawn_pick_host() {  # echo wsl | pc | remote:<alias> (empty = cancel). Reachable hosts only.
  local rows sel h label
  rows="WSL"
  is_windows_host "$winhost" && [ -x "$WEZTERM_WIN" ] && rows="$rows"$'\n'"PC (Windows)"
  for h in "${!HOST_SSH[@]}"; do rows="$rows"$'\n'"${HOST_LABEL[$h]:-$h}"; done
  sel=$(printf '%s\n' "$rows" | av_pick 46% 30% --prompt 'host> ' --layout=reverse \
    --border=rounded --info=hidden --pointer='▌' --highlight-line \
    --header 'new session · pick a host · esc cancels')
  [ -n "$sel" ] || return 0
  [ "$sel" = "WSL" ] && { printf 'wsl'; return 0; }
  [ "$sel" = "PC (Windows)" ] && { printf 'pc'; return 0; }
  for h in "${!HOST_SSH[@]}"; do
    if [ "$sel" = "${HOST_LABEL[$h]:-$h}" ]; then printf 'remote:%s' "${HOST_SSH[$h]}"; return 0; fi
  done
  return 0
}

spawn_pick_mode() {  # echo sandbox | native (empty = cancel). WSL repo only.
  local sel
  sel=$(printf 'sandbox\nnative\n' | av_pick 62% 26% --prompt 'mode> ' --layout=reverse \
    --border=rounded --info=hidden --pointer='▌' --highlight-line \
    --header 'sandbox = claude-sandbox (cts) · native = plain claude (ct) · esc cancels')
  case "$sel" in
    sandbox) printf 'sandbox' ;;
    native)  printf 'native' ;;
    *)       return 0 ;;
  esac
}

spawn_pick_repo() {  # $1 = host (wsl | remote:<alias>) -> repo path/NAME, @host, or empty
  local host="$1" names sel d
  if [ "$host" = "wsl" ]; then
    names=$(for d in "$repos_root"/*/; do
      [ -d "$d/.git" ] || continue                  # real checkout; a .git FILE = linked worktree
      printf '%s\n' "$(basename "${d%/}")"
    done | sort)
  else                                              # remote:<alias> -> ctw over ssh (cached)
    names=$("$cts_bin" --complete-repos "${host#remote:}" 2>/dev/null | sort -u)
  fi
  sel=$({ printf '%s\n' "$host_row"; [ -n "$names" ] && printf '%s\n' "$names"; } \
    | av_pick 58% 60% --prompt 'repo> ' --layout=reverse --border=rounded --info=hidden \
      --pointer='▌' --highlight-line \
      --header 'new session · no repo = plain claude · esc cancels')
  [ -n "$sel" ] || return 0
  if   [ "$sel" = "$host_row" ]; then printf '@host'
  elif [ "$host" = "wsl" ];      then printf '%s' "$repos_root/$sel"
  else printf '%s' "$sel"; fi                        # remote: pass the NAME (ctw resolves it)
}

spawn_pick_branch() {  # $1=host $2=repo -> branch (empty = main repo, no worktree)
  local host="$1" repo="$2" out src
  if [ "$host" = "wsl" ]; then
    src=$("$sandbox_bin" "$repo" --complete-branches 2>/dev/null)
  else
    src=$("$cts_bin" --complete-branches "${host#remote:}" "$repo" 2>/dev/null)
  fi
  # --print-query so the user can TYPE a new branch (cts/-b creates it) or pick one; the
  # typed query is the last line. Empty selection = the main checkout.
  out=$(printf '%s\n' "$src" | av_pick 58% 60% --prompt 'branch> ' --layout=reverse \
    --border=rounded --info=hidden --print-query --pointer='▌' --highlight-line \
    --header 'pick or type a branch (-b) · empty/esc = main repo' | tail -1)
  printf '%s' "$out"
}

spawn_windows_claude() {  # open a plain Windows-native claude in a NEW local-domain WezTerm tab
  # via the Windows wezterm.exe. The tab runs git_bash (Windows), where `claude` is on PATH; the
  # session registers itself over /mnt/c and appears via gather_windows_rows, focusable via Slice 2.
  # One home tab per new session — no proliferation on jump. `exec claude` so bash REPLACES itself:
  # the pane's process becomes node/claude, so WezTerm's CTRL+Left (which passes through when the
  # foreground process looks like a shell) reads it as non-shell and opens the picker instead.
  [ -x "$WEZTERM_WIN" ] || return 1
  # Spawn the WINDOWS git bash by absolute path — a bare `bash` here resolves into WSL
  # (wrong $HOME, wrong claude), so the session never lands on the Windows side and its
  # hooks never write a Windows row. $win_spawn_dir is left unquoted so a leading `~`
  # expands on the Windows side (git_bash $HOME).
  "$WEZTERM_WIN" cli spawn --domain-name local -- "$WIN_GITBASH" -lc "cd $win_spawn_dir 2>/dev/null || cd; exec claude" >/dev/null 2>&1
}

spawn_in_backend() {  # $1=inner (new-pane cmd) $2=title $3=named (bare-shell named-session cmd)
  local inner="$1" title="$2" named="${3:-$1}"
  # Inside tmux: a new window IS a jumpable pane — run the raw inner command there. (We do
  # NOT let cts/ct switch-client from under a live fzf execute(); see the design's placement
  # note.)
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux new-window -n "$title" "$inner"; return 0
  fi
  # Deliberately NOT routed through av_wezterm: this one only makes sense where the local cli
  # owns the GUI. From WSL it does not, and wezterm.exe would resolve the bare `bash` on the
  # Windows side (the reason the Windows spawns below name $WIN_GITBASH explicitly). So WSL
  # falls through to the named-tmux launcher, which is the jumpable outcome anyway.
  if [ -z "${WSL_DISTRO_NAME:-}" ] && [ -n "${WEZTERM_PANE:-}" ] && command -v wezterm >/dev/null 2>&1; then
    wezterm cli --no-auto-start spawn -- bash -lc "$inner" >/dev/null 2>&1; return 0
  fi
  # Bare shell (no mux): exec the NAMED launcher so the session lands in a named, jumpable
  # tmux session — the case cts/ct exist to fix. Replaces the picker's tty, as before.
  exec bash -c "$named"
}

av_close_picker() {  # $1=portfile -> tell the live picker to abort, dismissing its popup/tab
  # after a NEW session actually spawned. Detached + brief delay so the POST lands after fzf
  # returns from THIS ctrl-n execute() to its event loop (the --listen server is quiescent
  # while an execute child runs). No portfile / no curl -> silent no-op, so the standalone
  # `--spawn` path and the bare-shell in-place spawn (which replaces the picker anyway) are
  # unaffected. Mirrors --refresh-remote's detached reload POST.
  local pf="${1:-}" p
  [ -n "$pf" ] && [ -s "$pf" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  p=$(cat "$pf" 2>/dev/null); [ -n "$p" ] || return 0
  nohup bash -c "sleep 0.1; curl -s -XPOST '127.0.0.1:$p' --data abort >/dev/null 2>&1" \
    >/dev/null 2>&1 </dev/null &
}

do_spawn() {  # interactive: pick host -> repo -> (mode) -> branch, spawn in the active backend.
  local host repo branch mode pf="${1:-}" rc inner named title alias
  host=$(spawn_pick_host) || return 1
  [ -n "$host" ] || return 0                        # cancelled at the host pick
  if [ "$host" = "pc" ]; then
    spawn_windows_claude; rc=$?
    [ "$rc" -eq 0 ] && av_close_picker "$pf"
    return "$rc"
  fi
  if [ "${host#remote:}" != "$host" ]; then          # remote:<alias>
    alias="${host#remote:}"
    repo=$(spawn_pick_repo "$host") || return 1
    [ -n "$repo" ] || return 0
    if [ "$repo" = "@host" ]; then
      inner="$(printf '%q --ssh=%q' "$cts_bin" "$alias")"; title="${HOST_LABEL[$alias]:-$alias}"
    else
      branch=$(spawn_pick_branch "$host" "$repo")
      if [ -n "$branch" ]; then
        inner="$(printf '%q --ssh=%q %q -b %q' "$cts_bin" "$alias" "$repo" "$branch")"
      else
        inner="$(printf '%q --ssh=%q %q' "$cts_bin" "$alias" "$repo")"
      fi
      title="$repo"
    fi
    spawn_in_backend "$inner" "$title" "$inner"; rc=$?   # inner == named for remote
    [ "$rc" -eq 0 ] && av_close_picker "$pf"
    return "$rc"
  fi
  repo=$(spawn_pick_repo "$host") || return 1
  [ -n "$repo" ] || return 0
  if [ "$repo" = "@host" ]; then
    inner='cd ~/dev 2>/dev/null || cd; claude'
    named="$(printf '%q %q' "$ct_bin" "$HOME/dev")"
    spawn_in_backend "$inner" 'claude' "$named"; rc=$?
    [ "$rc" -eq 0 ] && av_close_picker "$pf"
    return "$rc"
  fi
  mode=$(spawn_pick_mode) || return 1
  [ -n "$mode" ] || return 0                        # cancelled at the mode pick
  if [ "$mode" = "native" ]; then
    inner="$(printf 'cd %q 2>/dev/null || cd; claude' "$repo")"
    named="$(printf '%q %q' "$ct_bin" "$repo")"
  else
    branch=$(spawn_pick_branch "$host" "$repo")
    if [ -n "$branch" ]; then
      inner="$(printf '%q %q -b %q' "$sandbox_bin" "$repo" "$branch")"
      named="$(printf '%q %q -b %q' "$cts_bin" "$repo" "$branch")"
    else
      inner="$(printf '%q %q' "$sandbox_bin" "$repo")"
      named="$(printf '%q %q' "$cts_bin" "$repo")"
    fi
  fi
  spawn_in_backend "$inner" "$(basename "$repo")" "$named"; rc=$?
  [ "$rc" -eq 0 ] && av_close_picker "$pf"
  return "$rc"
}
