#!/bin/bash
# play-sound.sh <input|done>
# Audible event cue for Claude Code hooks. On WSL, notify-send has no daemon and
# the terminal bell never reaches a background `claude agents` session, so play a
# Windows system sound through powershell.exe interop instead. On native Linux,
# fall back to paplay/aplay, then the terminal bell.
set -u

case "${1:-done}" in
  input) WAV='Windows Notify System Generic.wav' ;;  # attention chime: needs input
  done)  WAV='chimes.wav' ;;                          # softer chime: turn complete
  *)     WAV='chimes.wav' ;;
esac

if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  # WSL -> play via Windows. appendWindowsPath=false keeps powershell.exe off
  # PATH, so use the absolute path with a bare-name fallback.
  PS='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  [ -x "$PS" ] || PS=powershell.exe
  # Backgrounded so playback outlives the hook; stderr hidden to swallow the
  # benign "UNC path not supported, defaulting to C:\\Windows" cwd warning.
  "$PS" -NoProfile -c "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\$WAV').PlaySync()" >/dev/null 2>&1 &
elif command -v paplay >/dev/null 2>&1; then
  paplay /usr/share/sounds/freedesktop/stereo/complete.oga >/dev/null 2>&1 &
elif command -v aplay >/dev/null 2>&1; then
  aplay -q /usr/share/sounds/alsa/Front_Center.wav >/dev/null 2>&1 &
else
  printf '\a' > /dev/tty 2>/dev/null || true
fi
exit 0
