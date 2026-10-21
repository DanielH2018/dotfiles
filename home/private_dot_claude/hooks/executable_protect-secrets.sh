#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Read|Edit|Write|NotebookEdit
#   timeout: 10
#   order: 50
# NotebookEdit is listed because it is a fourth write path to an arbitrary file
# path, not because notebooks are used here. A matcher that names Edit and Write
# but not NotebookEdit reads as covering every edit while leaving one uncovered,
# and nothing reports the gap. Same reasoning on the PostToolUse matchers (auto-format.sh and its siblings).
# PreToolUse hook for Read/Edit/Write: deny access to sensitive files.
# The deny permission rules in settings already cover this, but a hook
# gives a clearer reason and handles patterns that permission globs miss.

set -u

# Same fail-open as block-dangerous-bash had: no jq meant no file_path, so the hook
# exited 0 and the secret-file deny layer disappeared, leaving only the settings.json
# globs. Verified: a Read of ~/.ssh/id_rsa through a jq-free PATH returned rc=0 and no
# decision. Literal JSON so the fallback needs nothing but printf, and `ask` rather than
# `deny` because an unparsed input tells us nothing about which file is being touched —
# denying would block every Read/Edit/Write in the session, not just the guarded ones.
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq ask "protect-secrets: jq is unavailable, so the secret-file rules could not be evaluated. Check the path yourself before allowing." || exit 0

FILE_PATH=$(hook_field '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

deny() {
  hook_deny "$1"
  exit 0
}

is_env_template_name() {
  case "${1##*/}" in
    .env.example|.env.sample|.env.template) return 0 ;;
  esac
  return 1
}

# The committed templates `.env.example`, `.env.sample` and `.env.template` hold placeholder
# keys, not values, so a Read of one is allowed (approved 2026-10-20). Read only: an Edit
# or Write still reaches the deny, as Edit(**/.env.*) does in settings. The resolved path
# must be a template too, so a symlink named `.env.example` that points at a real `.env`
# is still refused. A path that does not resolve has nothing behind it to read.
is_env_template_read() {
  [[ "$(hook_field '.tool_name // empty')" == "Read" ]] || return 1
  is_env_template_name "$FILE_PATH" || return 1
  local real
  real=$(realpath "$FILE_PATH" 2>/dev/null) || return 0
  is_env_template_name "$real"
}

# The .env arm sits last, so a template under ~/.ssh/ or a secrets/ directory is refused
# by that arm before the template exception is ever considered.
case "$FILE_PATH" in
  */.ssh/*|*/id_rsa*|*/id_ed25519*|*/id_ecdsa*)
    deny "Blocked: SSH keys are never safe to read or modify automatically."
    ;;
  # Each arm carries the bare form as well as the */-prefixed one. A relative path has no
  # separator to match — `.aws/credentials` from a cwd of $HOME is the same file as
  # /home/u/.aws/credentials, and only the .env arm handled that shape.
  # The OAuth token store on Linux and WSL. A different file from ~/.claude.json below,
  # which is where the deny list stopped — see .chezmoidata/secrets.toml.
  .credentials.json|*/.claude/.credentials.json)
    deny "Blocked: this is the Claude Code OAuth token store."
    ;;
  .aws/credentials|.aws/config|*/.aws/credentials|*/.aws/config)
    deny "Blocked: AWS credentials file."
    ;;
  .netrc|.pypirc|.npmrc|*/.netrc|*/.pypirc|*/.npmrc)
    deny "Blocked: this file commonly contains auth tokens."
    ;;
  .gnupg/*|*/.gnupg/*)
    deny "Blocked: GPG keyring."
    ;;
  *.pem|*.key|*.p12|*.pfx)
    deny "Blocked: looks like a private key or certificate."
    ;;
  secrets/*|*/secrets/*)
    deny "Blocked: files under a secrets/ directory."
    ;;
  # Everything below was denied for Bash by block-dangerous-bash.sh's SECRET_PATHS but
  # reachable through Read/Edit/Write, which is the gate this hook is. `cat ~/.claude.json`
  # was blocked while Read(~/.claude.json) returned the OAuth token into the transcript.
  # Of the set only ~/.config/gh/** had a settings deny standing behind it. Keep this list
  # and SECRET_PATHS in step — tests/hooks/protect-secrets.test.js fails if they drift.
  .claude.json|*/.claude.json)
    deny "Blocked: ~/.claude.json holds the Claude Code account OAuth token."
    ;;
  .git-credentials|*/.git-credentials)
    deny "Blocked: .git-credentials stores host credentials in plaintext."
    ;;
  */.kube/config|*/.docker/config.json|*/.config/gh/hosts.yml)
    deny "Blocked: this file holds cluster or registry credentials."
    ;;
  /etc/shadow|/etc/gshadow)
    deny "Blocked: system password database."
    ;;
  /proc/*/environ)
    deny "Blocked: /proc/<pid>/environ exposes another process's exported secrets."
    ;;
  .env|*/.env|.env.*|*/.env.*)
    is_env_template_read ||
      deny "Blocked: .env files may contain secrets. Ask the user to share the specific value needed."
    ;;
esac

# The files git reads config and hooks from (dotfiles #711). A write to one makes a later
# plain `git push`, which Bash(git push:*) approves, force, mirror, land on main, or skip the
# pre-push signature gate. Write side only, because reading them is ordinary work. The set
# matches GIT_CONFIG_PATHS in claude_guard/deny.py, which covers the Bash tool.
# `Edit(.git/**)` in settings resolves against the working directory, so it never matches
# the primary checkout's .git/ from a linked worktree, nor ~/.gitconfig.
if [ "$(hook_field '.tool_name // empty')" != "Read" ]; then
  case "$FILE_PATH" in
    *.git/config|*.git/config.worktree|*.git/*/config|*.git/*/config.worktree|\
    *.git/hooks*/*|*.git/*/hooks*/*|\
    .gitconfig|*/.gitconfig|.config/git/*|*/.config/git/*|/etc/gitconfig)
      deny "Blocked: git reads its config or hooks from this file, so a write here can make a later plain \`git push\` force-push or skip the pre-push gate. Ask the user to do this manually; an ordinary git setting goes through \`git config <key> <value>\`."
      ;;
  esac
fi

exit 0
