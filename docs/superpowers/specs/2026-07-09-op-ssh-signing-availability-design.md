# 1Password signing-key availability, everywhere

**Date:** 2026-07-09
**Status:** Design — approved, pending spec review
**Repo:** chezmoi dotfiles (`~/.local/share/chezmoi`)
**Scope:** auth / crypto / commit-signing integrity (no key material handled, no signing policy changed)

## Problem

Commit signing on this host uses the 1Password SSH key. Two surfaces exist:

- **Host git** (`home/dot_gitconfig.tmpl:9`): `gpg.ssh.program = op-ssh-sign` — the macOS-only 1Password signing helper, which talks to the 1Password app directly.
- **claude-sandbox git** (`Dockerfile.base:116-123`): `gpg.format ssh` with **no** `gpg.ssh.program`, so git falls back to `ssh-keygen -Y sign` against the 1Password agent socket forwarded into the container (`executable_claude-sandbox:1511,1528`).

When 1Password is locked (or the calling app has never been authorized against the agent), the key is unreachable and `git commit` fails to sign. VS Code prompts for 1Password access on terminal open; Ghostty and the sandbox do not. There is no `~/.config/1Password/ssh/agent.toml`, so 1Password uses its default: prompt to authorize each app on its first agent connection, and prompt to unlock when locked.

## Goal

The signing key is authorized/unlocked — 1Password's own prompt fires — at each point where a signature will soon be needed:

1. When Ghostty opens (if not already available).
2. Before a signing git operation, if not already available.
3. For claude-sandbox: before the container starts, and surfaced inside it.

So `git commit` never fails to sign for want of an unlock.

## Non-goals

- No changes to key material, `user.signingkey`, `commit.gpgsign`, or `gpg.ssh.program`.
- No `agent.toml`, per-app auto-authorize, or auto-lock changes (see "keep-unlocked" note at end).
- No new signing behavior in the sandbox — only availability + messaging.

## Mechanism

Poke the agent: attempting `ssh-add -L` against the 1Password socket forces a connection, which is what makes 1Password show its authorize/unlock prompt — the same event VS Code triggers. If the target signing key is already listed, the agent is unlocked and authorized and we do nothing. Everything below is built on this single primitive.

## Components

### 1. Core helper — `op-ssh-ensure`

**Source:** `home/dot_local/bin/executable_op-ssh-ensure` → deploys to `~/.local/bin/op-ssh-ensure` (already on PATH, `home/dot_zshrc.tmpl:45`).

Behavior:
- Socket = `$SSH_AUTH_SOCK`, else the default 1Password path
  (`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`); export it.
- If no socket → exit 1 (message unless `--quiet`).
- Target key blob = 2nd field of `git config --get user.signingkey`
  (the `ssh-ed25519 AAAA…` literal, identical on host and in-container),
  hardcoded fallback to the known key.
- If the blob already appears in `ssh-add -L` → exit 0 silently (available).
- Otherwise the list attempt has already poked the agent (prompt fired); print one line
  ("1Password: approve the prompt to unlock your commit-signing key…"), then poll
  `ssh-add -L` every 0.5s up to `--timeout N` seconds. Exit 0 once the key loads, 1 on timeout.
- Flags: `--quiet` / `-q` (suppress output; used at shell startup), `--timeout N` / `-t N` (default 15).

Reference logic:

```bash
#!/usr/bin/env bash
set -uo pipefail
QUIET=false; TIMEOUT=15
while [[ $# -gt 0 ]]; do
  case "$1" in
    -q|--quiet)   QUIET=true; shift ;;
    -t|--timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "usage: op-ssh-ensure [--quiet] [--timeout N]" >&2; exit 2 ;;
  esac
done
say() { [[ "$QUIET" == true ]] || printf '%s\n' "$*" >&2; }

SOCK="${SSH_AUTH_SOCK:-$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock}"
[[ -S "$SOCK" ]] || { say "op-ssh-ensure: no agent socket at $SOCK"; exit 1; }
export SSH_AUTH_SOCK="$SOCK"

KEYBLOB="$(git config --get user.signingkey 2>/dev/null | awk '{print $2}')"
[[ -n "$KEYBLOB" ]] || KEYBLOB="AAAAC3NzaC1lZDI1NTE5AAAAIDA7LulgtoUwepzoMDD4UgAS1OD09qi4WvvJnDOUNkou"
have_key() { ssh-add -L 2>/dev/null | grep -qF "$KEYBLOB"; }

if have_key; then exit 0; fi
say "1Password: approve the prompt to unlock your commit-signing key…"
deadline=$(( SECONDS + TIMEOUT ))
while (( SECONDS < deadline )); do
  if have_key; then exit 0; fi
  sleep 0.5
done
say "op-ssh-ensure: signing key still not available after ${TIMEOUT}s"
exit 1
```

(No `set -e`: the `ssh-add`/`grep` non-zero exits inside `have_key` are expected control flow.)

### 2. Host — Ghostty open

**Source:** `home/dot_zshrc.tmpl`, inside a `{{ if eq .chezmoi.os "darwin" }}` block.

At interactive-shell startup, fire the check in the background so it never delays the prompt:

```zsh
if [[ -o interactive ]] && (( ${+commands[op-ssh-ensure]} )); then
  op-ssh-ensure --quiet &!
fi
```

Locked/unauthorized → 1Password prompts. Already unlocked → silent no-op. `&!` disowns so there is no job-control noise.

### 3. Host — before signing git ops

**Source:** `home/dot_zshrc.tmpl`, same darwin block.

```zsh
git() {
  case "${1:-}" in
    commit|tag|merge|rebase|revert|cherry-pick|am) op-ssh-ensure --timeout 15 ;;
  esac
  command git "$@"
}
```

Only signing-capable subcommands trigger the (idempotent, near-instant when unlocked) check; everything else passes straight through. `op-ssh-ensure` never blocks git — even on timeout it returns and git runs, so a missed prompt degrades to today's behavior (git's own signer prompts/errors).

### 4. Sandbox — host pre-flight

**Source:** `home/private_dot_claude/sandbox/executable_claude-sandbox`, immediately before `docker run`, guarded on the socket existing.

```bash
OP_ENSURE="$HOME/.local/bin/op-ssh-ensure"
if [[ -S "$OP_SOCKET" && -x "$OP_ENSURE" ]]; then
  echo "Ensuring 1Password signing key is available (approve any prompt)…"
  SSH_AUTH_SOCK="$OP_SOCKET" "$OP_ENSURE" --timeout 20 \
    || echo "  Warning: signing key not confirmed — commits inside the sandbox may fail to sign until you unlock 1Password." >&2
fi
```

Blocks up to 20s so the prompt fires and the key loads on the host before the container (which cannot pop a GUI prompt) starts; on timeout, warn and continue. The launcher is a bash script that may run with a leaner `PATH` than the interactive shell, so it references the helper by absolute path rather than relying on `command -v`.

### 5. Sandbox — in-container check

**Source:** `home/private_dot_claude/sandbox/executable_entrypoint.sh`, added to the dynamic-context block appended to `CLAUDE.md` (the `{ … } >> "$CLAUDE_MD"` heredoc).

```bash
if command -v ssh-add >/dev/null && [[ -S "${SSH_AUTH_SOCK:-}" ]]; then
  _key="$(git config --get user.signingkey 2>/dev/null | awk '{print $2}')"
  if [[ -n "$_key" ]] && ssh-add -L 2>/dev/null | grep -qF "$_key"; then
    echo "- **Commit signing**: 1Password key reachable via the forwarded agent — commits will sign."
  else
    echo "- **Commit signing**: signing key NOT reachable. \`commit.gpgsign\` is on, so \`git commit\` will fail until you unlock 1Password on the host (run \`op-ssh-ensure\` there, or approve the prompt)."
  fi
fi
```

Informational and non-blocking; it tells the in-sandbox agent (and you, via the banner) exactly why a commit would fail and how to fix it on the host.

## Security considerations

- The signing key never leaves 1Password; the helper only *lists* agent identities and matches a public-key blob. No private key material is read, stored, or logged.
- No relaxation of any control: `commit.gpgsign`, the signing key, and `op-ssh-sign` are untouched. A timeout degrades to current behavior, never to unsigned commits.
- The sandbox continues to reach the key only through the already-existing forwarded socket (`executable_claude-sandbox:1511`); this change adds a pre-flight and a status line, no new trust path.
- Deliberately *not* touching 1Password auto-lock: lengthening it would widen the window in which the signing key is usable at an unlocked machine (SOC 2-relevant on a work laptop). Biometric unlock is the recommended manual tweak if fewer prompts are wanted.

## Testing

Manual (this is dotfiles/shell/Docker glue; match the repo's existing shell-script test style if any, else manual):

1. **Helper, available:** unlock 1Password, `op-ssh-ensure && echo ok` → exits 0 silently.
2. **Helper, locked:** lock 1Password, `op-ssh-ensure` → prompt fires; approve → exits 0; dismiss → exits 1 after timeout with message.
3. **No socket:** `SSH_AUTH_SOCK=/nonexistent op-ssh-ensure` → exit 1, clear message.
4. **Ghostty open:** lock 1Password, open a new Ghostty window → prompt appears; shell is responsive immediately (backgrounded).
5. **Signing git op:** lock 1Password, `git commit` in a dirty repo → prompt fires before the commit; non-signing (`git status`) → no prompt, no added latency.
6. **Sandbox pre-flight:** lock 1Password, `claude-sandbox <repo>` → prompt fires before container start; timeout path prints the warning and still launches.
7. **In-container status:** with key reachable vs. not, confirm the correct `Commit signing` line in the container's CLAUDE.md banner.

## Rollout

1. Add `executable_op-ssh-ensure`; `chezmoi apply` on host.
2. Edit `dot_zshrc.tmpl` (startup call + `git` function); apply; open a fresh shell.
3. Edit `executable_claude-sandbox` (pre-flight) and `executable_entrypoint.sh` (status line); apply. Entrypoint change takes effect on next container start (bind-mounted, no rebuild). No base-image rebuild required.
4. Commit in `~/.local/share/chezmoi` (signed, per git conventions).
