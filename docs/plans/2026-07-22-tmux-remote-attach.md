# tmux-based Remote Attach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<enter>` on a remote (homelab) session in the `agentview` picker attach to it, by moving Unix remotes onto tmux and spawning a fresh local WezTerm tab that `ssh -t host tmux attach`es at the pane.

**Architecture:** The tmux locator gains a session name at capture. `do_jump` splits local vs remote by host: local rows activate in-process (unchanged); remote tmux rows spawn a local WezTerm tab running `ssh -t <alias> "tmux select-pane … \; attach -t <session>"`. A thin `ct` launcher gives each homelab Claude its own named tmux session, the state hook is wired on Linux so those sessions register, and the WezTerm-mux `ssh_domain` is retired.

**Tech Stack:** bash, chezmoi (source root `home/`), `node:test` hermetic shell tests (stub tools on PATH), jq, tmux, WezTerm `cli`.

**Spec:** `docs/specs/2026-07-22-tmux-remote-attach-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `home/private_dot_claude/hooks/executable_agent-view-register.sh` | `av_capture_locator` emits `tmux:<socket>:<session>:<pane>` |
| `home/dot_local/bin/executable_agentview` | `av_activate_locator` tmux parse (4-field); `do_jump` local/remote split; `remote_attach` spawns ssh-attach |
| `home/dot_local/bin/executable_ct` | **new** — launch `claude` in a fresh named tmux session |
| `home/.chezmoitemplates/settings.base.json` | state-hook gate `windows` → `windows + linux` |
| `home/.chezmoiignore` | deploy `agent-view-state.sh` on Linux; gate `ct` off Windows |
| `home/dot_config/wezterm/wezterm.lua.tmpl` | remove mux `ssh_domains`; rewire CTRL+SHIFT+H to ssh+tmux |
| `tests/agent-view-register.test.js` | tmux locator now carries session |
| `tests/agentview.test.js` | local tmux 4-field; remote-attach spawn; host-split |
| `tests/ct.test.js` | **new** — `ct` naming + `new-session -A` |

Run all tests with: `node --test tests/*.test.js` (from repo root `/c/Users/daniel/dotfiles`).

---

## Task 1: Verify homelab prerequisites (read-only gate)

The spec assumes the homelab is chezmoi-managed, has tmux, and can register sessions. Confirm before building so Task 8 (install tmux) is only done if needed.

- [ ] **Step 1: Probe the homelab (read-only)**

Run:
```bash
ssh -o ConnectTimeout=4 -o BatchMode=yes daniel-server '
  echo "HOSTNAME: $(hostname)"
  echo "TMUX: $(command -v tmux || echo MISSING)"
  echo "CHEZMOI: $(command -v chezmoi || echo MISSING)"
  echo "HOOKS_DIR:"; ls ~/.claude/hooks/ 2>/dev/null | grep -iE "agent-view|register" || echo "  none"
  echo "REGISTRY:"; ls ~/.claude/agent-view/ ~/.claude/wez-state/ 2>/dev/null | head || echo "  none"
  echo "SETTINGS_HOOK:"; grep -oE "agent-view-state\.sh [a-z-]+" ~/.claude/settings.json 2>/dev/null | sort -u || echo "  not wired"
'
```

Record three facts for later steps:
- The homelab **hostname** (used to confirm the host→alias assumption in Task 4; the picker maps any non-local host to the `daniel-server` ssh alias).
- Whether **tmux** is present (drives Task 8).
- Whether the homelab is **chezmoi-managed** (drives whether `chezmoi apply` in Task 9 reaches it, or a manual copy is needed).

- [ ] **Step 2: No code change — note findings inline in the plan or the execution log**

Expected: a reachable homelab with tmux and chezmoi. If tmux is MISSING, Task 8 becomes required. If chezmoi is MISSING, Task 9's homelab deploy is a manual `scp`/`rsync` of the three files instead of `chezmoi apply`.

---

## Task 2: tmux locator carries the session name

**Files:**
- Modify: `home/private_dot_claude/hooks/executable_agent-view-register.sh` (`av_capture_locator`)
- Test: `tests/agent-view-register.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/agent-view-register.test.js` (before the `process.on('exit', …)` line). It creates a `tmux` stub that echoes the TSV `av_capture_locator` now asks for, prepends it to PATH, and sets `TMUX`:

```javascript
test('av_capture_locator: tmux:<socket>:<session>:<pane> from a tmux pane', { skip }, () => {
  const bin = scratch();
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
# stub: respond to \`tmux display -p '#{socket_path}\\t#{session_name}\\t#{pane_id}'\`
printf '%s\\t%s\\t%s' /tmp/tmux-1000/default airflow '%3'
`, { mode: 0o755 });
  const out = execFileSync('bash', ['-c', `source "${HELPER}"; av_capture_locator`], {
    encoding: 'utf8',
    env: { ...process.env, TMUX: 'fake', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.strictEqual(out, 'tmux:/tmp/tmux-1000/default:airflow:%3');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-view-register.test.js`
Expected: FAIL — the current capture emits `tmux:/tmp/tmux-1000/default:%3` (no session), and/or calls `tmux display` twice so the stub's single-print won't match.

- [ ] **Step 3: Implement — one tmux call, three fields**

In `executable_agent-view-register.sh`, replace the tmux branch of `av_capture_locator`:

```bash
av_capture_locator() {  # echo "backend:locator" for the CURRENT pane
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    local sock sess pane
    # One call: socket disambiguates multiple servers; session is the attach target;
    # pane is the focus target. TSV-parsed so the ':'-joined locator stays unambiguous
    # (socket paths and sanitized session names carry no ':').
    IFS=$'\t' read -r sock sess pane \
      < <(tmux display -p '#{socket_path}\t#{session_name}\t#{pane_id}' 2>/dev/null)
    printf 'tmux:%s:%s:%s' "$sock" "$sess" "$pane"
  elif [ -n "${WEZTERM_PANE:-}" ]; then
    printf 'wezterm:%s' "$WEZTERM_PANE"
  else
    printf 'none:'
  fi
}
```

Also update the helper's header comment block (the "Backends" list) so the tmux line reads `tmux:<socket_path>:<session>:<pane_id>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agent-view-register.test.js`
Expected: PASS (all, including the existing none:/wezterm: cases).

- [ ] **Step 5: Commit**

```bash
git add home/private_dot_claude/hooks/executable_agent-view-register.sh tests/agent-view-register.test.js
git commit -m "feat(agentview): tmux locator carries the session name

Fresh-tab remote attach needs the tmux session as its \`attach -t\` target, so
capture socket + session + pane in one \`tmux display\` call."
```

---

## Task 3: Local tmux activation parses the 4-field locator

**Files:**
- Modify: `home/dot_local/bin/executable_agentview` (`av_activate_locator`, tmux branch)
- Test: `tests/agentview.test.js`

- [ ] **Step 1: Update the existing local-tmux test to a 4-field locator**

In `tests/agentview.test.js`, replace the test `selecting a row with a tmux locator dispatches to tmux select-pane` with:

```javascript
test('a LOCAL row with a 4-field tmux locator dispatches select-pane', { skip }, () => {
  const { env, tmuxLog } = makeEnv({ list: '[]' });
  // host == HOST (selfhost) -> local activation path; locator has socket:session:pane.
  const pick = [cardKey([HOST, '/home/ubuntu/proj', 'working', '0', 'proj', '%3', 'sandbox', 'tmux:/tmp/tmux-1000/default:sess:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /select-pane -t %3/, 'tmux backend focuses the captured pane');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agentview.test.js`
Expected: FAIL — the current tmux parse (`sock="${rest%:*}"; tp="${rest##*:}"`) treats `sess:%3` as the pane, so `select-pane -t` gets the wrong target (or the socket becomes `/tmp/tmux-1000/default:sess`).

- [ ] **Step 3: Implement the 3-field parse**

In `executable_agentview`, replace the `tmux)` case of `av_activate_locator`:

```bash
    tmux)
      command -v tmux >/dev/null 2>&1 || return 1
      # rest = <socket>:<session>:<pane_id>; socket + sanitized session carry no ':'.
      local pane_id="${rest##*:}" _r="${rest%:*}"
      sock="${_r%:*}"                         # drops the trailing :<session>
      tp="$pane_id"
      [ -z "$tp" ] && return 1
      # Focus within the tmux server: window then pane, and switch a detached client.
      # tmux can't raise the OS window hosting the client (documented limitation).
      tmux -S "$sock" select-window -t "$tp" 2>/dev/null
      tmux -S "$sock" select-pane -t "$tp" 2>/dev/null
      tmux -S "$sock" switch-client -t "$tp" 2>/dev/null
      return 0 ;;
```

(The `local sock tp` declaration at the top of `av_activate_locator` stays; `pane_id`/`_r` are new locals — add them to the `local` line: `local loc="$1" backend rest sock tp pane_id _r`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agentview.test.js`
Expected: PASS (this test + the existing wezterm-locator-direct and legacy-cwd tests).

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview.test.js
git commit -m "feat(agentview): parse the session field in local tmux activation"
```

---

## Task 4: Remote-attach split in do_jump

**Files:**
- Modify: `home/dot_local/bin/executable_agentview` (`do_jump`, add `remote_attach` + `remote_alias`)
- Modify: `tests/agentview.test.js` (extend the wezterm stub to log `spawn`)
- Test: `tests/agentview.test.js`

- [ ] **Step 1: Extend the test harness to capture `wezterm cli spawn`**

In `tests/agentview.test.js` `makeEnv`, add a spawn log next to `activateLog`:

```javascript
  const spawnLog = path.join(bin, 'spawn.log'); fs.writeFileSync(spawnLog, '');
```

Extend the `wezterm` stub's `case` with a spawn arm (add before `esac`):

```bash
  *spawn*) echo "$*" >> "$WEZ_SPAWN_LOG" ;;
```

Add `WEZ_SPAWN_LOG: spawnLog` to the returned `env` object, and add `spawnLog` to the `return { … }` at the end of `makeEnv`.

- [ ] **Step 2: Write the failing tests**

Add to `tests/agentview.test.js`:

```javascript
test('selecting a REMOTE tmux row spawns a local ssh-attach tab', { skip }, () => {
  const { env, spawnLog, activateLog } = makeEnv({ list: '[]' });
  // host != selfhost (daniel-server) -> remote attach, NOT local activation.
  const pick = [cardKey(['daniel-server', '/home/ubuntu/airflow', 'working', '0', 'airflow', '%3', 'host', 'tmux:/tmp/tmux-1000/default:airflow:%3']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  const spawned = fs.readFileSync(spawnLog, 'utf8');
  assert.match(spawned, /spawn -- ssh -t daniel-server/, 'spawns a local tab ssh-ing to the remote');
  assert.match(spawned, /attach -t 'airflow'/, 'attaches the target tmux session');
  assert.match(spawned, /select-pane -t '%3'/, 'lands on the captured pane');
  assert.strictEqual(fs.readFileSync(activateLog, 'utf8'), '', 'must NOT activate a remote pane locally');
});

test('a REMOTE row with a non-tmux locator does not activate locally', { skip }, () => {
  const { env, spawnLog, activateLog } = makeEnv({ list: '[]' });
  const pick = [cardKey(['daniel-server', '/x', 'working', '0', 't', '1', 'host', 'none:']), 'display'].join('\t');
  run(env, [], { FZF_PICK: pick });
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no spawn for a non-tmux remote');
  assert.strictEqual(fs.readFileSync(activateLog, 'utf8'), '', 'no local activation of a remote pane');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/agentview.test.js`
Expected: FAIL — `do_jump` currently ignores host and runs `av_activate_locator` on the remote tmux locator (would log a local tmux/activate call, not a spawn).

- [ ] **Step 4: Implement the host split + remote_attach**

In `executable_agentview`, add two functions just above `do_jump`:

```bash
remote_alias() {  # $1 = row host -> ssh alias. Single known remote today; extensible.
  case "$1" in
    daniel-server) printf 'daniel-server' ;;
    *)             printf 'daniel-server' ;;   # only one remote; map new hosts here
  esac
}

remote_attach() {  # $1=host $2=locator -> spawn a local tab ssh-attached at the pane
  local host="$1" loc="$2" backend rest session pane alias
  backend="${loc%%:*}"; rest="${loc#*:}"
  [ "$backend" = "tmux" ] || return 1        # only tmux remotes attach; others list-only
  # rest = <socket>:<session>:<pane>
  pane="${rest##*:}"; rest="${rest%:*}"; session="${rest##*:}"
  [ -n "$session" ] && [ -n "$pane" ] || return 1
  command -v wezterm >/dev/null 2>&1 || return 1
  alias=$(remote_alias "$host")
  # Fresh local tab: select the pane server-side, then attach the client to the session.
  # \; reaches tmux as its command separator (protected from the remote shell). Errors
  # (host down, session gone) surface IN the spawned tab, never a silent no-op.
  wezterm cli spawn -- ssh -t "$alias" \
    "tmux select-pane -t '$pane' \\; attach -t '$session'" >/dev/null 2>&1
  return 0
}
```

Then rewrite `do_jump` to split on host first:

```bash
do_jump() {  # $1 = KEY -> focus the session. Remote rows attach in a fresh local tab;
  # local rows activate in-process (locator-direct, else legacy cwd-correlation).
  local key="$1" host locator t
  host=$(printf '%s' "$key" | cut -d"$US" -f1)
  locator=$(printf '%s' "$key" | cut -d"$US" -f8)
  if [ -n "$host" ] && [ "$host" != "$selfhost" ]; then
    remote_attach "$host" "$locator"; return $?     # remote: never touch a local pane
  fi
  if [ -n "$locator" ] && [ "${locator%%:*}" != "none" ]; then
    av_activate_locator "$locator" && return 0
  fi
  t=$(resolve_key "$key"); [ -z "$t" ] && return 1
  command -v wezterm >/dev/null 2>&1 || return 1
  wezterm cli --prefer-mux activate-pane --pane-id "$t" 2>/dev/null
  nohup bash -c "sleep 0.25; wezterm cli --prefer-mux activate-pane --pane-id '$t'" \
    >/dev/null 2>&1 </dev/null &
  return 0
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/agentview.test.js`
Expected: PASS — including the existing local wezterm-direct, local tmux, and legacy-cwd tests (all have `host == HOST`, so they keep the local path).

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview.test.js
git commit -m "feat(agentview): remote attach via a fresh ssh+tmux tab

do_jump splits on host: a remote tmux row spawns a local WezTerm tab running
\`ssh -t <alias> tmux select-pane \; attach\`, so remote rows are attachable
instead of list-only. Local rows are unchanged."
```

---

## Task 5: `ct` — homelab launcher (one named tmux session per Claude)

**Files:**
- Create: `home/dot_local/bin/executable_ct`
- Test: `tests/ct.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/ct.test.js`:

```javascript
// Unit tests for executable_ct — launches claude in a fresh named tmux session.
// Drives the ACTUAL script with a `tmux` stub on PATH that logs its args instead of
// starting a server. Skips without bash.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CT = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_ct');
let toolsOk = true;
try { execFileSync('bash', ['-c', ':'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash unavailable';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-')); dirs.push(d); return d; }
function runCt(arg, extraEnv = {}) {
  const bin = scratch();
  const log = path.join(bin, 'tmux.log');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/bash
echo "$*" >> "${log.replace(/\\\\/g, '/')}"
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extraEnv };
  execFileSync('bash', [CT, ...(arg ? [arg] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return fs.readFileSync(log, 'utf8');
}

test('ct DIR opens a named tmux session (name = basename) running claude', { skip }, () => {
  const out = runCt('/home/ubuntu/airflow');
  assert.match(out, /new-session -A -s airflow -c \/home\/ubuntu\/airflow claude/);
});

test('ct with no arg uses $PWD basename', { skip }, () => {
  const out = runCt('', { PWD: '/home/ubuntu/myrepo' });
  assert.match(out, /new-session -A -s myrepo/);
});

test('ct sanitizes an unsafe session name', { skip }, () => {
  const out = runCt('/tmp/we ird:name');
  assert.match(out, /-s we-ird-name/, 'spaces/colons collapse to hyphens');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ct.test.js`
Expected: FAIL — `executable_ct` does not exist.

- [ ] **Step 3: Implement `ct`**

Create `home/dot_local/bin/executable_ct`:

```bash
#!/usr/bin/env bash
# ct — launch Claude Code in its OWN named tmux session (one session per Claude), so
# the Agent View picker can attach to it from another machine via `tmux attach -t <name>`.
# Usage: ct [dir]   (dir defaults to $PWD; session name = sanitized basename)
# `new-session -A` attaches to an existing session of that name instead of duplicating,
# matching the "auto-resume per target" model.
set -u
dir="${1:-$PWD}"
case "$dir" in
  -h|--help) echo "usage: ct [dir]  (launch claude in a named tmux session)"; exit 0 ;;
esac
[ -d "$dir" ] || { printf 'ct: not a directory: %s\n' "$dir" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || { printf 'ct: tmux not found on PATH\n' >&2; exit 1; }
name="$(basename "$dir")"
name="$(printf '%s' "$name" | tr -c 'a-zA-Z0-9._-' '-' | sed 's/^-*//;s/-*$//')"
[ -n "$name" ] || name="claude"
exec tmux new-session -A -s "$name" -c "$dir" claude
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ct.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/bin/executable_ct tests/ct.test.js
git commit -m "feat(agentview): add ct — launch claude in a named tmux session

One tmux session per Claude on the homelab, named from the repo dir, so the
picker attaches to a clean per-session target. new-session -A auto-resumes."
```

---

## Task 6: Register homelab sessions (settings gate + chezmoiignore)

**Files:**
- Modify: `home/.chezmoitemplates/settings.base.json` (state-hook gate)
- Modify: `home/.chezmoiignore` (deploy the hook on Linux; gate `ct` off Windows)
- Verify: the settings test suite

- [ ] **Step 1: Confirm the exact gate occurrences**

Run: `grep -n 'eq .chezmoi.os "windows"' home/.chezmoitemplates/settings.base.json`
Expected: the 5 state-hook blocks (the `{{ if eq .chezmoi.os "windows" }},` immediately preceding each `~/.claude/hooks/agent-view-state.sh …` command). Note any *other* `eq .chezmoi.os "windows"` occurrences — do NOT touch those.

- [ ] **Step 2: Widen the 5 state-hook gates to Windows + Linux**

For each of the 5 state-hook blocks, change the guard from:
```
{{ if eq .chezmoi.os "windows" }}
```
to:
```
{{ if or (eq .chezmoi.os "windows") (eq .chezmoi.os "linux") }}
```
Use a targeted replace on the state-hook occurrences only (they are the ones adjacent to `agent-view-state.sh`). Leave any unrelated `windows` conditionals unchanged.

- [ ] **Step 3: Deploy the hook on Linux + gate `ct` off Windows**

In `home/.chezmoiignore`, in the `{{ if ne .chezmoi.os "windows" }}` block, **remove** the line:
```
.claude/hooks/agent-view-state.sh
```
(so the hook now deploys on Linux and macOS; it stays unwired on macOS via the settings gate — harmless).

Then **append** a Windows-only ignore block at the end of the file (after the last existing block):
```
{{ if eq .chezmoi.os "windows" }}
.local/bin/ct
{{ end }}
```

- [ ] **Step 4: Validate the template + run the settings suites**

Run:
```bash
chezmoi execute-template < home/.chezmoitemplates/settings.base.json >/dev/null && echo "template OK"
node --test tests/sandbox-settings-base.test.js tests/claude-settings-merge.test.js tests/modify_settings.test.js
```
Expected: `template OK` and all three suites PASS (the gate widening is additive; no assertion targets the OS gate).

- [ ] **Step 5: Confirm the Linux render wires the hook, Windows still does**

Run:
```bash
chezmoi execute-template --init --promptString 'os=linux' 2>/dev/null <<<'{{ .chezmoi.os }}' >/dev/null 2>&1 || true
grep -c 'agent-view-state.sh' home/.chezmoitemplates/settings.base.json
```
Expected: the hook command string is present (5 references). (A full per-OS render check happens live in Task 9.)

- [ ] **Step 6: Commit**

```bash
git add home/.chezmoitemplates/settings.base.json home/.chezmoiignore
git commit -m "feat(agentview): register host sessions on Linux; gate ct off Windows

Widen the state-hook gate to windows+linux so homelab Claude sessions write to
~/.claude/agent-view/, deploy the hook on Linux, and keep the Unix-only ct off
Windows."
```

---

## Task 7: Retire the WezTerm-mux ssh_domain

**Files:**
- Modify: `home/dot_config/wezterm/wezterm.lua.tmpl`

No unit test (Lua terminal config). Verified by a live WezTerm reload in Task 9.

- [ ] **Step 1: Rewire CTRL+SHIFT+H to ssh + tmux**

In `wezterm.lua.tmpl`, replace the CTRL+SHIFT+H binding:
```lua
	-- Spawn a tab on the homelab (daniel-server) via the persistent mux domain
	{ key = "H", mods = "CTRL|SHIFT", action = act.SpawnTab({ DomainName = "daniel-server" }) },
```
with a local tab that ssh-attaches to the homelab tmux:
```lua
	-- Homelab entry: a local tab that ssh's in and attaches (or creates) a `main`
	-- tmux session. tmux is the multiplexer now (not WezTerm-mux), so this is a plain
	-- local tab running ssh -t — no mux domain round-trip.
	{ key = "H", mods = "CTRL|SHIFT", action = act.SpawnCommandInNewTab({
		domain = { DomainName = "local" },
		args = { "C:\\Program Files\\Git\\bin\\bash.exe", "-l", "-c",
			"ssh -t daniel-server 'tmux new-session -A -s main'" },
	}) },
```

- [ ] **Step 2: Remove the mux domain definitions**

Delete the `server_nodes` table and the `config.ssh_domains` loop (the SERVER NODES + MULTIPLEXING sections). Replace both sections with:
```lua
-- ---------------------------------------------------------------------------
-- REMOTE ACCESS — homelab is reached via ssh + tmux (CTRL+SHIFT+H), NOT a WezTerm
-- mux domain. tmux is the portable multiplexer across machines; retiring the mux
-- domain also removes the CTRL+W GUI-hang class (which was the mux round-trip over
-- WireGuard). The agentview picker (CTRL+SHIFT+S) still aggregates PC + homelab
-- sessions and attaches to remote ones by spawning an ssh+tmux tab.
-- ---------------------------------------------------------------------------
config.ssh_domains = {}
```

Trim the now-moot DEFAULT DOMAIN rationale block down to a one-line note (default stays local; nothing to configure).

- [ ] **Step 3: Syntax-check the Lua (best-effort) + validate the template renders**

Run:
```bash
chezmoi execute-template < home/dot_config/wezterm/wezterm.lua.tmpl > /tmp/wz.lua && echo "template OK"
command -v wezterm >/dev/null 2>&1 && wezterm --config-file /tmp/wz.lua ls-fonts >/dev/null 2>&1 && echo "lua OK" || echo "lua check skipped/failed — verify on reload"
```
Expected: `template OK`; `lua OK` if a `wezterm` binary can parse it (a non-fatal skip is fine — Task 9 reloads live).

- [ ] **Step 4: Commit**

```bash
git add home/dot_config/wezterm/wezterm.lua.tmpl
git commit -m "refactor(wezterm): retire the WezTerm-mux ssh_domain for ssh+tmux

Homelab is now reached via a local ssh -t tmux tab (CTRL+SHIFT+H) instead of a
multiplexing=WezTerm domain — tmux is the portable multiplexer, and dropping the
mux domain also removes the CTRL+W GUI-hang class."
```

---

## Task 8: Ensure tmux on the homelab (conditional on Task 1)

Only if Task 1 reported `TMUX: MISSING`. If tmux is present, **skip this task**.

**Files:**
- Modify: `home/.chezmoidata/tools.toml` (add a tmux entry with an apt field)

- [ ] **Step 1: Add tmux to the shared tool list (apt only)**

In `home/.chezmoidata/tools.toml`, add after the `[[tools]]` block for `starship` (or anywhere in the list):
```toml
[[tools]]
name = "tmux"
cmd = "tmux"
winget = ""
brew = "tmux"
apt = "tmux"
```
(The Linux installer `run_once_after_install-cli-tools.sh.tmpl` consumes the `apt` field; `winget=""` keeps it off Windows. If the Brewfile already installs tmux on macOS, leaving `brew="tmux"` here is redundant but harmless — confirm no double-manage warning.)

- [ ] **Step 2: Verify the installer would pick it up**

Run: `chezmoi execute-template < home/run_once_after_install-cli-tools.sh.tmpl | grep -i tmux`
Expected: the rendered Linux installer references `tmux` in its apt install list.

- [ ] **Step 3: Commit**

```bash
git add home/.chezmoidata/tools.toml
git commit -m "chore(tmux): install tmux on Linux via the shared tool list"
```

---

## Task 9: Full suite, ordered deploy, live verification

- [ ] **Step 1: Full unit suite green**

Run: `node --test tests/*.test.js`
Expected: ALL PASS (existing suites + `agent-view-register`, `agentview`, `ct`).

- [ ] **Step 2: Push, then deploy the homelab FIRST (ordered redeploy)**

The homelab must run the renamed/updated writers before the local picker relies on new locators. Push, then on the homelab:
```bash
git -C /c/Users/daniel/dotfiles push origin HEAD
# If the homelab is chezmoi-managed (Task 1):
ssh daniel-server 'cd ~/.local/share/chezmoi && git pull --rebase && chezmoi apply ~/.claude ~/.local/bin/ct'
# else copy the three files manually:
#   scp the rendered agent-view-register.sh, agent-view-state.sh, ct + settings.json
```
Expected: on the homelab, `~/.claude/hooks/agent-view-register.sh`, `~/.claude/hooks/agent-view-state.sh`, `~/.local/bin/ct` exist, and `~/.claude/settings.json` wires `agent-view-state.sh`.

- [ ] **Step 3: Deploy locally**

Run: `chezmoi apply ~/.local/bin/agentview ~/.claude/hooks ~/.config/wezterm ~/.claude/settings.json`
Then reload WezTerm config (CTRL+SHIFT+R) — confirm no error toast, and that a stale mux domain is gone.

- [ ] **Step 4: Live gate (the acceptance test)**

1. On the homelab: `ct <repo>` → Claude starts in a named tmux session. Send a prompt so a hook fires.
2. Local picker (CTRL+SHIFT+S): the homelab row appears, labeled homelab, correct repo, within one refresh.
3. `<enter>` on it → a new local WezTerm tab opens, ssh-attached to that tmux session, landed on the Claude pane.
4. Start a second `ct <repo2>` on the homelab; attach it → opens its **own** tab without yanking the first.
5. Kill the homelab session (`exit`) → its row disappears; attaching a now-dead row shows the tmux "can't find session" error **in the spawned tab** (not a silent no-op).
6. Local rows + sandbox rows still attach as before; CTRL+W no longer hangs the GUI.

- [ ] **Step 5: Final commit if any verification fixes were needed**

```bash
git add -A && git commit -m "fix(agentview): <describe any live-verification fix>"   # only if needed
git push origin HEAD
```

---

## Notes for the implementer
- Repo root: `/c/Users/daniel/dotfiles` (chezmoi source root is `home/`). Edit **source** files under `home/`, never deployed copies; `chezmoi apply <target>` deploys.
- Commits are signed via the 1Password SSH agent — never pass `--no-verify`.
- Windows shell is Git Bash; the LF-shim `jq` is on PATH. Tests: `node --test tests/<file>.test.js`.
- `US` = `$'\037'` (0x1f) is the KEY field separator. KEY layout: `host|cwd|state|ts|title|pane|kind|locator` (fields 1–8).
