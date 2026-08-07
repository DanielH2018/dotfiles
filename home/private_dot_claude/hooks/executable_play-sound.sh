#!/bin/bash
# play-sound.sh <input|done>
# Audible event cue for Claude Code hooks. notify-send has no daemon under WSL, a
# notify-send banner on desktop Linux is silent unless the sender is a registered
# application, and the terminal bell never reaches a background `claude agents`
# session -- so play a sound file out-of-band instead: paplay via WSLg first, then
# paplay/pw-play against the freedesktop sound theme, then aplay, then the bell.
#
# There is deliberately no powershell.exe fallback. A Windows binary launched from a
# session whose owning wsl.exe has already exited -- which reap-backgrounded-origins.timer
# arranges every 30s for every backgrounded session -- takes WSL's VM-mode interop
# path, and that path leaks a permanently spinning CPU thread per launch
# (microsoft/WSL#41173, unfixed through WSL 2.9.4; measured here at ~12 leaked
# cores in 2.5h). This hook fires on every permission and idle prompt, which made
# it the single largest source of those leaks. paplay reaches the same speakers
# through WSLg and starts no Windows process at all; reading the .wav off /mnt/c is
# a plain filesystem access and costs nothing.
set -u

case "${1:-done}" in
  # WAV is the WSL cue off /mnt/c; THEME is the freedesktop equivalent elsewhere.
  input) WAV='Windows Notify System Generic.wav'; THEME='message' ;;   # attention: needs input
  done)  WAV='chimes.wav';                        THEME='complete' ;;  # softer: turn complete
  *)     WAV='chimes.wav';                        THEME='complete' ;;
esac

WIN_MEDIA="/mnt/c/Windows/Media/$WAV"
THEME_SOUND="/usr/share/sounds/freedesktop/stereo/$THEME.oga"

# Full volume was the complaint that started this file's volume support: 35% is audible over
# normal desktop noise without a startle. CLAUDE_SOUND_VOLUME (0-100) overrides it; anything
# that isn't a plain integer in range falls back to the default rather than passing garbage to
# the player. canberra-gtk-play and aplay have no volume flag, so they stay at their native
# level regardless of this setting.
PCT="${CLAUDE_SOUND_VOLUME:-35}"
if ! [[ "$PCT" =~ ^[0-9]+$ ]] || [[ "$PCT" -gt 100 ]]; then
  PCT=35
fi
PAPLAY_VOLUME=$(( PCT * 65536 / 100 ))          # paplay: linear 0-65536
printf -v PW_VOLUME '%d.%02d0' $(( PCT / 100 )) $(( PCT % 100 ))  # pw-play: float 0.0-1.0

# WSLg publishes its PulseAudio socket at a fixed path. A session the reaper has
# orphaned may never have inherited PULSE_SERVER, so set it explicitly rather than
# trusting the login environment.
[ -S /mnt/wslg/PulseServer ] && export PULSE_SERVER=unix:/mnt/wslg/PulseServer

# Same reasoning on desktop Linux: a hook can run detached from the login shell, so
# point the PulseAudio/PipeWire client at the user runtime socket explicitly.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export XDG_RUNTIME_DIR
fi

if command -v paplay >/dev/null 2>&1 && [ -n "${PULSE_SERVER:-}" ] && [ -r "$WIN_MEDIA" ]; then
  # The Windows .wav played natively: identical sound, no interop.
  paplay --volume="$PAPLAY_VOLUME" "$WIN_MEDIA" >/dev/null 2>&1 &
elif command -v paplay >/dev/null 2>&1 && [ -r "$THEME_SOUND" ]; then
  paplay --volume="$PAPLAY_VOLUME" "$THEME_SOUND" >/dev/null 2>&1 &
elif command -v pw-play >/dev/null 2>&1 && [ -r "$THEME_SOUND" ]; then
  pw-play --volume="$PW_VOLUME" "$THEME_SOUND" >/dev/null 2>&1 &
elif command -v canberra-gtk-play >/dev/null 2>&1; then
  canberra-gtk-play -i "$THEME" >/dev/null 2>&1 &
elif command -v aplay >/dev/null 2>&1; then
  aplay -q /usr/share/sounds/alsa/Front_Center.wav >/dev/null 2>&1 &
else
  printf '\a' > /dev/tty 2>/dev/null || true
fi
exit 0
