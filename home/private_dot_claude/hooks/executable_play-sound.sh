#!/bin/bash
# play-sound.sh <input|done>
# Audible event cue for Claude Code hooks. notify-send has no daemon under WSL and
# the terminal bell never reaches a background `claude agents` session, so play a
# sound file out-of-band instead: paplay via WSLg first, then powershell.exe
# interop, then aplay, then the terminal bell.
#
# paplay is preferred over interop because a Windows binary launched from a session
# whose owning wsl.exe has already exited -- which reap-backgrounded-origins.timer
# arranges every 30s for every backgrounded session -- takes WSL's VM-mode interop
# path, and that path leaks a permanently spinning CPU thread per launch
# (microsoft/WSL#41173, unfixed through WSL 2.9.4; measured here at ~12 leaked
# cores in 2.5h). This hook fires on every permission and idle prompt, which made
# it the single largest source of those leaks. paplay reaches the same speakers
# through WSLg and starts no Windows process at all.
set -u

case "${1:-done}" in
  input) WAV='Windows Notify System Generic.wav' ;;  # attention chime: needs input
  done)  WAV='chimes.wav' ;;                          # softer chime: turn complete
  *)     WAV='chimes.wav' ;;
esac

WIN_MEDIA="/mnt/c/Windows/Media/$WAV"

# WSLg publishes its PulseAudio socket at a fixed path. A session the reaper has
# orphaned may never have inherited PULSE_SERVER, so set it explicitly rather than
# trusting the login environment.
[ -S /mnt/wslg/PulseServer ] && export PULSE_SERVER=unix:/mnt/wslg/PulseServer

if command -v paplay >/dev/null 2>&1 && [ -n "${PULSE_SERVER:-}" ] && [ -r "$WIN_MEDIA" ]; then
  # The same .wav the interop path used, played natively: identical sound, no interop.
  paplay "$WIN_MEDIA" >/dev/null 2>&1 &
elif grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  # Interop fallback, reached only when paplay is unavailable -- see the leak note
  # above. appendWindowsPath=false keeps powershell.exe off PATH, so use the
  # absolute path with a bare-name fallback.
  PS='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  [ -x "$PS" ] || PS=powershell.exe
  # Backgrounded so playback outlives the hook; stderr hidden to swallow the
  # benign "UNC path not supported, defaulting to C:\\Windows" cwd warning.
  "$PS" -NoProfile -c "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\$WAV').PlaySync()" >/dev/null 2>&1 &
elif command -v aplay >/dev/null 2>&1; then
  aplay -q /usr/share/sounds/alsa/Front_Center.wav >/dev/null 2>&1 &
else
  printf '\a' > /dev/tty 2>/dev/null || true
fi
exit 0
