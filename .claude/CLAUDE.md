# Claude Code — User-level instructions

## About me

I'm a software engineer on the **Processing team** at Lithic (card-issuing infrastructure / fintech).
I work across backend services, internal tooling, and occasionally frontend.

## Communication style

- Be terse. No preamble, no trailing "here's what I did" summaries — I can read the diff.
- No emojis unless I ask.
- When referencing code, include `file:line` so I can jump to it.
- If something is ambiguous, ask one focused question rather than listing all possibilities.

## Git conventions

- Commits are GPG-signed via 1Password SSH agent — never pass `--no-verify`, `--no-gpg-sign`, or any flag that bypasses signing.
- Default branch is `main`. Prefer rebase over merge.
- Always create a new commit rather than amending unless I explicitly ask to amend.
- Write commit messages that explain *why*, not just what changed. Example:
  ```
  Fix race condition in settlement processor on concurrent retries

  The previous implementation didn't hold the lock across the
  DB read + write, allowing duplicate settlements under load.
  ```

## Environment

- macOS, zsh, vim
- Node managed via fnm (not Homebrew) — don't suggest `brew install node`
- Java managed via sdkman — don't suggest `brew install java`
- SSH keys managed through 1Password

## Integrations — when to reach for them

| MCP | Reach for it when |
|-----|-------------------|
| Lithic API Docs | Asked about endpoints, request shapes, or API behavior |
| Jira | Need ticket context, sprint state, or team docs |
| Confluence | **Suspended/inactive — do not attempt** |
| PagerDuty | On-call schedules, incident history, or service ownership |
| Grafana | Dashboards, metrics (Prometheus/Loki), incidents, on-call |
| Sentry | Debugging — need stack traces or issue history |
| Slack | Read-only context lookups; ask before sending anything |
| Notion | Context on work, projects, or internal documentation |
| Gmail / Calendar / Drive / Ramp | When contextually relevant — don't wait to be asked |

## Model routing

Use the **planner** agent (Opus) for design decisions, architecture analysis, and implementation planning.
Use the **implementer** agent (Sonnet) for writing code, fixing bugs, and executing plans.
For straightforward single-file edits, handle inline without delegating.

## Domain context

This is a financial infrastructure environment. Be conservative with anything touching
auth, secrets, cryptography, or data access. Flag suggestions that could be relevant to
PCI-DSS or SOC 2 compliance rather than assuming they're fine.

## Testing

Write tests for any new code I create. Match the style and framework already used in the project.

## What I don't want

- Don't add docstrings, comments, or type annotations to code you didn't change.
- Don't refactor or "clean up" code beyond what the task requires.
- Don't add error handling for scenarios that can't happen.
- Don't create new files when editing an existing one would do.

## Enforcement

The rules above are advisory. Hard limits are enforced at three layers:

- **Permissions** (`~/.claude/settings.json`): deny/ask/allow rules for file access, bash commands, MCP tools, and WebFetch domains. Deny rules block before the tool runs.
- **Hooks** (`~/.claude/hooks/`): PreToolUse hooks (`block-dangerous-bash.sh`, `protect-secrets.sh`) deny dangerous patterns with clear error messages. PostToolUse hooks auto-format, lint, and audit. The Stop hook prevents leaving staged changes on protected branches.
- **Sandbox** (`sandbox` in settings.json): macOS `sandbox-exec` restricts what Bash commands can actually touch at the OS level. Filesystem deny rules prevent reading `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`. Network is domain-allowlisted. Docker is excluded from sandboxing. 1Password SSH agent socket is explicitly allowed for git signing.

If a CLAUDE.md rule and a permission/hook/sandbox conflict, the enforcement layer wins.