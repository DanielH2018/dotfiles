# ~/.config/shell/common.sh — one source of truth for bash (.bashrc) and zsh (.zshrc).
#
# Everything here works identically in both shells: env vars, PATH, aliases, functions,
# and tool init. The few tool inits that need a shell name (starship/zoxide/fnm) detect
# the current shell below. Shell-specific config that genuinely can't be shared —
# completion systems, keybindings, autosuggestions/highlighting, and shell options
# (setopt vs shopt) — stays in each shell's rc file, not here.
#
# Sourced from each rc. Every integration is guarded by `command -v`, so this is a clean
# no-op wherever a tool isn't installed. Keep it POSIX-ish (it's parsed by both shells).

# --- Which shell is sourcing us (for the inits that take a --shell arg) ---
if [ -n "$ZSH_VERSION" ]; then _CUR_SHELL=zsh
elif [ -n "$BASH_VERSION" ]; then _CUR_SHELL=bash
else _CUR_SHELL=sh
fi

# --- Guard against accidental Ctrl+D exit (EOF) ---
# A stray Ctrl+D at an empty prompt otherwise closes the shell (and the WezTerm pane).
# bash: require this many consecutive EOFs before exit; zsh: ignore bare EOF entirely.
export IGNOREEOF=2
[ -n "$ZSH_VERSION" ] && setopt ignore_eof 2>/dev/null

# --- Editor ---
export EDITOR='vim'
export VISUAL="$EDITOR"
# Read man pages in nvim (search, yank, syntax) when it's installed.
command -v nvim >/dev/null 2>&1 && export MANPAGER='nvim +Man!'

# --- Claude Code ---
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000

# --- Vault (LLM Wiki) location for /lint, /healthcheck, /rebuild ---
# The vault lives on the Windows side under WSL; other machines don't have it. Export the var
# only when a candidate path exists, so this is a clean no-op elsewhere (the vault skills skip
# when CLAUDE_VAULT_DIR is unset/absent).
for _vault in "$HOME/Documents/My_Vault" "/mnt/c/Users/$USER/My_Vault"; do
  if [ -d "$_vault" ]; then export CLAUDE_VAULT_DIR="$_vault"; break; fi
done
unset _vault

# --- ssh-agent: one shared agent across all shells/panes ---
# When nothing else already provides an agent (macOS launchd / 1Password set SSH_AUTH_SOCK, so
# we skip there), bind one to a fixed socket so every new shell and WezTerm pane reuses the same
# unlocked keys — unlock a key once, not once per pane. Keys aren't auto-added; the first
# ssh/git that needs one loads it on demand.
if command -v ssh-agent >/dev/null 2>&1 && [ -z "${SSH_AUTH_SOCK:-}" ]; then
  _ssh_sock="${XDG_RUNTIME_DIR:-$HOME}/.ssh-agent.sock"
  export SSH_AUTH_SOCK="$_ssh_sock"
  # ssh-add -l exit codes: 0=agent has keys, 1=agent up but empty, 2=can't reach agent.
  ssh-add -l >/dev/null 2>&1
  if [ "$?" -eq 2 ]; then
    rm -f "$_ssh_sock"
    (umask 077; ssh-agent -a "$_ssh_sock" >/dev/null 2>&1)
  fi
  unset _ssh_sock
fi

# --- PATH (idempotent prepends; brew/python/coreutils paths are macOS-only, set in .zshrc) ---
for _d in "$HOME/.local/bin" "$HOME/go/bin"; do
  [ -d "$_d" ] && case ":$PATH:" in *":$_d:"*) ;; *) PATH="$_d:$PATH" ;; esac
done
unset _d
export PATH

# --- Starship prompt ---
command -v starship >/dev/null 2>&1 && eval "$(starship init "$_CUR_SHELL")"

# --- Zoxide (smart cd) ---
if command -v zoxide >/dev/null 2>&1; then
  eval "$(zoxide init "$_CUR_SHELL" --cmd cd)"
  alias zi='zoxide query -i'
  # Escape hatch to use the real cd when zoxide's override gets in the way.
  cdreal() { builtin cd "$@"; }
  # Interactive zoxide jump via fzf.
  zz() {
    command -v fzf >/dev/null 2>&1 || { echo "fzf not installed"; return 1; }
    local dir
    dir="$(zoxide query -ls | sed 's/^[^ ]* //' | fzf --tac --prompt='zoxide> ')" || return
    cd "$dir"
  }
fi

# --- fnm (Fast Node Manager): auto-switch Node per directory ---
command -v fnm >/dev/null 2>&1 && eval "$(fnm env --use-on-cd --shell "$_CUR_SHELL")"

# --- fzf: env + previews (the shell keybinding integration lives in each rc) ---
if command -v fzf >/dev/null 2>&1; then
  if command -v rg >/dev/null 2>&1; then
    export FZF_DEFAULT_COMMAND='rg --files --hidden --follow --glob "!.git"'
    export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
    export FZF_ALT_C_COMMAND='fd -t d --hidden --follow --exclude .git'
  elif command -v fd >/dev/null 2>&1; then
    export FZF_DEFAULT_COMMAND='fd --hidden --follow --exclude .git'
    export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
    export FZF_ALT_C_COMMAND='fd -t d --hidden --follow --exclude .git'
  fi
  # Previews: syntax-highlighted file view (bat, else head) + rich dir listing
  # (eza, else ls). ctrl-/ cycles the preview pane down/hidden/back.
  if command -v bat >/dev/null 2>&1; then _fzf_fprev='bat -n --color=always {}'; else _fzf_fprev='head -n 200 {}'; fi
  if command -v eza >/dev/null 2>&1; then _fzf_dprev='eza -la --icons --group-directories-first {}'; else _fzf_dprev='ls -la {}'; fi
  export FZF_CTRL_T_OPTS="--height 40% --layout=reverse --border --info=inline --preview '[ -d {} ] && $_fzf_dprev || $_fzf_fprev' --bind 'ctrl-/:change-preview-window(down|hidden|)'"
  export FZF_ALT_C_OPTS="--preview '$_fzf_dprev'"
  unset _fzf_fprev _fzf_dprev
  export FZF_COMPLETION_TRIGGER='**'
fi

# --- Listing aliases (eza if present, else platform ls) ---
if command -v eza >/dev/null 2>&1; then
  alias ls="eza --icons --group-directories-first --git --color=auto"
  alias ll="eza -la --icons --git --time-style=relative"
  alias la="eza -la --icons --git --group-directories-first --time-style=relative"
  alias lt="eza --tree --level=2 --icons -a"
  alias lg="eza -l --git --icons"
elif ls --color=auto -d . >/dev/null 2>&1; then
  # GNU coreutils (Linux / Git Bash)
  alias ls='ls --color=auto --group-directories-first'
  alias ll='ls -lA --color=auto --group-directories-first'
  alias la='ls -lA --color=auto --group-directories-first'
else
  # BSD/macOS ls
  alias ls='ls -G'
  alias ll='ls -lGA'
  alias la='ls -lGA'
fi

# --- fd helper ---
command -v fd >/dev/null 2>&1 && ff() { fd "$1" "${2:-.}" --hidden --follow --exclude .git; }

# --- Yazi wrapper: cd to the last-browsed dir on quit ---
if command -v yazi >/dev/null 2>&1; then
  y() {
    local tmp cwd
    tmp="$(mktemp -t yazi-cwd.XXXXXX)"
    yazi "$@" --cwd-file="$tmp"
    IFS= read -r -d '' cwd < "$tmp"
    [ -n "$cwd" ] && [ "$cwd" != "$PWD" ] && builtin cd -- "$cwd"
    rm -f -- "$tmp"
  }
fi

# --- fastfetch: system-info banner with the best logo/image protocol per terminal ---
# One implementation for both shells (bash and zsh diverged here before): each rc calls it
# in its login-only block, and `sysinfo` runs it on demand. Windows ships a trimmed-logo
# dir (chezmoiignore'd elsewhere) for a random iterm image; other terminals pick their
# native protocol; everything else falls back to fastfetch's own globbed logo.
if command -v fastfetch >/dev/null 2>&1; then
  _ff_banner() {
    local dir="$HOME/.config/fastfetch/logos-trimmed" logo=""
    if [ -d "$dir" ]; then
      # `command ls` bypasses the eza alias above; list+grep (no glob) stays nomatch-safe
      # in zsh. sort -R makes the pick random.
      logo="$(command ls "$dir" 2>/dev/null | grep -i '\.png$' | sort -R | head -n1)"
      [ -n "$logo" ] && logo="$dir/$logo"
    fi
    if [ -n "$logo" ]; then
      command fastfetch --logo-type iterm --logo "$logo" --logo-width 24 --logo-height 12 \
        --logo-preserve-aspect-ratio --logo-padding-right 1
    elif [ "$TERM_PROGRAM" = "ghostty" ]; then
      command fastfetch --logo-type kitty-direct
    elif [ "$TERMINAL_EMULATOR" = "JetBrains-JediTerm" ]; then
      command fastfetch --logo-type small
    else
      command fastfetch
    fi
  }
  # `sysinfo` runs the banner on demand. Under bash+ble.sh the image probe collides with
  # ble.sh's terminal-query handling and fastfetch falls back to the ASCII logo, so re-run
  # _ff_banner in a clean --norc subshell (no ble.sh = clean terminal I/O, image renders).
  # zsh's line-editor plugins don't interfere, so it calls _ff_banner directly.
  sysinfo() {
    if [ -n "$BASH_VERSION" ] && [ -n "${BLE_VERSION-}" ]; then
      command bash --norc --noprofile -c "$(declare -f _ff_banner); _ff_banner"
    else
      _ff_banner
    fi
  }
fi

# --- fzf + git helpers (ported from hendrikmi/dotfiles) ---
# Functions (not zsh ZLE widgets) so they work the same under bash+ble.sh and zsh.
# `while read` instead of `xargs -o` (that flag is BSD-only; breaks on GNU/Git Bash).
if command -v fzf >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  # Check out a branch picked with fzf.
  gcofzf() {
    local b
    b=$(git branch --format='%(refname:short)' | fzf) || return
    [ -n "$b" ] && git checkout "$b"
  }
  # Stage modified/untracked files picked with fzf (Tab = multi-select).
  gafzf() {
    git ls-files -m -o --exclude-standard | grep -v '__pycache__' \
      | fzf -m --preview 'git diff --color=always -- {}' \
      | while IFS= read -r f; do [ -n "$f" ] && git add -- "$f"; done
  }
  # Unstage (git restore --staged) files picked with fzf.
  grsfzf() {
    git diff --name-only --cached \
      | fzf -m --preview 'git diff --color=always --cached -- {}' \
      | while IFS= read -r f; do [ -n "$f" ] && git restore --staged -- "$f"; done
  }
  # Discard working-tree changes (git restore) for files picked with fzf.
  grfzf() {
    git diff --name-only \
      | fzf -m --preview 'git diff --color=always -- {}' \
      | while IFS= read -r f; do [ -n "$f" ] && git restore -- "$f"; done
  }
fi

# Search shell history with fzf and run the chosen command.
if command -v fzf >/dev/null 2>&1; then
  fh() {
    local cmd
    if [ -n "$ZSH_VERSION" ]; then
      cmd=$(fc -l 1 | sed 's/^[[:space:]]*[0-9]*[[:space:]]*//' | fzf --tac +s) || return
    else
      cmd=$(history | sed 's/^[[:space:]]*[0-9]*[[:space:]]*//' | fzf --tac +s) || return
    fi
    [ -n "$cmd" ] && eval "$cmd"
  }
fi

# --- Quality-of-life aliases & functions ---
alias c="clear"
alias ..='cd ..'
alias ...='cd ../..'
command -v ncdu >/dev/null 2>&1 && alias duu='ncdu .'
mkcd() { mkdir -p -- "$1" && cd -- "$1"; }
psgrep() { ps aux | grep -i "$1" | grep -v grep; }

# --- HTTP helpers via curlie (prefixed to avoid collisions with system `delete` etc.) ---
if command -v curlie >/dev/null 2>&1; then
  hget()    { curlie GET "$@"; }
  hpost()   { curlie POST "$@"; }
  hput()    { curlie PUT "$@"; }
  hdelete() { curlie DELETE "$@"; }
fi

# --- WSL: dump the Windows clipboard image to a PNG for Claude Code ---
# WSL can't hand a clipboard image straight to Claude (the WSLg clipboard bridge carries text,
# and Windows stores screenshots as a BMP that Claude often can't decode). So save the clipboard
# image to a PNG on the Windows side and print a Claude-ready `@path` to drop into the prompt.
# powershell.exe isn't on PATH here (interop.appendWindowsPath=false), so resolve it directly;
# gate the definition on its presence to stay a no-op off Windows/WSL.
if command -v powershell.exe >/dev/null 2>&1 \
   || [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  clipimg() {
    local ps=powershell.exe
    command -v powershell.exe >/dev/null 2>&1 \
      || ps=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
    # NB: name the result var anything but `status` — that's a special readonly-ish
    # parameter in zsh (mirrors $?), so assigning to it silently breaks the function there.
    local name res
    name="clip-$(date +%Y%m%d-%H%M%S).png"
    res=$("$ps" -NoProfile -Command \
      "\$img = Get-Clipboard -Format Image; if (\$img) { New-Item -ItemType Directory -Force -Path 'C:\\Temp' | Out-Null; \$img.Save('C:\\Temp\\$name'); 'saved' } else { 'no-image' }" \
      2>/dev/null | tr -d '\r\n')
    if [ "$res" = "saved" ]; then
      local ref="@/mnt/c/Temp/$name"
      # Put the path on the Windows clipboard so it pastes straight into Claude with one
      # keystroke (paste is Ctrl+Shift+V in WezTerm; Ctrl+C is SIGINT, not copy). This
      # overwrites the image on the clipboard, which is fine — it's already saved to the PNG.
      # clip.exe isn't on PATH here either, so call it by full path.
      local clip=clip.exe
      command -v clip.exe >/dev/null 2>&1 || clip=/mnt/c/Windows/System32/clip.exe
      [ -x "$clip" ] && printf '%s' "$ref" | "$clip"
      printf '%s  (copied to clipboard — paste with Ctrl+Shift+V)\n' "$ref"
    else
      echo "clipimg: no image on the Windows clipboard (grab one with Win+Shift+S first)" >&2
      return 1
    fi
  }
fi

# --- WSL: autostart the Windows-clipboard image bridge (wsl-clip-bridge) ---
# WSLg-only. Runs the bridge daemon once per WSL session so Alt+V pastes a Windows-clipboard
# image into Claude Code (keybinding lives in ~/.claude/keybindings.json). Guarded by
# $WAYLAND_DISPLAY (unset off WSLg) and the binary's presence, so it's a no-op elsewhere.
# The "already running?" check is a cheap Linux-side pgrep, not the tool's tasklist.exe-based
# --status — running a Windows process on every shell start would add real prompt latency.
if [ -n "$WAYLAND_DISPLAY" ] && command -v wsl-clip-bridge >/dev/null 2>&1; then
  # Serialize with other shells via flock: opening several panes at once otherwise races —
  # each passes the check, several wrappers launch, their listeners collide on the Win32
  # single-instance mutex, and the losers orphan (leaving no listener at all). One shell wins
  # the lock and launches; the rest recheck inside it and no-op. Match the daemon's exe path
  # ('bin/wsl-clip-bridge'), not a bare name, so the check can't false-positive on a
  # `tail ~/.cache/wsl-clip-bridge/bridge.log`.
  (
    flock -w 2 9 || exit 0
    pgrep -f 'bin/wsl-clip-bridge' >/dev/null 2>&1 || { nohup wsl-clip-bridge >/dev/null 2>&1 & disown; }
  ) 9>"${XDG_RUNTIME_DIR:-/tmp}/wsl-clip-bridge.autostart.lock" 2>/dev/null
fi

# --- OSC 7: report cwd so the terminal reopens new tabs/splits in the current dir ---
# WezTerm/Ghostty read OSC 7 to clone the active pane's cwd into a new tab or split. A new
# *window* is pinned back to the WSL home by the terminal config (WezTerm's new-window
# binding falls through to default_cwd), so the rule is: tab & split follow the cwd, a new
# window resets home. Emitted before each prompt (so it tracks cd) via each shell's hook.
__osc7_cwd() { printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-$HOST}" "$PWD"; }
if [ -n "$ZSH_VERSION" ]; then
  precmd_functions+=(__osc7_cwd)
elif [ -n "$BASH_VERSION" ]; then
  PROMPT_COMMAND="__osc7_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi

unset _CUR_SHELL
