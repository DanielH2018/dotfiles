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
# shellcheck shell=bash disable=SC1003
# (no shebang — sourced, bash is the nearest shellcheck dialect; SC1003: printf '\033\\'
# is the OSC string terminator ESC-\, not a quote-escape attempt)

# --- Which shell is sourcing us (for the inits that take a --shell arg) ---
if [ -n "$ZSH_VERSION" ]; then _CUR_SHELL=zsh
elif [ -n "$BASH_VERSION" ]; then _CUR_SHELL=bash
else _CUR_SHELL="sh"
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

# Claude Code runs directly — no tmux wrap. The wrap existed so the C-Left
# back-to-Agent-View bind had a layer to catch the key, and agentview is retired, so the
# layer has nothing left to carry.
#
# It also cost more than it bought. A session names its own row by writing an OSC 0 title
# (warp-session-title.sh); inside tmux that sets tmux's pane_title and stops there, because
# Warp sets TERM=xterm-256color, which carries no tsl/fsl capability for tmux to set an outer
# title with. A wrapped session could therefore never label itself. Verified 2026-08-19 both
# ways: the escape written inside the wrap changed nothing, and the same escape written to the
# pane's own pty renamed the row immediately.
#
# What this gives up is reattaching after a dropped ssh connection or a closed window. `ct`
# (dot_local/bin/executable_ct) is the deliberate opt-in: it runs claude under a named
# `tmux new-session -A`, so a session worth protecting is one command away.
claude() {
  case "${1:-}" in
    ''|-c|--continue|-r|--resume|attach|agents) ;;
    *) command claude "$@"; return $? ;;
  esac
  # A $HOME workspace makes Claude Code re-ask its trust prompt on every launch — it never
  # persists there (claude-code#43958). Run a home-dir session from ~/dev, which trusts once
  # and sticks; a real project cwd is left alone. Skip if ~/dev doesn't exist yet.
  if [ "$PWD" = "$HOME" ] && [ -d "$HOME/dev" ]; then
    ( cd "$HOME/dev" && command claude "$@" )
    return $?
  fi
  command claude "$@"
}

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
#
# Interactive shells only. The agent is spawned detached, so it outlives the shell that
# sourced this file, and a non-interactive caller with its own HOME gets a socket path nobody
# will ever reuse — the test suite sources common.sh under a fresh mkdtemp HOME per case and
# accumulated 1,033 unreachable agents (983 MB) in one morning. Nothing is lost by skipping:
# keys are never added here, so an agent a script spawns is empty and authenticates nothing.
case $- in
  *i*)
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
    ;;
esac

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
  # zoxide's hook rides in PROMPT_COMMAND, which is not a safe place to leave it. WezTerm's
  # /etc/profile.d/wezterm.sh vendors bash-preexec on every Linux host here, and its
  # __bp_install rebuilds PROMPT_COMMAND at the first prompt from `${PROMPT_COMMAND:-}` — a
  # scalar read, so it sees only element 0 when the variable is an array. Whether the hook
  # survives depends on where that read lands: it does on daniel-box/daniel-server (inside
  # element 0) and under WSL (systemd makes it an array first, hook at element 2), and it did
  # not in the shell that reported `zoxide: detected a possible configuration issue` — there
  # the hook was gone and zoxide had stopped recording directories. precmd_functions is the
  # durable place: bash-preexec carries that array across its own install, and starship
  # already registers there on these hosts. __zoxide_hook no-ops when $PWD is unchanged, so
  # sitting in both lists costs nothing.
  if [ -n "$BASH_VERSION" ] && [ -n "${bash_preexec_imported:-}${__bp_imported:-}" ]; then
    # Same re-source guard as __osc7_cwd below (A14-16): don't register the hook twice.
    case " ${precmd_functions[*]:-} " in
      *' __zoxide_hook '*) ;;
      *) precmd_functions+=(__zoxide_hook) ;;
    esac
    # zoxide's doctor reads only PROMPT_COMMAND and cannot see precmd_functions, so once a
    # preexec framework owns the prompt its check reports a problem that isn't there.
    _ZO_DOCTOR=0
  fi
  alias zi='zoxide query -i'
  # Escape hatch to use the real cd when zoxide's override gets in the way.
  cdreal() { builtin cd "$@" || return; }
  # Interactive zoxide jump via fzf.
  zz() {
    command -v fzf >/dev/null 2>&1 || { echo "fzf not installed"; return 1; }
    local dir
    # `zoxide query -ls` right-aligns the score, so every row starts with spaces:
    # "  32.0 /path". `^[^ ]* ` matched an empty run at position 0 and ate one space,
    # leaving " 32.0 /path" — which `cd` (aliased to zoxide above) then treated as a
    # query that matched nothing, so this never jumped anywhere.
    dir="$(zoxide query -ls | sed 's/^[[:space:]]*[0-9.]*[[:space:]]*//' | fzf --tac --prompt='zoxide> ')" || return
    cd "$dir" || return
  }
fi

# --- fnm (Fast Node Manager): auto-switch Node per directory ---
command -v fnm >/dev/null 2>&1 && eval "$(fnm env --use-on-cd --shell "$_CUR_SHELL")"

# bat ships a vendored Catppuccin Mocha theme (dot_config/bat/themes) and a post-install
# script builds its cache, but nothing ever SELECTED it — only yazi passed --theme
# explicitly, so every other bat call (including the fzf preview below) rendered in bat's
# Monokai default. An env var rather than a bat config file: the config isn't chezmoi-managed.
command -v bat >/dev/null 2>&1 && export BAT_THEME="Catppuccin Mocha"

# --- fzf: env + previews (the shell keybinding integration lives in each rc) ---
if command -v fzf >/dev/null 2>&1; then
  # Same palette agentview paints its picker with, so ctrl-r/ctrl-t/alt-c match the terminal
  # and the session picker. Set via env so it reaches every fzf; agentview still passes
  # --color on the command line, which fzf applies after this and therefore wins.
  export FZF_DEFAULT_OPTS="--color=bg+:#313244,bg:-1,fg:#cdd6f4,fg+:#ffffff,gutter:-1,hl:#f38ba8,hl+:#f38ba8,header:#9399b2,info:#cba6f7,pointer:#b4befe,prompt:#cba6f7,border:#45475a,label:#bac2de,spinner:#f5e0dc,marker:#a6e3a1"
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
elif command ls --color=auto -d . >/dev/null 2>&1; then
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
    # shellcheck disable=SC2164  # quit-without-cd leaves cwd empty; either way fall through to cleanup
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
mkcd() { mkdir -p -- "$1" && cd -- "$1" || return; }
# Jump to the Obsidian vault. Not CLAUDE_VAULT_DIR: that points at the LLM Wiki that /lint and
# /healthcheck rewrite in place (index.md + frontmatter), a different tree from the personal
# vault — pointing it here would aim those commands at the wrong notes. Override with
# OBSIDIAN_VAULT_DIR on a machine that keeps the vault elsewhere.
vault() {
  local _v="${OBSIDIAN_VAULT_DIR:-$HOME/My_Vault}"
  [ -d "$_v" ] || { echo "vault: no vault at $_v" >&2; return 1; }
  cd "$_v" || return
}
# Drift checks that ignore run_ scripts. A run_onchange_ script whose contents changed reads
# as "pending" to plain `chezmoi verify` and `chezmoi status`, and that is not config drift.
if command -v chezmoi >/dev/null 2>&1; then
  alias czv='chezmoi verify --exclude=scripts'
  alias czs='chezmoi status --exclude=scripts'
  # Bare `chezmoi` only prints help, so spend it on the thing actually done constantly: cd to
  # the source dir. Every invocation WITH arguments passes straight through, so `chezmoi apply`,
  # `diff`, `source-path` and the czv/czs aliases above are untouched. The path is asked of
  # `source-path` rather than hardcoded, because the source dir differs per machine (this WSL
  # clone is ~/.local/share/chezmoi; the Windows one is C:\Users\daniel\dotfiles).
  chezmoi() {
    [ $# -gt 0 ] && { command chezmoi "$@"; return $?; }
    local _src _root
    _src=$(command chezmoi source-path) || return $?
    # .chezmoiroot=home makes source-path report <repo>/home, but the useful landing spot is the
    # repo root — git, the test suite and CLAUDE.md all live there, and home/ is one cd away.
    # Outside a checkout (no git, or a non-repo source) this falls back to the source dir.
    _root=$(cd "$_src" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
    cd "${_root:-$_src}" || return
  }
fi
# shellcheck disable=SC2009  # deliberately shows the full `ps aux` line, which pgrep doesn't
psgrep() { ps aux | grep -i "$1" | grep -v grep; }

# --- HTTP helpers via curlie (prefixed to avoid collisions with system `delete` etc.) ---
if command -v curlie >/dev/null 2>&1; then
  hget()    { curlie GET "$@"; }
  hpost()   { curlie POST "$@"; }
  hput()    { curlie PUT "$@"; }
  hdelete() { curlie DELETE "$@"; }
fi

# --- Dump the clipboard image to a PNG for Claude Code ---
# Claude can't take a clipboard image straight from the terminal, so save it to a file and
# print a Claude-ready `@path` to drop into the prompt. Under WSL the image arrives via WSLg,
# which mirrors the Windows clipboard onto Wayland but offers an image ONLY as image/bmp —
# a format Claude and the Anthropic API reject — so a bmp goes through wl-bmp2png, the same
# converter the xclip shim uses for inline paste.
#
# This used to run `powershell.exe Get-Clipboard -Format Image` and pipe the path to clip.exe.
# Launching a Windows binary from WSL takes the VM-mode interop path, which leaks a permanently
# spinning CPU thread per call (microsoft/WSL#41173, unfixed through WSL 2.9.4). wl-paste/wl-copy
# reach the same clipboard through WSLg and start no Windows process, and the PNG now lands on
# ext4 instead of C:\Temp behind the 9p bridge.
if command -v wl-paste >/dev/null 2>&1; then
  clipimg() {
    # NB: name the result var anything but `status` — that's a special readonly-ish
    # parameter in zsh (mirrors $?), so assigning to it silently breaks the function there.
    local types dir out saved nl
    nl='
'
    types=$(wl-paste -l 2>/dev/null)
    dir="${XDG_CACHE_HOME:-$HOME/.cache}/clipimg"
    mkdir -p "$dir" || return 1
    out="$dir/clip-$(date +%Y%m%d-%H%M%S).png"
    saved=0
    # Match a whole line of wl-paste's newline-separated type list, so image/bmp can't be
    # matched by a longer type that merely contains it.
    case "$nl$types$nl" in
      *"${nl}image/png${nl}"*)
        wl-paste --no-newline --type image/png > "$out" 2>/dev/null && saved=1 ;;
      *"${nl}image/bmp${nl}"*)
        # WSLg's only image mirror. wl-bmp2png exits non-zero on a bmp it can't read.
        command -v wl-bmp2png >/dev/null 2>&1 \
          && wl-paste --type image/bmp 2>/dev/null | wl-bmp2png > "$out" 2>/dev/null \
          && saved=1 ;;
    esac
    if [ "$saved" != 1 ] || [ ! -s "$out" ]; then
      rm -f "$out"
      echo "clipimg: no image on the clipboard (grab one with Win+Shift+S first)" >&2
      return 1
    fi
    local ref="@$out"
    # Put the path on the clipboard so it pastes straight into Claude with one keystroke
    # (paste is Ctrl+Shift+V in WezTerm; Ctrl+C is SIGINT, not copy). This overwrites the
    # image on the clipboard, which is fine — it's already saved to the PNG.
    printf '%s' "$ref" | wl-copy 2>/dev/null
    printf '%s  (copied to clipboard — paste with Ctrl+Shift+V)\n' "$ref"
  }
fi

# --- OSC 7: report cwd so the terminal reopens new tabs/splits in the current dir ---
# WezTerm/Ghostty read OSC 7 to clone the active pane's cwd into a new tab or split. A new
# *window* is pinned back to the WSL home by the terminal config (WezTerm's new-window
# binding falls through to default_cwd), so the rule is: tab & split follow the cwd, a new
# window resets home. Emitted before each prompt (so it tracks cd) via each shell's hook.
__osc7_cwd() { printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-$HOST}" "$PWD"; }
if [ -n "$ZSH_VERSION" ]; then
  # Membership check first: common.sh can be re-sourced (e.g. by non-rc callers),
  # and an unconditional append would register the hook again each time (A14-16).
  # shellcheck disable=SC2004  # zsh array-index expansion, not arithmetic; $ is required
  (( ${precmd_functions[(Ie)__osc7_cwd]} )) || precmd_functions+=(__osc7_cwd)
elif [ -n "$BASH_VERSION" ]; then
  case "$PROMPT_COMMAND" in
    *__osc7_cwd*) ;;
    *) PROMPT_COMMAND="__osc7_cwd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
  esac
fi

# --- WezTerm-only: OSC 133 prompt marks + command-finish notify (Ghostty is native) ---
# 133;A marks each prompt so ScrollToPrompt (CTRL+SHIFT+Up/Down in the WezTerm config)
# can jump between commands — the piece Ghostty gets from `shell-integration = zsh`.
# OSC 777 raises a desktop toast when a command ran >= 10s; the WezTerm config shows it
# only for unfocused panes (notification_handling = "SuppressFromFocusedPane"), which
# reproduces Ghostty's notify-on-command-finish = unfocused. Gated on $WEZTERM_PANE:
# inert under Ghostty, and inside tmux the sequences are swallowed harmlessly.
if [ -n "${WEZTERM_PANE:-}" ]; then
  __wz_preexec() { __wz_t0=$SECONDS; __wz_cmd=$1; }
  __wz_precmd() {
    printf '\033]133;A\033\\'
    if [ -n "${__wz_t0:-}" ]; then
      local dur=$((SECONDS - __wz_t0))
      unset __wz_t0
      if [ "$dur" -ge 10 ]; then
        printf '\033]777;notify;Done in %ss;%s\033\\' "$dur" "${__wz_cmd%%$'\n'*}"
      fi
    fi
  }
  if [ -n "$ZSH_VERSION" ]; then
    # Same re-source guard as __osc7_cwd above (A14-16).
    # shellcheck disable=SC2004  # zsh array-index expansion, not arithmetic; $ is required
    (( ${preexec_functions[(Ie)__wz_preexec]} )) || preexec_functions+=(__wz_preexec)
    # shellcheck disable=SC2004  # zsh array-index expansion, not arithmetic; $ is required
    (( ${precmd_functions[(Ie)__wz_precmd]} )) || precmd_functions+=(__wz_precmd)
  elif [ -n "$BASH_VERSION" ]; then
    case "$PROMPT_COMMAND" in
      *__wz_precmd*) ;;
      *) PROMPT_COMMAND="__wz_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
    esac
    # Timing needs a preexec; ble.sh provides one (sourced before this file in ~/.bashrc)
    # and passes the command as $1. Plain bash keeps the marks and skips the notify.
    type blehook >/dev/null 2>&1 && blehook PREEXEC+=__wz_preexec
  fi
fi

unset _CUR_SHELL
