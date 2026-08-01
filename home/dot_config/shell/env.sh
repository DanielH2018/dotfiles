# ~/.config/shell/env.sh — non-interactive counterpart to ~/.config/shell/common.sh.
#
# common.sh is sourced only by interactive shells (via .zshrc / .bashrc), so anything that
# must ALSO work for cron, systemd --user, `ssh host cmd`, and agent shells — which read
# .zshenv (zsh), .bash_profile (bash login), or .profile (sh/dash login) but never reach
# common.sh — lives here instead. Sourced from dot_zshenv, dot_bash_profile.tmpl, and
# dot_profile.tmpl; stays POSIX sh (no [[ ]], no arrays) since dot_profile.tmpl is read by
# plain sh/dash login shells and some display managers, not just zsh/bash.
# shellcheck shell=sh

# ~/.local/bin (tmux 3.7b, agentview, cts…) and go/bin must resolve for NON-interactive
# shells too — cron, systemd --user, `ssh host cmd` — not just the interactive shells that
# source common.sh via .zshrc/.bashrc. Idempotent prepend: safe when more than one of
# .zshenv/.bash_profile/.profile sources this file in the same session.
for _d in "$HOME/.local/bin" "$HOME/go/bin"; do
  [ -d "$_d" ] && case ":$PATH:" in *":$_d:"*) ;; *) PATH="$_d:$PATH" ;; esac
done
unset _d
export PATH

# chezmoi's `umask = 0o022` config feeds its target-mode COMPUTATION only, not the mkdir
# syscall — new dirs are created under the *process* umask, so this host's 0007 login umask
# lands them at 0755 &^ 0007 = 0750 and they never match the 0755 chezmoi recorded. That
# leaves a permanent `MM` plus a "changed since chezmoi last wrote it?" TTY prompt, which
# aborts any apply without a terminal. Pin 0022 in a subshell so the private 0007 default
# does not leak into the shell. Must live HERE, not in .zshrc/common.sh: those are
# interactive-only, and the non-interactive applies (cron, systemd --user, `ssh host cmd`,
# agent shells) are precisely the ones that recreate the drift.
chezmoi() { ( umask 0022; command chezmoi "$@" ); }

# Cargo's own env script prepends ~/.cargo/bin to PATH and sets a couple of CARGO_* vars;
# needed in every non-interactive context that might invoke `cargo`/`rustc` directly.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
