# ~/.config/shell/env.sh — non-interactive counterpart to ~/.config/shell/common.sh.
#
# common.sh is sourced only by interactive shells (via .zshrc / .bashrc), so anything that
# must ALSO work for cron, systemd --user, `ssh host cmd`, and agent shells — which read
# .zshenv (zsh), .bash_profile (bash login), or .profile (sh/dash login) but never reach
# common.sh — lives here instead. Sourced from dot_zshenv, dot_bash_profile.tmpl, and
# dot_profile.tmpl; stays POSIX sh (no [[ ]], no arrays) since dot_profile.tmpl is read by
# plain sh/dash login shells and some display managers, not just zsh/bash.
# shellcheck shell=sh

# ~/.local/bin (source-built tmux, cc-wait, claude-guard…) and go/bin must resolve for NON-interactive
# shells too — cron, systemd --user, `ssh host cmd` — not just the interactive shells that
# source common.sh via .zshrc/.bashrc. Idempotent prepend: safe when more than one of
# .zshenv/.bash_profile/.profile sources this file in the same session.
for _d in "$HOME/.local/bin" "$HOME/go/bin"; do
  [ -d "$_d" ] && case ":$PATH:" in *":$_d:"*) ;; *) PATH="$_d:$PATH" ;; esac
done
unset _d
# In a distrobox/toolbox, ~/.local/bin is the host's: its source-built tmux cannot load on the
# container's libc. claude-packages.sh builds the container's own copy into /usr/local/bin.
if [ -f "${TOOLBOXENV_MARKER:-/run/.toolboxenv}" ]; then
  case "$PATH:" in /usr/local/bin:*) ;; *) PATH="/usr/local/bin:$PATH" ;; esac
fi
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

# A shell with no controlling terminal has nowhere to prompt for a sudo password, so sudo
# refuses outright: "sudo: a terminal is required to read the password". That covers every
# non-interactive path — Claude Code's `!` commands, `ssh host cmd`, systemd --user units — and
# no amount of retrying fixes it, because the failure is structural rather than transient.
# SUDO_ASKPASS is sudo's own escape hatch, and pointing at it here is half the fix; /etc/sudoers
# and /etc/sudo.conf stay untouched. The other half is -A. sudo(8) claims the helper is used
# "if no terminal is available or if the -A option is specified", but on Ubuntu 24.04 only the
# second half is true (measured on daniel-box 2026-08-01: exported and verified in the calling
# shell, plain sudo still refused; with -A it prompted) — which is what ~/.local/bin/sudo is
# for on those hosts. macOS is the same: measured on this laptop 2026-08-04 (sudo 1.9.17p2),
# plain sudo refused with SUDO_ASKPASS exported and valid, and `sudo -A -v` drew the dialog
# and authenticated. So -A is required here too, and the shim deploys here as well rather
# than leaving it to be typed. Nothing is weakened — the
# password is still required, it is just typed into a Plasma dialog instead of a terminal, and
# an interactive shell that HAS a tty keeps prompting there as before.
# Guarded on a graphical session because ksshaskpass cannot draw without one: over plain ssh,
# leaving SUDO_ASKPASS unset yields sudo's own clear error rather than a helper that dies
# silently and looks like a wrong password.
if [ -x "$HOME/.local/bin/mac-askpass" ] && [ "$(launchctl managername 2>/dev/null)" = Aqua ]; then
  # macOS draws its own secure dialog via osascript — see the script. Gated on the launchd
  # manager rather than on uname for the same reason the branch below is gated on a graphical
  # session: `ssh mac cmd` lands in a Background manager where no dialog can appear, and there
  # an unset SUDO_ASKPASS yields sudo's clear error instead of a helper that dies opaquely and
  # reads to sudo as a wrong password. The `-x` test comes first so non-Macs, where the script
  # does not exist, never pay for the launchctl fork.
  #
  # Ordered ahead of the tmux branch deliberately: that branch gates on tmux being *installed*,
  # and Homebrew tmux is installed on this laptop, so it would otherwise claim the Mac and then
  # pop nothing whenever no client is attached.
  export SUDO_ASKPASS="$HOME/.local/bin/mac-askpass"
elif [ -x /usr/bin/ksshaskpass ] && { [ -n "$WAYLAND_DISPLAY" ] || [ -n "$DISPLAY" ]; }; then
  export SUDO_ASKPASS=/usr/bin/ksshaskpass
elif [ -x "$HOME/.local/bin/tmux-askpass" ] && command -v tmux >/dev/null 2>&1; then
  # Headless hosts (daniel-box, daniel-server) have no dialog to pop, but the tmux the
  # work already runs in can draw one — see the script for how. Deliberately NOT gated on
  # $TMUX: the shell running Claude Code's `!` commands descends from the Claude daemon,
  # not from the pane, so $TMUX is absent exactly where sudo runs (on daniel-box the
  # daemon predates the tmux server by two minutes). The script itself checks for the
  # thing that actually matters — an attached client to draw on.
  export SUDO_ASKPASS="$HOME/.local/bin/tmux-askpass"
fi
