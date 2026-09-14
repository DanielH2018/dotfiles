#!/bin/bash
# Notification hook: alert -- audibly and visually -- when Claude needs attention.
# Works on macOS (osascript), WSL, and desktop Linux (notify-send + play-sound.sh).

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# idle_prompt reaches this hook only for a BACKGROUND JOB, never for a session you are sitting
# in. The distinction matters because the two cases are opposite: a job raising "waiting for
# your input" is the one asking you a question and has no pane of its own to show it, while a
# foreground session raises the same type 60s after every finished turn, and chiming on that
# trains you to ignore the cue that matters. That is why idle_prompt was excluded outright.
#
# Excluding it outright was too blunt: a background job's turn-end raises idle_prompt from the
# JOB's own session, and agent_needs_input from the supervisor only intermittently -- so the
# job case went silent. Measured 2026-08-20: session 664f7ae8 (a job) raised idle_prompt at
# 13:32:42 with no agent_needs_input anywhere near it.
#
# A job owns $HOME/.claude/jobs/<first 8 chars of its session id>; a foreground session owns no
# such directory. That is the whole test.
if [ "$(hook_field '.notification_type // ""')" = "idle_prompt" ]; then
  SID=$(hook_field '.session_id // ""')
  if [ -z "$SID" ] || [ ! -d "$HOME/.claude/jobs/${SID%%-*}" ]; then
    exit 0
  fi
fi

MESSAGE=$(hook_field '.message // "Claude Code"')
TITLE=$(hook_field '.title // "Claude Code"')

if command -v osascript >/dev/null 2>&1; then
  # macOS — play the sound directly so the audible cue never depends on
  # Notification Center delivery (osascript banners are attributed to Script
  # Editor and are silently dropped if it lacks notification permission).
  #
  # Playing it directly is also why it needs a gain knob. afplay is ordinary playback, so
  # it rides the system OUTPUT volume and ignores the Alert volume slider that every other
  # app's notification sound respects. Turning Alert volume down leaves this cue alone at
  # full blast, which is the complaint. macOS offers no per-app notification volume — the
  # per-app control in System Settings is on/off only — so the knob has to live here.
  #
  # 25% by analogy to the Windows branch below, NOT picked by ear: Glass is a short bright
  # sample like the Windows system beep, and the file's own note warns off the 35/50 gains,
  # which are for the soft `complete` sample. Treat the figure as unverified.
  #
  # CLAUDE_SOUND_VOLUME (0-100) overrides it, matching play-sound.sh's contract exactly:
  # anything that isn't a plain integer in range falls back to the default rather than
  # passing garbage to afplay. The default is named once, for the reason play-sound.sh
  # gives — written twice, invalid input would silently play at a different level.
  MACOS_CUE_VOLUME_PCT=25
  PCT="${CLAUDE_SOUND_VOLUME:-$MACOS_CUE_VOLUME_PCT}"
  if ! [[ "$PCT" =~ ^[0-9]+$ ]] || [[ "$PCT" -gt 100 ]]; then
    PCT="$MACOS_CUE_VOLUME_PCT"
  fi
  printf -v CUE_VOLUME '%d.%02d' $(( PCT / 100 )) $(( PCT % 100 ))  # afplay: float 0.0-1.0
  afplay -v "$CUE_VOLUME" /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 &
  # Banner is best-effort; no `sound name` here to avoid a double chime once
  # Script Editor notification permission is granted.
  # argv passing avoids shell injection via message content.
  osascript -e 'on run argv
    display notification (item 2 of argv) with title (item 1 of argv)
  end run' -- "$TITLE" "$MESSAGE"
elif [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* ]]; then
  # Native Windows, and deliberately not the WSL branch below: $OSTYPE is linux-gnu under WSL,
  # so this cannot fire there. The interop leak that bans .exe launches from play-sound.sh
  # (microsoft/WSL#41173) is a property of a bash whose owning wsl.exe has exited; a bash
  # running directly on Windows owns no wsl.exe and takes no interop path.
  #
  # play-sound.sh would reach its terminal-bell fallback here, because none of paplay, pw-play
  # or aplay exists on this bash -- and a bell has no volume. Warp rings it at whatever the
  # system beep is set to, which is the whole complaint. Playing that same .wav through
  # MediaPlayer is the identical sound with a gain knob in front of it. Warp still draws the
  # banner itself (is_needs_attention_enabled), so nothing here shows one.
  #
  # 25% was chosen by ear, A/B'd against the same file at 100% and then at 20%. Do not raise it
  # to the 35 or 50 play-sound.sh uses: those gains are for the soft `complete` sample, and this
  # is the short bright system beep, which carries much further at the same gain.
  WINDOWS_CUE_VOLUME_PCT=25
  printf -v CUE_VOLUME '%d.%02d' \
    $(( WINDOWS_CUE_VOLUME_PCT / 100 )) $(( WINDOWS_CUE_VOLUME_PCT % 100 ))
  if command -v powershell.exe >/dev/null 2>&1; then
    # Reading the sound out of the registry rather than hardcoding it keeps the cue matching
    # whatever the Sounds control panel is set to, and costs nothing: it happens inside the one
    # process that was going to be spawned anyway.
    #
    # Open() is asynchronous, so Volume and Play() before it settles apply to nothing and the
    # cue comes out at full gain -- hence the wait between them.
    # shellcheck disable=SC2016  # PowerShell's own $-variables; bash must not expand them
    powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command '
      Add-Type -AssemblyName presentationCore
      $key = "HKCU:\AppEvents\Schemes\Apps\.Default\.Default\.Current"
      $wav = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue)."(default)"
      if ($wav) { $wav = [Environment]::ExpandEnvironmentVariables($wav) }
      if (-not $wav -or -not (Test-Path -LiteralPath $wav)) {
        $wav = "$env:WINDIR\Media\Windows Background.wav"
      }
      $player = New-Object System.Windows.Media.MediaPlayer
      $player.Open([uri]$wav)
      Start-Sleep -Milliseconds 400
      $player.Volume = '"$CUE_VOLUME"'
      $player.Play()
      Start-Sleep -Milliseconds 1800
      $player.Close()' >/dev/null 2>&1 &
  else
    "$HOME/.claude/hooks/play-sound.sh" input
  fi
elif grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  # WSL — notify-send has no daemon here, so play an audible Windows cue instead.
  "$HOME/.claude/hooks/play-sound.sh" input
else
  # Desktop Linux. notify-send draws a banner but is silent: KDE and GNOME only
  # attach a sound to notifications from a registered application, and notify-send
  # is not one. Play the cue out-of-band so the audible alert never depends on the
  # notification daemon's per-app sound settings.
  "$HOME/.claude/hooks/play-sound.sh" input
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "$TITLE" "$MESSAGE"
  fi
fi

exit 0
