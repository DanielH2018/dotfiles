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

# --- Editor ---
export EDITOR='vim'
export VISUAL="$EDITOR"

# --- Claude Code ---
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000

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
  if command -v eza >/dev/null 2>&1; then
    export FZF_CTRL_T_OPTS='--height 40% --layout=reverse --border --info=inline --preview "[ -d {} ] && eza -la --icons --group-directories-first {} || head -n 200 {}"'
    export FZF_ALT_C_OPTS='--preview "eza -la --icons --group-directories-first {}"'
  else
    export FZF_CTRL_T_OPTS='--height 40% --layout=reverse --border --info=inline --preview "if [ -d {} ]; then ls -la {}; else head -n 200 {}; fi"'
    export FZF_ALT_C_OPTS='--preview "ls -la {}"'
  fi
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

# --- Quality-of-life aliases & functions ---
alias c="clear"
alias ..='cd ..'
alias ...='cd ../..'
command -v ncdu >/dev/null 2>&1 && alias duu='ncdu .'
command -v fastfetch >/dev/null 2>&1 && alias sysinfo='fastfetch'
mkcd() { mkdir -p -- "$1" && cd -- "$1"; }
psgrep() { ps aux | grep -i "$1" | grep -v grep; }

# --- HTTP helpers via curlie (prefixed to avoid collisions with system `delete` etc.) ---
if command -v curlie >/dev/null 2>&1; then
  hget()    { curlie GET "$@"; }
  hpost()   { curlie POST "$@"; }
  hput()    { curlie PUT "$@"; }
  hdelete() { curlie DELETE "$@"; }
fi

unset _CUR_SHELL
