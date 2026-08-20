#!/bin/bash
# UserPromptSubmit hook: re-assert the daniel-voice rules once per prompt.
#
# Built-in output styles (Concise, Proactive, Explanatory, Learning) carry a
# `turnReminder` string that Claude Code re-injects as a system-reminder during
# the conversation. Custom styles cannot: the loader for
# ~/.claude/output-styles/*.md parses only name / description /
# keep-coding-instructions, and the reminder renderer looks the active style up
# in the static built-in registry, so a custom name misses and emits nothing.
# Verified against 2.1.235 and 2.1.237 — long-standing, not a regression.
#
# So daniel-voice reaches the model once, at session start, and never again.
# This hook supplies the missing reminder.
#
# Keep the text to ONE line. The built-in turnReminder renders with isMeta set
# and is transient; additionalContext lands in conversation history and
# accumulates once per prompt.
#
# Gating: the hook is registered in settings.json and therefore fires under any
# output style, so it checks that daniel-voice is the active one before
# speaking. Anything ambiguous — no jq, no settings file, a different style —
# exits silently. A wrong reminder is worse than no reminder.
#
# Off switch: CLAUDE_VOICE_REMINDER=0.
#
# Portability: /bin/bash here may be 3.2, so no bash-4 syntax.

set -u

case "${CLAUDE_VOICE_REMINDER:-1}" in 0) exit 0 ;; *) ;; esac

command -v jq >/dev/null 2>&1 || exit 0

STYLE=""
PROJ="${CLAUDE_PROJECT_DIR:-$PWD}"

# Highest precedence first; the first file that defines outputStyle wins.
for f in \
  "$PROJ/.claude/settings.local.json" \
  "$PROJ/.claude/settings.json" \
  "$HOME/.claude/settings.local.json" \
  "$HOME/.claude/settings.json"
do
  [ -r "$f" ] || continue
  STYLE=$(jq -r '.outputStyle // empty' "$f" 2>/dev/null) || STYLE=""
  [ -n "$STYLE" ] && break
done

[ "$STYLE" = "daniel-voice" ] || exit 0

jq -n '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "daniel-voice is active: lead with the outcome, no preamble, one idea per sentence, claim before qualification, no hedging."
  }
}'
