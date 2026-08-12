# 2026-08-12 — Mac debugging: what landed, and what needs the Mac

Session record for four issues reported from the Mac: agentview "file not found" messages,
per-machine SSH host scoping, a missing claude-sandbox option in the Ctrl+N menu, and failures
in `block-dangerous-bash`. Filed at `docs/` root, same reasoning as
`2026-08-06-repo-audit-handoff.md`: not a design, not a plan, and the individual decisions here
are all cheaply reversible.

## Landed

| PR | What |
|---|---|
| [#330](https://github.com/DanielH2018/dotfiles/pull/330) | Port agentview to macOS (bash 4+ guard, hooks wired for darwin, macOS self-badge, portable `stat`); per-machine SSH host scoping via `$AGENT_VIEW_REMOTE_HOSTS` (empty on darwin) |

`origin/main` is at `094dc44`. From the primary checkout, sync with
`git merge --ff-only origin/main` — landing is not deploying; `chezmoi apply` still needs to run
on the Mac to pick this up.

## Root cause found for the "file not found" messages

`home/.chezmoiignore` deliberately excluded agentview from macOS: it needs bash 4 associative
arrays against Darwin's stock bash 3.2, and `settings.base.json` only wired its
`agent-view-state.sh` hooks behind `windows`/`linux`. The Mac install being debugged was almost
certainly an orphaned pre-exclusion copy chezmoi never cleaned up (the ignore file's own comment
warned this would happen), reading a hook registry that was never fed. PR #330 makes the port
real instead of deleting the orphan — confirmed with the user before doing the work, since it's a
real feature addition against a documented "won't work here" decision.

## Ctrl+N → claude-sandbox: no code change needed

Investigated and confirmed with the user: the local-repo picker (`spawn.sh:59-67`) already offers
sandbox vs. native. Remote hosts were deliberately built native-only (`cts --ssh`'s own header:
"no Docker/claude-sandbox" needed remotely) and claude-sandbox itself hard-requires a repo path,
so there's no structural gap to close. If the option isn't showing on the Mac, the cause is
`claude-sandbox` binary resolution there (`spawn.sh:9-14`: PATH, else `~/.claude/sandbox/claude-sandbox`)
— worth re-checking now that agentview itself is deploying correctly.

## Open — needs the Mac to answer

**1. block-dangerous-bash: still unconfirmed.** The hook already has extensive, recently-committed
Darwin handling (`home/private_dot_claude/hooks/executable_block-dangerous-bash.sh`): it probes
whether native bash `[[ =~ ]]` or `grep -E` supports the `\s`/`\b` GNU regex extensions BSD libc
lacks, and answers `ask` (not silent bypass) if neither does. Leading hypothesis, unconfirmed:
BSD grep on the Mac *also* rejects `\b` in `-E` mode, degrading every single Bash command to the
`ask` decision — which would explain "failures" if the report was really about
`tests/hooks/block-dangerous-bash.test.js` (there's no `.js` hook, only `.sh` + that test file).

Run this on the Mac and report the exit code:
```
printf 'ab\n' | grep -qE 'ab\b'; echo $?
```
Non-zero confirms the hypothesis. If confirmed, the fix is a third fallback in the hook's engine
probe (native → grep → a pure-bash word-boundary reimplementation) rather than the current
grep-or-ask two-step — not attempted here since it needs live evidence, per the project's
systematic-debugging rule (no fixes without root-cause confirmation).

**2. Verify the agentview port actually works end to end on the Mac.** Everything above was
built and tested on Linux — the code is shellcheck-clean and BSD-portability-linted, and the
whole suite passes (2124/2155, 31 pre-existing skips), but bash 3.2-vs-4 behavior and Darwin
`stat`/`grep` quirks can't be fully exercised without the real hardware. After `chezmoi apply`:
- Confirm `brew install bash` is on PATH ahead of `/bin/bash` (`bash --version` should read 4+;
  `dot_zprofile.tmpl` already puts Homebrew first via `brew shellenv`).
- Launch `agentview` and confirm the two file-not-found messages are gone and no new ones appear.
- Confirm the picker shows only local sessions (no daniel-server/daniel-box rows) unless you
  explicitly set `AGENT_VIEW_REMOTE_HOSTS`.
- Re-check the Ctrl+N sandbox option per the section above.
