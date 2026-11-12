# ~/.config/shell/brew.sh — Homebrew's PATH entries, for bash and zsh alike.
#
# Claude Code's Bash tool runs bash, and its snapshot shell is a non-interactive login shell:
# it reads .bash_profile, and .bashrc returns at its interactive check. So this cannot live in
# common.sh (interactive-only) or in .zshrc (zsh-only). It cannot live in env.sh either:
# .zshenv sources that, and macOS's /etc/zprofile then runs path_helper, which moves /usr/bin
# back ahead of gnubin in every login zsh.
#
# Sourced from .bash_profile and .zprofile, which both run after path_helper, and from .zshrc,
# whose fpath and plugin lines read $BREW_PREFIX before common.sh is sourced. Every entry is
# moved to its place rather than skipped when present, so the second and third source change
# nothing, and a login shell whose inherited PATH path_helper reordered gets its order back.
#
# A clean no-op wherever no brew is installed, which is every Linux host here.
# shellcheck shell=sh

# The two candidates, in Homebrew's own order of preference: /opt/homebrew on Apple Silicon,
# /usr/local on Intel. Probed at runtime rather than resolved by chezmoi at apply time, because
# the shell runs on the machine that has the install. A shell that inherited HOMEBREW_PREFIX
# already has MANPATH and the rest from the shell that ran shellenv, so it skips the fork.
if [ -z "${HOMEBREW_PREFIX:-}" ]; then
  for _brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$_brew" ]; then
      eval "$("$_brew" shellenv)"
      break
    fi
  done
  unset _brew
fi
[ -n "${HOMEBREW_PREFIX:-}" ] || return 0

BREW_PREFIX=$HOMEBREW_PREFIX
export HOMEBREW_NO_ENV_HINTS=1

# Removes every copy of $1 from PATH, then puts it first. Parameter expansion only, because
# zsh does not word-split an unquoted $PATH and a sed fork per entry would run in every shell.
_brew_path_front() {
  [ -d "$1" ] || return 0
  _rest=":$PATH:"
  while :; do
    case $_rest in
      *":$1:"*) _rest="${_rest%%:"$1":*}:${_rest#*:"$1":}" ;;
      *) break ;;
    esac
  done
  _rest=${_rest#:}
  _rest=${_rest%:}
  PATH="$1${_rest:+:$_rest}"
}

_brew_path_front "$BREW_PREFIX/sbin"
_brew_path_front "$BREW_PREFIX/bin"

# Unversioned `python`/`pip` from the brew keg.
_brew_path_front "$BREW_PREFIX/opt/python@3.14/libexec/bin"

# gnubin is live only once the coreutils formula is installed — see the Brewfile's note on why
# it is, which is that run_bounded needs timeout(1) and a stock Mac has none.
_brew_path_front "$BREW_PREFIX/opt/coreutils/libexec/gnubin"

# util-linux is keg-only, so brew never links it into $BREW_PREFIX/bin. APPENDED rather than
# prepended, unlike gnubin above, and that direction is deliberate: the only tool in this keg
# that macOS does not already provide is flock — which retention-sweep's lock and bin/land's
# cross-worktree lock both want — while the keg also ships column, getopt, hexdump, logger,
# rename, rev, look and ul, all of which would shadow the BSD versions that scripts on this
# machine already expect. Appending resolves flock and changes nothing that already works.
#
# Note it does NOT supply script(1): brew omits it on macOS because the base system has BSD
# script, so the agentview pty tests that want the util-linux one stay skipped here.
_brew_ul="$BREW_PREFIX/opt/util-linux/bin"
if [ -d "$_brew_ul" ]; then
  case ":$PATH:" in *":$_brew_ul:"*) ;; *) PATH="$PATH:$_brew_ul" ;; esac
fi
unset _brew_ul _rest
unset -f _brew_path_front
export PATH
