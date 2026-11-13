# ~/.config/shell/askpass.sh — picks SUDO_ASKPASS for a shell with no terminal.
#
# Sourced by env.sh for every login shell, and named as BASH_ENV in Claude Code's settings,
# so every non-interactive bash under Claude Code reads it, the Bash tool's commands included.
# That second route runs it once per bash process, so it must stay cheap and safe under a
# caller's `set -eu`: an inherited helper that exists is kept, which spares a Mac the
# launchctl fork in every nested bash, and every variable read has a default.
# shellcheck shell=sh

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
if [ -n "${SUDO_ASKPASS:-}" ] && [ -x "$SUDO_ASKPASS" ]; then
  :
elif [ -x "$HOME/.local/bin/mac-askpass" ] && [ "$(launchctl managername 2>/dev/null)" = Aqua ]; then
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
elif [ -x /usr/bin/ksshaskpass ] && { [ -n "${WAYLAND_DISPLAY:-}" ] || [ -n "${DISPLAY:-}" ]; }; then
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
