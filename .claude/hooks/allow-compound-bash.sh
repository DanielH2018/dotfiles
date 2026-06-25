#!/usr/bin/env bash
# allow-compound-bash.sh
#
# PermissionRequest hook for Bash.
# Reads allow/deny/ask patterns directly from ~/.claude/settings.json so there
# is one source of truth. For compound commands (&&, ;), if every sub-command
# matches the allow list and none match the deny or ask lists, grants permission
# automatically — no prompt needed for chaining individually-allowed commands.

SETTINGS="$HOME/.claude/settings.json"
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Only act on compound commands
if [[ "$COMMAND" != *"&&"* && "$COMMAND" != *";"* ]]; then
  exit 0
fi

# Extract Bash(...) entries from a permissions list and normalize to plain
# command prefixes by stripping Bash(...) wrapper and trailing :*, *, etc.
extract_bash_prefixes() {
  local field="$1"
  jq -r --arg f "$field" \
    '.permissions[$f][]? | select(startswith("Bash(")) | ltrimstr("Bash(") | rtrimstr(")") | gsub(":\\*$";"") | gsub(" \\*$";"") | gsub("\\*$";"")' \
    "$SETTINGS" 2>/dev/null
}

ALLOW=()
while IFS= read -r line; do [[ -n "$line" ]] && ALLOW+=("$line"); done < <(extract_bash_prefixes "allow")
DENY=()
while IFS= read -r line; do [[ -n "$line" ]] && DENY+=("$line"); done < <(extract_bash_prefixes "deny")
ASK=()
while IFS= read -r line; do [[ -n "$line" ]] && ASK+=("$line"); done < <(extract_bash_prefixes "ask")

trim() {
  local s="$1"
  s="${s#"${s%%[! $'\t']*}"}"
  s="${s%"${s##*[! $'\t']}"}"
  printf '%s' "$s"
}

matches_any() {
  local cmd="$1"; shift
  local patterns=("$@")
  for p in "${patterns[@]}"; do
    [[ "$cmd" == "$p"* ]] && return 0
  done
  return 1
}

PARTS=()
while IFS= read -r line; do [[ -n "$line" ]] && PARTS+=("$line"); done < <(printf '%s' "$COMMAND" | sed 's/&&/\n/g; s/;/\n/g')

for part in "${PARTS[@]}"; do
  part=$(trim "$part")
  [ -z "$part" ] && continue

  # Deny or ask list → defer to normal permission handling
  if matches_any "$part" "${DENY[@]}" || matches_any "$part" "${ASK[@]}"; then
    exit 0
  fi

  # Not in allow list → defer
  if ! matches_any "$part" "${ALLOW[@]}"; then
    exit 0
  fi
done

printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow","permissionDecisionReason":"All sub-commands match the allow list"}}\n'
