# Homebrew — must run in login shells before .zshrc so HOMEBREW_PREFIX is set
# and /opt/homebrew/bin precedes /usr/bin in PATH.
eval "$(/opt/homebrew/bin/brew shellenv)"
