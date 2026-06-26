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

- Commits are signed via 1Password SSH agent — never pass `--no-verify` or any flag that bypasses signing.
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

@~/.claude/docs/integrations.md

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

## Compaction policy

When compacting, always preserve:
- The full list of files modified in this session
- All test commands run and their pass/fail results
- Any user corrections or architectural decisions
- Current task state and next steps
- Active branch name and whether changes are pushed

@~/.claude/docs/enforcement.md