#!/bin/bash
# PreToolUse hook for Bash (SANDBOX ONLY): scope `gh pr` mutations to the
# session's own branch. Mounted only by claude-sandbox, never on the host, so it
# has no effect on host Claude sessions. Relies on $SANDBOX_BRANCH, which the
# launcher exports (-e SANDBOX_BRANCH) for every --worktree/--branch run.
#
# settings.base.json permits gh pr create|edit|comment|ready and this hook scopes
# them. The always-adverse verbs (merge/close/reopen/review/lock/unlock/revert/
# update-branch) stay in the settings deny-list; this hook does not depend on that.
#
# Static string-scan, same limitations as block-dangerous-bash.sh: it cannot catch
# indirection (eval/$VAR/xargs) or write-a-script-then-run. Fail closed — if the
# session branch is unknown, deny all four verbs.

set -u

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Collapse newline/tab/backslash-continuation and strip quotes so compound and
# multi-line forms scan as one line (mirrors the terraform guard).
NORM=$(printf '%s' "$COMMAND" | tr '\n\t\\' '   ' | tr -d "\"'")

# Fast exit unless a scoped-mutating pr verb is present. \b after the verb keeps
# read-only `gh pr comments` from matching the `comment` mutation.
VERBS='(create|edit|comment|ready)'
echo "$NORM" | grep -qE "\bgh[[:space:]]+pr[[:space:]]+$VERBS\b" || exit 0

BRANCH="${SANDBOX_BRANCH:-}"

# Fail closed: no known session branch => no scoped write is safe.
if [ -z "$BRANCH" ]; then
  deny "Blocked: gh pr create/edit/comment/ready is only allowed in a branch-scoped sandbox (SANDBOX_BRANCH is unset). Launch with --worktree/--branch."
fi

# Cross-repo escape: these verbs must act on the workspace repo only. Catch
# --repo/-R in all forms (--repo x, --repo=x, -R x, -R=x, -Rowner/repo).
if echo "$NORM" | grep -qE "[[:space:]](--repo([=[:space:]]|\$)|-R([=[:space:]]|[^[:space:]]))"; then
  deny "Blocked: --repo/-R on a scoped gh pr command. The sandbox may only touch its own repository ($SANDBOX_REPO_NAME)."
fi

# edit/comment/ready take a positional [number|url|branch]; forbid it so they can
# only ever act on the current branch's PR (which is $BRANCH). A following token
# whose first char is not '-' is a positional target.
if echo "$NORM" | grep -qE "\bgh[[:space:]]+pr[[:space:]]+(edit|comment|ready)[[:space:]]+[^-[:space:]]"; then
  deny "Blocked: positional PR target on gh pr edit/comment/ready. Omit it to act on the current branch's PR ($BRANCH); targeting another PR by number/url/branch is not allowed."
fi

# create: a --head/-H pointing anywhere other than the session branch would open a
# PR for someone else's branch. No flag => gh uses the current branch (= $BRANCH).
if echo "$NORM" | grep -qE "\bgh[[:space:]]+pr[[:space:]]+create\b"; then
  HEAD_VAL=$(echo "$NORM" \
    | grep -oE '(--head[=[:space:]]+|-H[=[:space:]]*)[^[:space:]]+' \
    | head -1 \
    | sed -E 's/^--head[=[:space:]]+//; s/^-H[=[:space:]]*//')
  if [ -n "$HEAD_VAL" ] && [ "$HEAD_VAL" != "$BRANCH" ]; then
    deny "Blocked: gh pr create --head '$HEAD_VAL' does not match session branch '$BRANCH'. Create the PR for your own branch (omit --head)."
  fi
fi

exit 0
