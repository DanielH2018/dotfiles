# Agent View Universal Ctrl+n Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Agent View picker's Ctrl+n into a universal launcher that picks host (WSL / PC / homelab) × repo × branch × mode (sandbox vs native) and spawns the right, always-jumpable session by delegating to `ct` / `cts` / `ctw`.

**Architecture:** Rework the spawn path in `executable_agentview` into a host-first wizard (`spawn_pick_host` → `spawn_pick_repo` → `spawn_pick_mode` → `spawn_pick_branch` → launch). Each cell produces two command forms — `inner` (raw command for a fresh `tmux new-window` / wezterm pane) and `named` (the `ct`/`cts` named-session launcher `exec`'d in a bare shell) — so sessions are jumpable in every context without ever firing `switch-client` from inside fzf's live `execute()`.

**Tech Stack:** Bash (the `executable_agentview` script), `ct`/`cts`/`ctw` launchers, Node's built-in `node:test` runner with on-PATH stub binaries (existing `tests/agentview-spawn.test.js` harness).

## Global Constraints

- Single file of production code: `home/dot_local/bin/executable_agentview` (spawn section, ~lines 574–691). No changes to `ct`/`cts`/`ctw` themselves.
- The no-repo sentinel stays `@host` (not `@none`) — the test constant `HOST_ROW = '[no repo · plain claude]'` and its mapping must not churn.
- Homelab ssh alias comes from `HOST_SSH` (value `daniel-server`), passed as `cts --ssh=<alias>`; never rely on `$CTS_REMOTE_HOST`.
- All interpolated repo paths / branches are `%q`-quoted (existing pattern) so tmux's `sh -c` re-parses them intact.
- The host pick is always shown (no auto-select).
- PC branch is unchanged: routes to `spawn_windows_claude`, gated by `is_windows_host "$winhost"` + `[ -x "$WEZTERM_WIN" ]`.
- Sandbox is WSL-only; homelab is native-only (no Docker remotely); local native (`ct`) takes a dir only, so WSL-native skips the branch step.
- Run tests with: `node --test tests/agentview-spawn.test.js` from the repo root (`~/.local/share/chezmoi`).

---

## File Structure

- **Modify:** `home/dot_local/bin/executable_agentview`
  - Add `ct_bin` / `cts_bin` resolution beside the existing `sandbox_bin` block (~line 578).
  - Add `spawn_pick_host` (new), `spawn_pick_mode` (new).
  - Change `spawn_pick_repo` → takes `$1=host`; drop the `winhost_row`.
  - Change `spawn_pick_branch` → takes `$1=host $2=repo`.
  - Replace `spawn_build_cmd` (delete) with inline `(inner, named)` construction in `do_spawn`.
  - Extend `spawn_in_backend` → `spawn_in_backend <inner> <title> <named>`; bare-shell branch `exec`s `named`.
  - Rewrite `do_spawn` as the host-first orchestrator.
- **Modify:** `tests/agentview-spawn.test.js`
  - `makeEnv`: add `ct` + `cts` stubs and `CT_LOG` / `CTS_LOG`; extend the `fzf` stub to answer `host>` (default `WSL`) and `mode>` (default `sandbox`).
  - Update the two bare-shell tests whose intended behavior changes (no-repo → `ct`; repo → `cts`).
  - Add tests: host pick rows/mapping, WSL native mode, homelab spawn (tmux + bare-shell + no-repo), cancel at host/mode.

---

## Task 1: Hybrid placement — `(inner, named)` + bare-shell routes through the named launcher

Introduces the two-command-form placement and the `ct`/`cts` launcher resolution, and switches the bare-shell branch to `exec` the named launcher (the jumpability fix). Host/mode steps come in Tasks 2–3; here `do_spawn` still goes straight to the repo pick for WSL, preserving today's flow while changing only placement.

**Files:**
- Modify: `home/dot_local/bin/executable_agentview` (spawn section)
- Test: `tests/agentview-spawn.test.js`

**Interfaces:**
- Produces:
  - `ct_bin` / `cts_bin` — resolved launcher paths (string vars), mirroring `sandbox_bin`.
  - `spawn_in_backend <inner> <title> <named>` — `inner` runs in a new tmux window / wezterm pane; `named` is `exec`'d (`bash -c`) in a bare shell.
  - `do_spawn` builds `inner` + `named` per cell (WSL sandbox / WSL @host only, for now).

- [ ] **Step 1: Add `ct`/`cts` stubs and logs to the test harness**

In `tests/agentview-spawn.test.js`, inside `makeEnv`, after the `claude-sandbox` stub (line ~66) add two stubs and their log files:

```javascript
  const ctLog = path.join(bin, 'ct.log'); fs.writeFileSync(ctLog, '');
  const ctsLog = path.join(bin, 'cts.log'); fs.writeFileSync(ctsLog, '');
  fs.writeFileSync(path.join(bin, 'ct'), `#!/bin/bash
echo "$*" >> "$CT_LOG"
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'cts'), `#!/bin/bash
echo "$*" >> "$CTS_LOG"
case "$*" in
  *--complete-repos*)    printf 'infra\\nnotes\\n' ;;
  *--complete-branches*) printf 'main\\ndev\\n' ;;
esac
exit 0
`, { mode: 0o755 });
```

Add `CT_LOG: ctLog, CTS_LOG: ctsLog,` to the `env` object (after `CLAUDE_LOG: claudeLog,`) and `ctLog, ctsLog,` to the returned object.

- [ ] **Step 2: Update the two bare-shell tests to the new (named-launcher) behavior**

Replace the test `no tmux/wezterm backend -> runs the launcher in place` (line ~186) with:

```javascript
test('no tmux/wezterm backend -> execs the named cts launcher in place', { skip }, () => {
  const { env, ctsLog, reposRoot } = makeEnv();
  const r = run(env, { FZF_REPO: 'airflow', FZF_BRANCH: 'main' });   // neither TMUX nor WEZTERM_PANE
  assert.strictEqual(r.code, 0, `in-place spawn exits clean; stderr: ${r.err}`);
  assert.ok(fs.readFileSync(ctsLog, 'utf8').includes(`${path.join(reposRoot, 'airflow')} -b main`),
    'the named cts launcher ran in place (jumpable named tmux session)');
});
```

Replace the test `no backend + the no-repo row -> plain claude runs in place` (line ~194) with:

```javascript
test('no backend + the no-repo row -> execs ct ~/dev in place', { skip }, () => {
  const { env, ctLog, tmuxLog, spawnLog } = makeEnv();
  const r = run(env, { FZF_REPO: HOST_ROW });
  assert.strictEqual(r.code, 0, `in-place spawn exits clean; stderr: ${r.err}`);
  assert.ok(fs.readFileSync(ctLog, 'utf8').includes(`${process.env.HOME}/dev`), 'ct ran on ~/dev');
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'no direct tmux from agentview');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm involved');
});
```

- [ ] **Step 3: Run the updated tests to verify they fail**

Run: `node --test tests/agentview-spawn.test.js`
Expected: FAIL — the two updated tests fail (bare-shell still runs `claude-sandbox`/`claude` in place; `CT_LOG`/`CTS_LOG` empty). Other tests still pass.

- [ ] **Step 4: Add `ct`/`cts` resolution in the script**

In `home/dot_local/bin/executable_agentview`, immediately after the `sandbox_bin` resolution block (ends ~line 582), add:

```bash
# Named-session launchers (jumpable): prefer them on PATH, else their deployed path.
ct_bin="${AGENT_VIEW_CT_BIN:-}"
if [ -z "$ct_bin" ]; then
  if command -v ct >/dev/null 2>&1; then ct_bin="ct"; else ct_bin="$HOME/.local/bin/ct"; fi
fi
cts_bin="${AGENT_VIEW_CTS_BIN:-}"
if [ -z "$cts_bin" ]; then
  if command -v cts >/dev/null 2>&1; then cts_bin="cts"; else cts_bin="$HOME/.local/bin/cts"; fi
fi
```

- [ ] **Step 5: Extend `spawn_in_backend` to take a named form**

Replace the `spawn_in_backend` function (lines ~637–650) with:

```bash
spawn_in_backend() {  # $1=inner (new-pane cmd) $2=title $3=named (bare-shell named-session cmd)
  local inner="$1" title="$2" named="${3:-$1}"
  # Inside tmux: a new window IS a jumpable pane — run the raw inner command there. (We do
  # NOT let cts/ct switch-client from under a live fzf execute(); see the design's placement
  # note.)
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    tmux new-window -n "$title" "$inner"; return 0
  fi
  if [ -n "${WEZTERM_PANE:-}" ] && command -v wezterm >/dev/null 2>&1; then
    wezterm cli spawn -- bash -lc "$inner" >/dev/null 2>&1; return 0
  fi
  # Bare shell (no mux): exec the NAMED launcher so the session lands in a named, jumpable
  # tmux session — the case cts/ct exist to fix. Replaces the picker's tty, as before.
  exec bash -c "$named"
}
```

- [ ] **Step 6: Build `(inner, named)` in `do_spawn` and delete `spawn_build_cmd`**

Delete the `spawn_build_cmd` function (lines ~618–621). Replace the WSL repo/@host tail of `do_spawn` (lines ~669–688, the part after the `@windows` branch) so it constructs both forms. The full `do_spawn` is rewritten in Task 2; for this task, apply this interim body (host pick added in Task 2):

```bash
do_spawn() {  # interactive: pick repo + branch, spawn in the active backend.
  local repo branch pf="${1:-}" rc inner named title
  repo=$(spawn_pick_repo) || return 1
  [ -n "$repo" ] || return 0
  if [ "$repo" = "@host" ]; then
    inner='cd ~/dev 2>/dev/null || cd; claude'
    named="$(printf '%q %q' "$ct_bin" "$HOME/dev")"
    spawn_in_backend "$inner" 'claude' "$named"; rc=$?
    [ "$rc" -eq 0 ] && av_close_picker "$pf"
    return "$rc"
  fi
  if [ "$repo" = "@windows" ]; then
    spawn_windows_claude; rc=$?
    [ "$rc" -eq 0 ] && av_close_picker "$pf"
    return "$rc"
  fi
  branch=$(spawn_pick_branch "$repo")
  if [ -n "$branch" ]; then
    inner="$(printf '%q %q -b %q' "$sandbox_bin" "$repo" "$branch")"
    named="$(printf '%q %q -b %q' "$cts_bin" "$repo" "$branch")"
  else
    inner="$(printf '%q %q' "$sandbox_bin" "$repo")"
    named="$(printf '%q %q' "$cts_bin" "$repo")"
  fi
  spawn_in_backend "$inner" "$(basename "$repo")" "$named"; rc=$?
  [ "$rc" -eq 0 ] && av_close_picker "$pf"
  return "$rc"
}
```

(`spawn_pick_repo`/`spawn_pick_branch` keep their current no-arg / one-arg signatures for now; Task 2 and Task 4 add the host parameter.)

- [ ] **Step 7: Run the full spawn suite to verify green**

Run: `node --test tests/agentview-spawn.test.js`
Expected: PASS — all tests, including the two updated bare-shell tests (now asserting `ct`/`cts`). The under-tmux and wezterm tests still pass because `inner` is byte-identical to today's command.

- [ ] **Step 8: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview-spawn.test.js
git commit -m "agentview: route bare-shell spawn through ct/cts named launchers

Bare-shell WSL spawns previously ran claude-sandbox/claude in place, registering
backend:none and non-jumpable. Split placement into inner (new-window pane) vs
named (ct/cts) so the bare-shell case lands in a jumpable named tmux session,
without firing switch-client from inside fzf's live execute()."
```

---

## Task 2: Host-first wizard — `spawn_pick_host`

Inserts the host pick as step 0. WSL preserves the Task 1 flow; PC routes to `spawn_windows_claude`; `remote:<alias>` is wired but its repo/branch sourcing lands in Task 4 (until then a remote pick falls through to the WSL repo source — Task 4 replaces that).

**Files:**
- Modify: `home/dot_local/bin/executable_agentview`
- Test: `tests/agentview-spawn.test.js`

**Interfaces:**
- Produces: `spawn_pick_host` → echoes `wsl` | `pc` | `remote:<alias>`; empty = cancel.
- Consumes: `HOST_SSH` / `HOST_LABEL` (assoc arrays, defined ~line 66), `is_windows_host`, `winhost`, `WEZTERM_WIN`.

- [ ] **Step 1: Extend the fzf stub to answer `host>` and `mode>`**

In `tests/agentview-spawn.test.js`, in the `fzf` stub `case "$prompt"` block (lines ~45–51), add two cases before the `*)` default:

```bash
  host*) cat >/dev/null; printf '%s\\n' "\${FZF_HOST:-WSL}" ;;
  mode*) cat >/dev/null; printf '%s\\n' "\${FZF_MODE:-sandbox}" ;;
```

(Default `FZF_HOST=WSL` and `FZF_MODE=sandbox` keep every existing test on its current path.)

- [ ] **Step 2: Write the failing host-pick tests**

Add to `tests/agentview-spawn.test.js`:

```javascript
// ---- host pick (step 0) ----
test('the host pick offers WSL + homelab, and routes WSL to the repo pick', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_BRANCH: '' });
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window -n airflow/, 'WSL path still spawns the repo');
});

test('cancelling the host pick is a clean no-op', { skip }, () => {
  const { env, tmuxLog, spawnLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: '', FZF_REPO: 'airflow' });
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'nothing spawned when the host pick is empty');
  assert.strictEqual(fs.readFileSync(spawnLog, 'utf8'), '', 'no wezterm spawn either');
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test tests/agentview-spawn.test.js`
Expected: FAIL — `spawn_pick_host` doesn't exist; the host prompt is never issued so `FZF_HOST:''` doesn't cancel and `airflow` still spawns.

- [ ] **Step 4: Add `spawn_pick_host`**

In `home/dot_local/bin/executable_agentview`, add before `spawn_pick_repo` (~line 589):

```bash
spawn_pick_host() {  # echo wsl | pc | remote:<alias> (empty = cancel). Reachable hosts only.
  local rows sel h label
  rows="WSL"
  is_windows_host "$winhost" && [ -x "$WEZTERM_WIN" ] && rows="$rows"$'\n'"PC (Windows)"
  for h in "${!HOST_SSH[@]}"; do rows="$rows"$'\n'"${HOST_LABEL[$h]:-$h}"; done
  sel=$(printf '%s\n' "$rows" | fzf --prompt 'host> ' --height='~70%' --layout=reverse \
    --border=rounded --info=hidden --header 'new session · pick a host · esc cancels')
  [ -n "$sel" ] || return 0
  [ "$sel" = "WSL" ] && { printf 'wsl'; return 0; }
  [ "$sel" = "PC (Windows)" ] && { printf 'pc'; return 0; }
  for h in "${!HOST_SSH[@]}"; do
    if [ "$sel" = "${HOST_LABEL[$h]:-$h}" ]; then printf 'remote:%s' "${HOST_SSH[$h]}"; return 0; fi
  done
  return 0
}
```

- [ ] **Step 5: Wire `spawn_pick_host` into `do_spawn`**

Change the top of `do_spawn` to pick a host first and dispatch PC/remote/WSL. Replace the function opening (through the first `repo=` line) with:

```bash
do_spawn() {  # interactive: pick host -> repo -> (mode) -> branch, spawn in the active backend.
  local host repo branch pf="${1:-}" rc inner named title alias
  host=$(spawn_pick_host) || return 1
  [ -n "$host" ] || return 0                        # cancelled at the host pick
  if [ "$host" = "pc" ]; then
    spawn_windows_claude; rc=$?
    [ "$rc" -eq 0 ] && av_close_picker "$pf"
    return "$rc"
  fi
  repo=$(spawn_pick_repo "$host") || return 1
```

Keep the rest of the Task 1 body (the `@host` / `@windows` / branch tail). The `@windows` branch is now unreachable via the repo pick (PC is handled above) but stays as a harmless guard until Task 4 tidies `spawn_pick_repo`. Pass `"$host"` to `spawn_pick_repo` (its arg is ignored until Task 4).

- [ ] **Step 6: Run the suite to verify green**

Run: `node --test tests/agentview-spawn.test.js`
Expected: PASS — new host-pick tests pass; all prior tests still pass (default `FZF_HOST=WSL`).

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview-spawn.test.js
git commit -m "agentview: add host pick as step 0 of the spawn wizard

Ctrl+n now asks WSL / PC / homelab first. PC routes to the Windows-native
spawn; WSL keeps today's repo flow; remote hosts are wired for Task 4."
```

---

## Task 3: WSL mode pick — sandbox vs native (`ct`)

Adds the sandbox/native choice for a WSL repo. Native launches `ct <repo>` (plain claude, named tmux, no branch step); sandbox is today's `cts`/`claude-sandbox` path.

**Files:**
- Modify: `home/dot_local/bin/executable_agentview`
- Test: `tests/agentview-spawn.test.js`

**Interfaces:**
- Produces: `spawn_pick_mode` → echoes `sandbox` | `native`; empty = cancel.

- [ ] **Step 1: Write the failing native-mode tests**

Add to `tests/agentview-spawn.test.js`:

```javascript
// ---- WSL native mode (ct) ----
test('WSL native mode spawns plain claude in a tmux window, no sandbox, no branch', { skip }, () => {
  const { env, tmuxLog, sandboxBin, reposRoot } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_MODE: 'native' });
  const log = fs.readFileSync(tmuxLog, 'utf8');
  assert.match(log, /new-window -n airflow/, 'opens a titled window');
  assert.ok(log.includes(`cd ${path.join(reposRoot, 'airflow')} 2>/dev/null || cd; claude`),
    `runs plain claude in the repo; got: ${log}`);
  assert.ok(!log.includes(sandboxBin) && !log.includes(' -b '), 'no sandbox, no -b');
});

test('WSL native mode in a bare shell execs ct <repo>', { skip }, () => {
  const { env, ctLog, reposRoot } = makeEnv();
  run(env, { FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_MODE: 'native' });   // no mux
  assert.ok(fs.readFileSync(ctLog, 'utf8').includes(path.join(reposRoot, 'airflow')),
    'ct ran on the repo dir');
});

test('cancelling the mode pick is a clean no-op', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'WSL', FZF_REPO: 'airflow', FZF_MODE: '' });
  assert.strictEqual(fs.readFileSync(tmuxLog, 'utf8'), '', 'nothing spawned when the mode pick is empty');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/agentview-spawn.test.js`
Expected: FAIL — no mode step yet, so `FZF_MODE:'native'`/`''` are ignored and the repo spawns as sandbox.

- [ ] **Step 3: Add `spawn_pick_mode`**

In `home/dot_local/bin/executable_agentview`, add after `spawn_pick_host`:

```bash
spawn_pick_mode() {  # echo sandbox | native (empty = cancel). WSL repo only.
  local sel
  sel=$(printf 'sandbox\nnative\n' | fzf --prompt 'mode> ' --height='~70%' --layout=reverse \
    --border=rounded --info=hidden \
    --header 'sandbox = claude-sandbox (cts) · native = plain claude (ct) · esc cancels')
  case "$sel" in
    sandbox) printf 'sandbox' ;;
    native)  printf 'native' ;;
    *)       return 0 ;;
  esac
}
```

- [ ] **Step 4: Branch on mode in `do_spawn` (WSL repo path)**

In `do_spawn`, replace the WSL repo tail (the `branch=$(spawn_pick_branch …)` block that builds `inner`/`named` for a real repo) with a mode branch:

```bash
  mode=$(spawn_pick_mode) || return 1
  [ -n "$mode" ] || return 0                        # cancelled at the mode pick
  if [ "$mode" = "native" ]; then
    inner="$(printf 'cd %q 2>/dev/null || cd; claude' "$repo")"
    named="$(printf '%q %q' "$ct_bin" "$repo")"
  else
    branch=$(spawn_pick_branch "$host" "$repo")
    if [ -n "$branch" ]; then
      inner="$(printf '%q %q -b %q' "$sandbox_bin" "$repo" "$branch")"
      named="$(printf '%q %q -b %q' "$cts_bin" "$repo" "$branch")"
    else
      inner="$(printf '%q %q' "$sandbox_bin" "$repo")"
      named="$(printf '%q %q' "$cts_bin" "$repo")"
    fi
  fi
  spawn_in_backend "$inner" "$(basename "$repo")" "$named"; rc=$?
  [ "$rc" -eq 0 ] && av_close_picker "$pf"
  return "$rc"
```

Add `mode` to the `local` declaration at the top of `do_spawn`. `spawn_pick_branch "$host" "$repo"` passes the host now (its second arg is used; the first is ignored until Task 4).

- [ ] **Step 5: Run the suite to verify green**

Run: `node --test tests/agentview-spawn.test.js`
Expected: PASS — native-mode tests pass; sandbox tests still pass (default `FZF_MODE=sandbox`).

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview-spawn.test.js
git commit -m "agentview: add sandbox/native mode pick for WSL repos

Native mode launches ct <repo> (plain claude, named tmux, no worktree);
sandbox keeps the claude-sandbox/cts path with an optional -b branch."
```

---

## Task 4: Homelab spawn — remote repo/branch sourcing + `cts --ssh`

Makes the `remote:<alias>` host branch fully functional: repo/branch lists come from `cts --complete-repos` / `--complete-branches`, and the launch is `cts --ssh=<alias> [repo] [-b br]` (same `inner` and `named` — it `exec`s `ssh -t`, correct whether wrapped in `new-window` or `exec`'d). Also finishes `spawn_pick_repo`/`spawn_pick_branch` host-parameterization and drops the now-dead `winhost_row`.

**Files:**
- Modify: `home/dot_local/bin/executable_agentview`
- Test: `tests/agentview-spawn.test.js`

**Interfaces:**
- Consumes: `spawn_pick_host` returns `remote:<alias>`; `cts_bin`.
- Produces: `spawn_pick_repo <host>` (host-aware source, returns repo NAME for remote, `@host`, or path for WSL); `spawn_pick_branch <host> <repo>` (host-aware completion).

- [ ] **Step 1: Write the failing homelab tests**

Add to `tests/agentview-spawn.test.js`:

```javascript
// ---- homelab (remote) spawn ----
test('homelab repo+branch spawns cts --ssh=<alias> <repo> -b <branch> in a tmux window', { skip }, () => {
  const { env, tmuxLog, ctsLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'homelab', FZF_REPO: 'infra', FZF_BRANCH: 'dev' });
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window -n infra .*cts --ssh=daniel-server infra -b dev/,
    `wraps the remote launcher in a window; got: ${fs.readFileSync(tmuxLog, 'utf8')}`);
  const cts = fs.readFileSync(ctsLog, 'utf8');
  assert.match(cts, /--complete-repos daniel-server/, 'repo list came from cts over ssh');
  assert.match(cts, /--complete-branches daniel-server infra/, 'branch list came from cts over ssh');
});

test('homelab no-repo spawns plain remote claude (cts --ssh=<alias>)', { skip }, () => {
  const { env, tmuxLog } = makeEnv();
  run(env, { TMUX: '/tmp/tmux-1000/default,1,0', FZF_HOST: 'homelab', FZF_REPO: HOST_ROW });
  assert.match(fs.readFileSync(tmuxLog, 'utf8'), /new-window -n homelab .*cts --ssh=daniel-server/,
    'no-repo remote session runs bare cts --ssh');
});

test('homelab spawn in a bare shell execs cts --ssh=<alias> <repo>', { skip }, () => {
  const { env, ctsLog } = makeEnv();
  run(env, { FZF_HOST: 'homelab', FZF_REPO: 'infra', FZF_BRANCH: '' });   // no mux
  assert.match(fs.readFileSync(ctsLog, 'utf8'), /--ssh=daniel-server infra/, 'remote launcher exec\'d in place');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/agentview-spawn.test.js`
Expected: FAIL — the remote branch currently falls through to the WSL repo source (no `cts --complete-repos`, wrong launch command).

- [ ] **Step 3: Host-parameterize `spawn_pick_repo`**

Replace `spawn_pick_repo` (and delete the `winhost_row` assignment, ~line 587) with:

```bash
spawn_pick_repo() {  # $1 = host (wsl | remote:<alias>) -> repo path/NAME, @host, or empty
  local host="$1" names sel d
  if [ "$host" = "wsl" ]; then
    names=$(for d in "$repos_root"/*/; do
      [ -d "$d/.git" ] || continue                  # real checkout; a .git FILE = linked worktree
      printf '%s\n' "$(basename "${d%/}")"
    done | sort)
  else                                              # remote:<alias> -> ctw over ssh (cached)
    names=$("$cts_bin" --complete-repos "${host#remote:}" 2>/dev/null | sort -u)
  fi
  sel=$({ printf '%s\n' "$host_row"; [ -n "$names" ] && printf '%s\n' "$names"; } \
    | fzf --prompt 'repo> ' --height='~70%' --layout=reverse --border=rounded --info=hidden \
      --header 'new session · no repo = plain claude · esc cancels')
  [ -n "$sel" ] || return 0
  if   [ "$sel" = "$host_row" ]; then printf '@host'
  elif [ "$host" = "wsl" ];      then printf '%s' "$repos_root/$sel"
  else printf '%s' "$sel"; fi                        # remote: pass the NAME (ctw resolves it)
}
```

- [ ] **Step 4: Host-parameterize `spawn_pick_branch`**

Replace `spawn_pick_branch` with:

```bash
spawn_pick_branch() {  # $1=host $2=repo -> branch (empty = main repo, no worktree)
  local host="$1" repo="$2" out src
  if [ "$host" = "wsl" ]; then
    src=$("$sandbox_bin" "$repo" --complete-branches 2>/dev/null)
  else
    src=$("$cts_bin" --complete-branches "${host#remote:}" "$repo" 2>/dev/null)
  fi
  # --print-query so the user can TYPE a new branch (cts/-b creates it) or pick one; the
  # typed query is the last line. Empty selection = the main checkout.
  out=$(printf '%s\n' "$src" | fzf --prompt 'branch> ' --height='~70%' --layout=reverse \
    --border=rounded --info=hidden --print-query \
    --header 'pick or type a branch (-b) · empty = main repo · esc cancels' | tail -1)
  printf '%s' "$out"
}
```

- [ ] **Step 5: Add the remote launch branch to `do_spawn`**

In `do_spawn`, right after the `pc` dispatch and before `repo=$(spawn_pick_repo "$host")`, add the remote handler:

```bash
  if [ "${host#remote:}" != "$host" ]; then          # remote:<alias>
    alias="${host#remote:}"
    repo=$(spawn_pick_repo "$host") || return 1
    [ -n "$repo" ] || return 0
    if [ "$repo" = "@host" ]; then
      inner="$(printf '%q --ssh=%q' "$cts_bin" "$alias")"; title="${HOST_LABEL[$alias]:-$alias}"
    else
      branch=$(spawn_pick_branch "$host" "$repo")
      if [ -n "$branch" ]; then
        inner="$(printf '%q --ssh=%q %q -b %q' "$cts_bin" "$alias" "$repo" "$branch")"
      else
        inner="$(printf '%q --ssh=%q %q' "$cts_bin" "$alias" "$repo")"
      fi
      title="$repo"
    fi
    spawn_in_backend "$inner" "$title" "$inner"; rc=$?   # inner == named for remote
    [ "$rc" -eq 0 ] && av_close_picker "$pf"
    return "$rc"
  fi
```

Note: `HOST_LABEL` is keyed by host name (`daniel-server`), and `HOST_SSH[daniel-server]="daniel-server"`, so `alias` doubles as the label key here — `title` renders `homelab`.

- [ ] **Step 6: Remove the now-dead `@windows` repo branch**

In `do_spawn`, delete the `if [ "$repo" = "@windows" ]; then … fi` block (PC is handled by the host pick now). Leave the `@host` and WSL-repo (mode) branches intact.

- [ ] **Step 7: Run the full suite to verify green**

Run: `node --test tests/agentview-spawn.test.js`
Expected: PASS — homelab tests pass; all WSL / bare-shell / dismiss tests still pass.

- [ ] **Step 8: Regression — run the whole agentview test set**

Run: `node --test tests/agentview-spawn.test.js tests/agentview-windows.test.js tests/agentview-actions.test.js tests/agentview.test.js tests/agentview-bg-sessions.test.js tests/agentview-hotkeys.test.js`
Expected: PASS across all files (Windows spawn still routes through `spawn_windows_claude`; nothing else regressed).

- [ ] **Step 9: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview-spawn.test.js
git commit -m "agentview: spawn homelab sessions via cts --ssh from the picker

Remote host branch sources repos/branches from cts --complete-* over ssh and
launches cts --ssh=<alias> [repo] [-b br] (native tmux on the homelab). Finishes
host-parameterizing the repo/branch pickers and drops the dead winhost row."
```

---

## Self-Review

**Spec coverage:**
- Host pick (WSL/PC/homelab, reachability, always-shown) → Task 2. ✓
- WSL: no-repo `ct ~/dev`, sandbox `cts`, native `ct`, branch on sandbox only → Tasks 1 + 3. ✓
- PC: unchanged `spawn_windows_claude`, gated → Task 2 (dispatch) + existing code. ✓
- homelab: no-repo / repo+branch via `cts --ssh`, remote repo/branch source → Task 4. ✓
- Hybrid placement (inner vs named; new-window vs bare-shell exec) → Task 1. ✓
- Component split (`spawn_pick_host/repo/mode/branch`, `spawn_launch` folded into `do_spawn`) → Tasks 1–4. ✓
- Error handling: cancel at each step (host/repo/mode/branch) → Tasks 2/3 tests + existing repo-cancel test; unreachable homelab falls back via `cts` stub semantics (real `cts` caches) → covered by design, not separately unit-tested (needs live ssh). ✓
- Testing plan items → Tasks 1–4 tests. ✓
- Out of scope (Windows repo/sandbox; no `ct`/`cts`/`ctw` changes) → respected. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the full function/edit; every test step shows real assertions. ✓

**Type/name consistency:** `spawn_pick_host` → `wsl|pc|remote:<alias>` used consistently in `do_spawn`. `spawn_pick_repo <host>` and `spawn_pick_branch <host> <repo>` signatures match their call sites (Tasks 2/3 pass `"$host"` before Task 4 gives them meaning — the extra arg is harmless until then). `spawn_in_backend <inner> <title> <named>` arity matches all call sites. `inner`/`named`/`title`/`mode`/`alias` all declared `local` in `do_spawn`. Env vars `CT_LOG`/`CTS_LOG` and stub logs `ctLog`/`ctsLog` consistent between `makeEnv` and tests. ✓

**Note on task ordering:** Task 1 leaves a transient state where `spawn_pick_repo` is still no-arg while `do_spawn` calls it no-arg; Task 2 calls it with `"$host"` (ignored) and Task 4 makes the arg meaningful. Each task's test run is green at its own commit.
