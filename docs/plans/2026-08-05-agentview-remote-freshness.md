# Agent View Remote Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent View's remote rows fast and trustworthy, so it stops losing to the built-in `claude agents`.

**Architecture:** Add one shared ssh option builder that turns on connection multiplexing, apply it to both remote call sites, then split the single flat remote cache into one cache per host with a sidecar recording each fetch's outcome. The render gains a per-host status row when a fetch is stale or failed, and the completed/idle groups collapse to expandable fold lines.

**Tech Stack:** Bash 5 (agentview and its six sourced modules), `jq` for cache parsing, `fzf` for the picker, OpenSSH `ControlMaster` for multiplexing, `node:test` for the suite.

## Global Constraints

- **Edit the chezmoi source, never the deployed copy.** All script changes go to `home/dot_local/bin/executable_agentview` and `home/dot_local/share/agentview/*.sh`. A hand-edit to `~/.local/bin/agentview` is reverted by the next `chezmoi apply`.
- **Work in a git worktree** under `.claude/worktrees/`, created via `superpowers:using-git-worktrees`. Several sessions share this repo.
- **Never `git stash`, reset, or rewrite the index** — the index and stash stack are shared across worktrees.
- **Do not run `bin/land`.** Finish with a draft PR and stop.
- **To exercise a branch, use `bin/try <branch>` from the primary checkout**, then `bin/try --back`. Do not `chezmoi apply` from a worktree.
- **New test suites that run the script must `require('../lib/agentview-env')`** and must not set `AGENT_VIEW_WINDIR`, `AGENT_VIEW_WEZTERM_WIN`, or `AGENT_VIEW_WIN_CLAUDE` directly — `tests/agentview/agentview-seams.test.js:52` and `:64` fail otherwise.
- **No new `/mnt/`-defaulted `AGENT_VIEW_*` seam.** `agentview-seams.test.js:36` derives the seam list from the script and fails on an uncovered one. Seams defaulting under `$HOME` are fine.
- **Test framework is `node:test` + `node:assert`**, matching all 13 existing suites.
- **Commit after each task.** Signed commits; never `--no-verify` or `--no-gpg-sign`.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `home/dot_local/share/agentview/common.sh` | Shared helpers | **Add** `AV_SSH_CTLDIR`, `AV_SSH_OPTS`, `av_ssh_opts()`, `remote_cache_for()`, `remote_status_for()` |
| `home/dot_local/bin/executable_agentview` | Entry point, globals, fzf binds | **Modify** `HOST_SSH` / `HOST_LABEL` (`:148-150`), retire scalar `remote_cache` (`:82`), add fold binds |
| `home/dot_local/share/agentview/rows.sh` | Row gathering + remote fetch | **Modify** `refresh_remote()` (`:331-397`) to fan out per host and record outcomes; `:206-211` reader loop |
| `home/dot_local/share/agentview/focus.sh` | Jump / attach | **Modify** `:111` attach to use `AV_SSH_OPTS` |
| `home/dot_local/share/agentview/render.sh` | Grouping and painting | **Modify** `:80` pin-id read; add status rows and fold lines |
| `home/dot_local/share/agentview/actions.sh` | Ctrl+X / Ctrl+P / rename | **Modify** `:87`, `:149-159` to target the right host's cache |
| `tests/agentview/agentview-ssh.test.js` | **New** — multiplexing flags, per-host cache, outcome recording | Create |
| `tests/agentview/agentview-ui.test.js` | Render assertions | **Add** status-row and fold-line cases |
| `tests/agentview/agentview-hotkeys.test.js` | Cursor behaviour | **Add** fold-header landability cases |

**Design note — why the outcome lives in a sidecar.** The cache is JSONL, and three consumers run `jq` straight over it (`rows.sh:211`, `render.sh:80`, `actions.sh:154`). Injecting a non-row metadata line would break all three. The outcome therefore goes in a sibling file, `~/.agentview-remote-status.<host>`, holding one line: `<outcome><TAB><epoch>`.

---

### Task 1: ssh option builder

**Files:**
- Modify: `home/dot_local/share/agentview/common.sh`
- Test: `tests/agentview/agentview-ssh.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `AV_SSH_CTLDIR` (string), `AV_SSH_OPTS` (bash array), `av_ssh_opts()` (populates `AV_SSH_OPTS`, returns 0). Tasks 2 and 4 splat `"${AV_SSH_OPTS[@]}"` into their `ssh` calls.

- [ ] **Step 1: Write the failing test**

Create `tests/agentview/agentview-ssh.test.js`:

```js
// Multiplexing, per-host caches, and fetch-outcome recording.
//
// ssh is invoked by BARE NAME in refresh_remote and focus.sh, so a PATH stub shadows it and
// no test here touches the network. The stub records its argv, which is what every
// assertion below reads.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { agentviewWinSeams } = require('../lib/agentview-env');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'home', 'dot_local', 'bin', 'executable_agentview');
const LIB = path.join(ROOT, 'home', 'dot_local', 'share', 'agentview');

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Builds a HOME, a PATH dir, and an ssh stub that appends its argv to argvLog, one call per
// line. `body` is the stub's exit behaviour: default succeeds and prints nothing.
function env({ sshBody = 'exit 0' } = {}) {
  const home = scratch('av-home-');
  const bin = scratch('av-bin-');
  const argvLog = path.join(home, 'ssh-argv.log');
  fs.mkdirSync(path.join(home, '.claude', 'agent-view'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'),
    `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n${sshBody}\n`,
    { mode: 0o755 });
  const seams = agentviewWinSeams({ bin, scratch });
  return {
    home, bin, argvLog,
    run(args) {
      return execFileSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env, ...seams.env,
          HOME: home, AV_LIB: LIB,
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
    },
    sshCalls() {
      if (!fs.existsSync(argvLog)) return [];
      return fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
    },
  };
}

test('the refresh passes multiplexing options to ssh', () => {
  const e = env();
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  const calls = e.sshCalls();
  assert.ok(calls.length > 0, 'expected at least one ssh call');
  for (const c of calls) {
    assert.match(c, /ControlMaster=auto/, `no ControlMaster in: ${c}`);
    assert.match(c, /ControlPath=/, `no ControlPath in: ${c}`);
    assert.match(c, /ControlPersist=/, `no ControlPersist in: ${c}`);
  }
});

test('the ConnectTimeout bound survives alongside multiplexing', () => {
  // A warm master must never turn a dead host into a hung picker.
  const e = env();
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  for (const c of e.sshCalls()) assert.match(c, /ConnectTimeout=/, `no ConnectTimeout in: ${c}`);
});

test('the control socket path stays under HOME, not /mnt', () => {
  const e = env();
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  const c = e.sshCalls()[0];
  const m = /ControlPath=(\S+)/.exec(c);
  assert.ok(m, `no ControlPath in: ${c}`);
  assert.ok(!m[1].startsWith('/mnt/'), `control socket must not live on /mnt: ${m[1]}`);
});

module.exports = { env };
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: FAIL — the ssh calls carry no `ControlMaster`.

- [ ] **Step 3: Add the builder to `common.sh`**

Append to `home/dot_local/share/agentview/common.sh`:

```bash
# Control sockets for the multiplexed ssh below. Under $HOME deliberately: a /mnt default
# would be a new absolute seam, and tests/agentview/agentview-seams.test.js fails on one that
# the shared helper does not cover.
AV_SSH_CTLDIR="${AGENT_VIEW_SSH_CTLDIR:-$HOME/.ssh/agentview}"
declare -a AV_SSH_OPTS=()

av_ssh_opts() {  # populate AV_SSH_OPTS; callers splat "${AV_SSH_OPTS[@]}" into their ssh call
  # %C is a hash of (host, port, user, address) rather than %r@%h:%p spelled out. Unix socket
  # paths cap at ~104 bytes and the literal form overflows it on long hostnames, at which
  # point ssh silently declines to multiplex and every call pays a full handshake again.
  mkdir -p "$AV_SSH_CTLDIR" 2>/dev/null || true
  chmod 700 "$AV_SSH_CTLDIR" 2>/dev/null || true
  # ConnectTimeout belongs here, not at the call site: a master socket pointing at a host that
  # has gone away must fail fast, or the picker's background refresh hangs holding its pipes.
  AV_SSH_OPTS=(
    -o ControlMaster=auto
    -o "ControlPath=$AV_SSH_CTLDIR/%C"
    -o ControlPersist=300
    -o ConnectTimeout=3
  )
}
```

- [ ] **Step 4: Call it from the refresh so the test has something to observe**

In `home/dot_local/share/agentview/rows.sh`, inside `refresh_remote()`, replace:

```bash
  out=$(ssh -o ConnectTimeout=3 -o BatchMode=yes daniel-server bash -s <<'REMOTE_FOLD' 2>/dev/null
```

with:

```bash
  av_ssh_opts
  out=$(ssh "${AV_SSH_OPTS[@]}" -o BatchMode=yes daniel-server bash -s <<'REMOTE_FOLD' 2>/dev/null
```

`BatchMode` stays at the call site: the interactive attach in Task 2 must not inherit it, or a host needing a passphrase prompt fails instead of asking.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/share/agentview/common.sh home/dot_local/share/agentview/rows.sh tests/agentview/agentview-ssh.test.js
git commit -m "Add ssh connection multiplexing to the Agent View remote refresh

Every remote refresh paid a full ssh handshake -- measured 0.53s against
daniel-server, against 0.08s once a master socket exists. The refresh runs
on picker open, so that cost landed on the interaction the user feels."
```

---

### Task 2: Multiplex the interactive attach

**Files:**
- Modify: `home/dot_local/share/agentview/focus.sh:111`
- Test: `tests/agentview/agentview-ssh.test.js`

**Interfaces:**
- Consumes: `av_ssh_opts()` and `AV_SSH_OPTS` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/agentview/agentview-ssh.test.js`:

```js
test('the interactive attach reuses the same control socket', () => {
  // The jump is the latency the user actually reported. It must share the master the refresh
  // opened, or the first jump after a refresh still pays a handshake.
  const e = env();
  const US = '\x1f';
  const key = ['daniel-server', '/home/daniel/x', 'working', '0', 't', '', 'host', 'tmux:%1'].join(US);
  e.run(['--jump', key]);
  const calls = e.sshCalls();
  assert.ok(calls.length > 0, 'expected an ssh call for a remote jump');
  assert.match(calls[0], /ControlPath=/, `attach did not multiplex: ${calls[0]}`);
});

test('the attach does not inherit BatchMode', () => {
  // BatchMode on an interactive attach turns "ask for the passphrase" into "fail".
  const e = env();
  const US = '\x1f';
  const key = ['daniel-server', '/home/daniel/x', 'working', '0', 't', '', 'host', 'tmux:%1'].join(US);
  e.run(['--jump', key]);
  assert.doesNotMatch(e.sshCalls()[0], /BatchMode/, 'attach must not set BatchMode');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: FAIL on `attach did not multiplex`.

- [ ] **Step 3: Apply the options at the attach site**

In `home/dot_local/share/agentview/focus.sh`, replace line 111:

```bash
  exec ssh -t "$sshalias" "$rcmd"
```

with:

```bash
  av_ssh_opts
  exec ssh "${AV_SSH_OPTS[@]}" -t "$sshalias" "$rcmd"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/share/agentview/focus.sh tests/agentview/agentview-ssh.test.js
git commit -m "Reuse the ssh master socket for Agent View remote jumps

The jump was the reported symptom: selecting a homelab row paid a fresh
handshake before the pane appeared. It now shares the master the refresh
already opened."
```

---

### Task 3: Register daniel-box

**Files:**
- Modify: `home/dot_local/bin/executable_agentview:148-150`
- Test: `tests/agentview/agentview-ssh.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `HOST_SSH[daniel-box]="daniel-box"`, `HOST_LABEL[daniel-box]="Box"`. Task 4 iterates `"${!HOST_SSH[@]}"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agentview/agentview-ssh.test.js`:

```js
test('daniel-box is registered with the display label Box', () => {
  // host_label() falls back to ${1#daniel-}, which would render a lowercase "box" without an
  // explicit entry. The label is the visible half of this task.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /HOST_SSH=\([^)]*\[daniel-box\]/, 'daniel-box missing from HOST_SSH');
  assert.match(src, /HOST_LABEL=\([^)]*\[daniel-box\]="Box"/, 'daniel-box must be labelled Box');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: FAIL — `daniel-box missing from HOST_SSH`.

- [ ] **Step 3: Add the two entries**

In `home/dot_local/bin/executable_agentview`, replace lines 148 and 150:

```bash
declare -A HOST_LABEL=( ["$selfhost"]="WSL" ["$winhost"]="PC" [daniel-server]="Homelab" )
```

```bash
declare -A HOST_SSH=( [daniel-server]="daniel-server" )
```

with:

```bash
declare -A HOST_LABEL=( ["$selfhost"]="WSL" ["$winhost"]="PC" [daniel-server]="Homelab" [daniel-box]="Box" )
```

```bash
declare -A HOST_SSH=( [daniel-server]="daniel-server" [daniel-box]="daniel-box" )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview/agentview-ssh.test.js
git commit -m "Register daniel-box in Agent View as Box

Second server, so it belongs in the one view. The explicit label matters:
host_label()'s ${1#daniel-} fallback would have rendered it lowercase."
```

---

### Task 4: Per-host caches and fetch outcomes

This is the largest task and the one the plan is shaped around. `refresh_remote` currently hardcodes `daniel-server` and writes one flat cache; it becomes a per-host fan-out that records why each fetch ended the way it did.

**Files:**
- Modify: `home/dot_local/share/agentview/common.sh` (add path helpers)
- Modify: `home/dot_local/share/agentview/rows.sh:331-397` (`refresh_remote`), `:206-211` (reader)
- Modify: `home/dot_local/bin/executable_agentview:82` (retire the scalar)
- Modify: `home/dot_local/share/agentview/render.sh:80`, `home/dot_local/share/agentview/actions.sh:87,149-159`
- Test: `tests/agentview/agentview-ssh.test.js`

**Interfaces:**
- Consumes: `AV_SSH_OPTS` (Task 1), `HOST_SSH` (Task 3).
- Produces: `remote_cache_for <host>` → path string; `remote_status_for <host>` → path string; `remote_hosts` → prints one host per line. Status file format is a single line, `<outcome><TAB><epoch>`, where outcome is one of `ok`, `unreachable`, `failed`. Task 5 reads these.

- [ ] **Step 1: Write the failing tests**

Append to `tests/agentview/agentview-ssh.test.js`:

```js
test('each host gets its own cache file', () => {
  const e = env({ sshBody: `printf '%s\\n' '{"session":"s1","state":"working","ts":1,"kind":"host"}'` });
  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);
  for (const h of ['daniel-server', 'daniel-box']) {
    assert.ok(fs.existsSync(path.join(e.home, `.agentview-remote-cache.${h}`)), `no cache for ${h}`);
  }
});

test('a host that cannot be reached is recorded unreachable and keeps its rows', () => {
  // rc 255 is ssh's "could not connect". The previous snapshot is the best data we have.
  const e = env();
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');
  const bin = e.bin;
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\nexit 255\n', { mode: 0o755 });

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  const status = fs.readFileSync(path.join(e.home, '.agentview-remote-status.daniel-server'), 'utf8');
  assert.match(status, /^unreachable\t\d+/, `expected unreachable, got: ${status}`);
  assert.match(fs.readFileSync(cache, 'utf8'), /"session":"old"/, 'rows must survive an unreachable host');
});

test('a host that connects but returns nothing is recorded failed, not empty', () => {
  // The silent bug: rc != 255 with empty output used to overwrite the cache with nothing, so
  // the rows vanished and the UI said the same thing it says when there genuinely are none.
  const e = env();
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');
  fs.writeFileSync(path.join(e.bin, 'ssh'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  const status = fs.readFileSync(path.join(e.home, '.agentview-remote-status.daniel-server'), 'utf8');
  assert.match(status, /^failed\t\d+/, `expected failed, got: ${status}`);
  assert.match(fs.readFileSync(cache, 'utf8'), /"session":"old"/, 'rows must survive a failed fetch');
});

test('a successful fetch records ok and replaces the rows', () => {
  const e = env({ sshBody: `printf '%s\\n' '{"session":"new","state":"working","ts":9,"kind":"host"}'` });
  const cache = path.join(e.home, '.agentview-remote-cache.daniel-server');
  fs.writeFileSync(cache, '{"session":"old","state":"working","ts":1,"kind":"host"}\n');

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  assert.match(fs.readFileSync(path.join(e.home, '.agentview-remote-status.daniel-server'), 'utf8'), /^ok\t\d+/);
  const body = fs.readFileSync(cache, 'utf8');
  assert.match(body, /"session":"new"/);
  assert.doesNotMatch(body, /"session":"old"/, 'a successful fetch replaces the snapshot');
});

test('one host failing does not blank the other', () => {
  // The reason the cache had to split. A shared file meant the last writer won.
  const e = env({ sshBody: `case "$*" in *daniel-box*) exit 255 ;; esac\nprintf '%s\\n' '{"session":"s","state":"working","ts":1,"kind":"host"}'` });
  fs.writeFileSync(path.join(e.home, '.agentview-remote-cache.daniel-box'),
    '{"session":"boxrow","state":"working","ts":1,"kind":"host"}\n');

  e.run(['--refresh-remote', path.join(e.home, 'portfile')]);

  assert.match(fs.readFileSync(path.join(e.home, '.agentview-remote-cache.daniel-box'), 'utf8'), /boxrow/);
  assert.match(fs.readFileSync(path.join(e.home, '.agentview-remote-cache.daniel-server'), 'utf8'), /"session":"s"/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: FAIL — `no cache for daniel-server` (the per-host paths do not exist yet).

- [ ] **Step 3: Add the path helpers to `common.sh`**

```bash
# One cache per host. A single shared file meant the last host to finish a refresh decided
# what every other host's rows looked like -- an unreachable host blanked a healthy one.
# Kept out of $statedir and without a .json suffix so the local session glob never sees them.
remote_cache_for()  { printf '%s/.agentview-remote-cache.%s' "$HOME" "$1"; }

# Sidecar, not a line inside the cache: three consumers run jq straight over the cache as
# JSONL (rows.sh, render.sh, actions.sh) and a metadata row would break all three.
# Format is one line -- "<outcome>\t<epoch>" -- with outcome in ok|unreachable|failed.
remote_status_for() { printf '%s/.agentview-remote-status.%s' "$HOME" "$1"; }

remote_hosts() { printf '%s\n' "${!HOST_SSH[@]}"; }
```

- [ ] **Step 4: Rewrite `refresh_remote` as a per-host fan-out**

In `home/dot_local/share/agentview/rows.sh`, replace the `refresh_remote()` function's signature, ssh call, and trailing write (keep the `REMOTE_FOLD` heredoc body exactly as it is — it is correct and unchanged) so the function reads:

```bash
refresh_one_remote() {  # $1 = host. Pull its state, fold its live registry in, replace its cache.
  local host="$1" out rc cache status tmp
  cache="$(remote_cache_for "$host")"
  status="$(remote_status_for "$host")"
  tmp="$cache.tmp.$$"
  av_ssh_opts
  out=$(ssh "${AV_SSH_OPTS[@]}" -o BatchMode=yes "${HOST_SSH[$host]}" bash -s <<'REMOTE_FOLD' 2>/dev/null
<<< the existing REMOTE_FOLD heredoc body, unchanged >>>
REMOTE_FOLD
)
  rc=$?
  # Three outcomes, because two of them used to look identical to "no sessions":
  #   255      ssh could not connect at all
  #   non-zero the host answered but its side failed
  #   0 + empty output is a LEGITIMATE empty roster and does replace the cache
  if [ "$rc" -eq 255 ]; then
    printf 'unreachable\t%s\n' "$(date +%s)" > "$status" 2>/dev/null
    return
  fi
  if [ "$rc" -ne 0 ]; then
    printf 'failed\t%s\n' "$(date +%s)" > "$status" 2>/dev/null
    return
  fi
  printf '%s' "$out" > "$tmp" 2>/dev/null && mv -f "$tmp" "$cache" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  printf 'ok\t%s\n' "$(date +%s)" > "$status" 2>/dev/null
}

refresh_remote() {  # fan out across every configured host, concurrently
  # Serial would cost the sum of the handshakes on a cold start. This runs off the render
  # path already, but the picker live-reloads when it finishes, so the wait is visible.
  local host pids=()
  while IFS= read -r host; do
    [ -n "$host" ] || continue
    refresh_one_remote "$host" &
    pids+=("$!")
  done < <(remote_hosts)
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
}
```

- [ ] **Step 5: Point the three readers at the per-host caches**

`home/dot_local/bin/executable_agentview:82` — delete the scalar `remote_cache=...` assignment and its comment, since `remote_cache_for` replaces it.

`home/dot_local/share/agentview/rows.sh:206-211` — wrap the existing read in a per-host loop:

```bash
  local host cache
  while IFS= read -r host; do
    cache="$(remote_cache_for "$host")"
    [ -s "$cache" ] || continue
    remote_rows="$remote_rows"$'\n'"$(MSYS_NO_PATHCONV=1 jq -r "$JQ_TS | if \$ts > 0 and \$age > 86400 then empty else $JQ_ROW end" < "$cache" 2>/dev/null)"
  done < <(remote_hosts)
```

`home/dot_local/share/agentview/render.sh:80` — same loop shape around the `$JQ_PINID` read.

`home/dot_local/share/agentview/actions.sh:87,149-159` — `do_remove` resolves the cache from the row's own host field: replace `tmp="$remote_cache.tmp.$$"` with `tmp="$(remote_cache_for "$host").tmp.$$"` and the two `< "$remote_cache"` reads with `< "$(remote_cache_for "$host")"`. The tmp path must derive from the same call, or the `mv -f` lands on a file no reader consults.

- [ ] **Step 6: Run the full agentview suite**

Run: `node --test tests/agentview/`
Expected: PASS — the new ssh suite (11 tests) plus all 13 existing suites. Existing suites exercise the readers you just changed; a failure there means a reader was missed.

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/share/agentview/ home/dot_local/bin/executable_agentview tests/agentview/agentview-ssh.test.js
git commit -m "Give each Agent View host its own cache and record why a fetch ended

A single shared cache meant the last host to finish decided every host's
rows, so one unreachable machine blanked a healthy one. Splitting it also
closes a silent failure: a host that connected but whose remote side failed
returned non-255 with empty output and overwrote the cache with nothing,
which rendered identically to having no sessions."
```

---

### Task 5: Render the fetch outcome

**Files:**
- Modify: `home/dot_local/share/agentview/render.sh`
- Test: `tests/agentview/agentview-ui.test.js`

**Interfaces:**
- Consumes: `remote_status_for` (Task 4), `host_label()` (`executable_agentview:168`).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Append to `tests/agentview/agentview-ui.test.js`. **Use that suite's existing helpers** — `makeEnv()`, `open(env)`, `lineIndex(term, needle)`, `nowSec()`, `scratch()` — and mirror the structure of an adjacent test in the file for driving the picker. That suite opens a real terminal and asserts against `term.text()`; it does not have a function that returns a render string.

The status sidecar is a plain file, so seeding it is the only new fixture step:

```js
const statusfile = (home, host) => path.join(home, `.agentview-remote-status.${host}`);

test('an unreachable host renders a status row instead of going quiet', () => {
  const env = makeEnv();
  fs.writeFileSync(statusfile(env.home, 'daniel-box'), `unreachable\t${nowSec()}\n`);
  const term = open(env);
  assert.ok(lineIndex(term, 'Box · unreachable') >= 0,
    `expected an unreachable row for Box, got:\n${term.text()}`);
});

test('a stale-but-ok host is labelled with its age', () => {
  const env = makeEnv();
  fs.writeFileSync(statusfile(env.home, 'daniel-server'), `ok\t${nowSec() - 360}\n`);
  const term = open(env);
  assert.ok(lineIndex(term, 'Homelab · 6m old') >= 0,
    `expected a 6m age on Homelab, got:\n${term.text()}`);
});

test('a fresh ok host adds no chrome', () => {
  const env = makeEnv();
  fs.writeFileSync(statusfile(env.home, 'daniel-server'), `ok\t${nowSec()}\n`);
  const term = open(env);
  assert.strictEqual(lineIndex(term, 'unreachable'), -1, 'a healthy host should be silent');
  assert.strictEqual(lineIndex(term, 'fetch failed'), -1, 'a healthy host should be silent');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/agentview/agentview-ui.test.js`
Expected: FAIL — no `Box … unreachable` row.

- [ ] **Step 3: Emit the status rows**

Add to `home/dot_local/share/agentview/render.sh`, called from the same place the group loop is assembled:

```bash
# 120s matches REAP_GRACE in rows.sh -- one staleness constant for the whole picker rather
# than two that can disagree.
AV_STALE_AFTER=120

host_status_rows() {  # emit one keyless row per host that is not currently healthy
  local host status line outcome when age lbl now
  now=$(date +%s)
  while IFS= read -r host; do
    status="$(remote_status_for "$host")"
    [ -r "$status" ] || continue
    IFS=$'\t' read -r outcome when < "$status" || continue
    host_label "$host"; lbl="$_hl"
    case "$outcome" in
      unreachable) printf '\t%s  %s · unreachable\n' "" "$lbl" ;;
      failed)      printf '\t%s  %s · fetch failed\n' "" "$lbl" ;;
      ok)
        age=$(( now - ${when:-0} ))
        [ "$age" -gt "$AV_STALE_AFTER" ] && { fmt_age "$when"; printf '\t  %s · %s old\n' "$lbl" "$_age"; }
        ;;
    esac
  done < <(remote_hosts)
}
```

These rows carry an empty key, so `--skip` keeps the cursor off them — they are signage, not targets.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/agentview/agentview-ui.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/share/agentview/render.sh tests/agentview/agentview-ui.test.js
git commit -m "Surface unreachable and stale Agent View hosts in the picker

A failed remote fetch rendered exactly like having no remote sessions, so a
homelab that had been unreachable for hours looked like a quiet one. The
picker now says which it is."
```

---

### Task 6: Collapse completed and idle

**Files:**
- Modify: `home/dot_local/share/agentview/render.sh`, `home/dot_local/bin/executable_agentview` (fzf binds, `--fold` dispatch)
- Test: `tests/agentview/agentview-hotkeys.test.js`, `tests/agentview/agentview-ui.test.js`

**Interfaces:**
- Consumes: the group loop in `render.sh:187` (`for grp in pinned needs-input working review completed idle`).
- Produces: `~/.claude/agent-view-folds` — newline-delimited group names currently expanded; `agentview --fold GROUP` toggles one.

- [ ] **Step 1: Write the failing tests**

Append to `tests/agentview/agentview-hotkeys.test.js`, using that suite's `makeEnv()` and its existing pattern for invoking the script directly (`--skip` is a pure stdout dispatch, so it needs no terminal):

```js
test('a fold header is landable, unlike a plain group header', () => {
  // --skip exists so the cursor never rests on a keyless row. A fold header has to be
  // selectable to be expandable, so it carries a sentinel key rather than an empty one.
  const env = makeEnv();
  const out = runScript(env, ['--skip', 'down', 'fold:completed', '4']);
  assert.strictEqual(out.trim(), '', 'a fold header must stop the cursor, not deflect it');
});

test('a plain header still deflects the cursor', () => {
  const env = makeEnv();
  const out = runScript(env, ['--skip', 'down', '', '4']);
  assert.match(out, /^down\+transform/, 'a keyless header must still be skipped');
});
```

`runScript` stands for whatever this suite already uses to run the script and capture stdout — reuse it rather than adding another. If the suite has no such helper, add one alongside `makeEnv()` following its `execFileSync` conventions.

Append to `tests/agentview/agentview-ui.test.js`, again using `makeEnv()` / `open()` / `lineIndex()` and the suite's `seed()` / `session()` fixtures to create the completed and idle sessions:

```js
test('completed and idle collapse to one line each by default', () => {
  const env = makeEnv();
  seedFinished(env.home, { completed: 3, idle: 2 });
  const term = open(env);
  assert.ok(lineIndex(term, 'COMPLETED (3)') >= 0, `expected a collapsed line, got:\n${term.text()}`);
  assert.ok(lineIndex(term, 'IDLE (2)') >= 0, `expected a collapsed line, got:\n${term.text()}`);
  assert.strictEqual(lineIndex(term, 'completed-session-1'), -1, 'collapsed rows must not render');
});

test('an expanded group renders its rows', () => {
  const env = makeEnv();
  seedFinished(env.home, { completed: 3, idle: 2 });
  fs.writeFileSync(path.join(env.home, '.claude', 'agent-view-folds'), 'completed\n');
  const term = open(env);
  assert.ok(lineIndex(term, 'completed-session-1') >= 0, 'an expanded group renders its rows');
  assert.strictEqual(lineIndex(term, 'idle-session-1'), -1, 'idle stays collapsed');
});
```

`seedFinished` is a new local fixture: write N state files with `state: "completed"` and M with `state: "idle"`, named `completed-session-<i>` / `idle-session-<i>`, using the suite's existing `session()` / `statefile()` helpers.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/agentview/agentview-hotkeys.test.js tests/agentview/agentview-ui.test.js`
Expected: FAIL — the fold header deflects the cursor, and groups render in full.

- [ ] **Step 3: Teach `--skip` about the sentinel**

The existing dispatch at `executable_agentview:67-75` already returns early for any non-empty key, so a `fold:` key stops the cursor with **no change**. Confirm this by reading lines 67-70 — `[ -n "${3:-}" ] && exit 0` is the whole behaviour. Add only the comment recording why:

```bash
if [ "$mode" = "--skip" ]; then
  # A fold header carries a sentinel key (fold:<group>) rather than an empty one precisely so
  # this early return catches it: it has to be landable to be expandable, which is the exact
  # inverse of what a plain header needs.
  [ -n "${3:-}" ] && exit 0                  # a real session row, or a fold header — stay on it
```

- [ ] **Step 4: Render groups collapsed unless expanded**

In `home/dot_local/share/agentview/render.sh`, in the `for grp in ...` loop at `:187`:

```bash
foldfile="$HOME/.claude/agent-view-folds"
group_expanded() {  # $1 = group name
  # completed/idle are the only foldable groups: the rest are what the picker exists to show.
  case "$1" in completed|idle) ;; *) return 0 ;; esac
  [ -r "$foldfile" ] && grep -qxF "$1" "$foldfile" 2>/dev/null
}
```

and inside the loop, before emitting a group's member rows:

```bash
  if ! group_expanded "$grp"; then
    printf 'fold:%s\t  %s (%s)\n' "$grp" "${GN[$grp]}" "$count"
    continue
  fi
```

- [ ] **Step 5: Add the toggle dispatch and bind**

In `home/dot_local/bin/executable_agentview`, beside the other single-purpose dispatches near `:245`:

```bash
if [ "$mode" = "--fold" ]; then do_fold "${2:-}"; exit 0; fi
```

with `do_fold` in `actions.sh`, mirroring `do_pin`'s add/remove-a-line shape:

```bash
do_fold() {  # $1 = "fold:<group>" -> toggle that group's presence in the fold sidecar
  local grp="${1#fold:}" f="$HOME/.claude/agent-view-folds" tmp
  [ -n "$grp" ] || return 0
  tmp="$f.tmp.$$"
  if [ -r "$f" ] && grep -qxF "$grp" "$f" 2>/dev/null; then
    grep -vxF "$grp" "$f" > "$tmp" 2>/dev/null && mv -f "$tmp" "$f" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    printf '%s\n' "$grp" >> "$f" 2>/dev/null
  fi
}
```

`enter` on a fold row must toggle rather than jump. In `jump_or_report` (`focus.sh:343`), before `do_jump`:

```bash
  case "$1" in fold:*) do_fold "$1"; return 0 ;; esac
```

and add the reload to the fzf `--bind` list so the toggle repaints:

```bash
  --bind='enter:transform([[ {1} == fold:* ]] && echo "execute-silent('"'$SELF'"' --fold {1})+reload('"'$SELF'"' --body)" || echo accept)' \
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/agentview/`
Expected: PASS — all suites.

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/share/agentview/ home/dot_local/bin/executable_agentview tests/agentview/
git commit -m "Collapse the Agent View completed and idle groups behind a fold line

Seven state files against three live sessions meant most of the list was
finished work. The groups collapse to a count and expand on enter; the
header carries a sentinel key so the cursor can land on it, which is the
inverse of what --skip does for plain headers."
```

---

### Task 7: Repaint the picker while it is open

Today the list is a snapshot: the reload POST at `executable_agentview:345` fires once per `--refresh-remote`, so a session that changes state while the picker is up shows nothing until `CTRL+F`. The `--listen` port and the `curl` POST already exist — this task only gives them something to fire more than once.

**Files:**
- Modify: `home/dot_local/share/agentview/rows.sh` (add `av_watch_once`, `av_watch_loop`)
- Modify: `home/dot_local/bin/executable_agentview` (add the `--watch` dispatch, start the watcher, extend the EXIT trap)
- Test: `tests/agentview/agentview-ssh.test.js`

**Interfaces:**
- Consumes: `refresh_remote` (Task 4), the existing `post_reload` behaviour at `executable_agentview:341-346`.
- Produces: `av_watch_once PORTFILE` → runs exactly one watch iteration, returns 0; `agentview --watch PORTFILE` → loops until killed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/agentview/agentview-ssh.test.js`:

```js
test('a watch timeout also refreshes the remote hosts', () => {
  // inotifywait exits 2 on timeout, meaning "no local change happened". That is exactly when
  // the remote hosts are worth re-fetching -- an event means local state moved, and the
  // local read is free.
  const e = env();
  fs.writeFileSync(path.join(e.bin, 'inotifywait'), '#!/bin/bash\nexit 2\n', { mode: 0o755 });
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(e.sshCalls().length > 0, 'a timeout iteration must refresh the remote hosts');
});

test('a local file event repaints without touching the network', () => {
  // The whole point of watching: a local state change must not cost an ssh round-trip.
  const e = env();
  fs.writeFileSync(path.join(e.bin, 'inotifywait'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.strictEqual(e.sshCalls().length, 0, 'a local event must not trigger an ssh fetch');
});

test('the watcher falls back to a timer when inotifywait is absent', () => {
  // chezmoi deploys these dotfiles to WSL and both servers; inotify-tools is not everywhere.
  // Without a fallback the picker would silently stop repainting on those machines.
  const e = env();
  fs.rmSync(path.join(e.bin, 'inotifywait'), { force: true });
  const started = Date.now();
  e.run(['--watch-once', path.join(e.home, 'portfile')]);
  assert.ok(Date.now() - started >= 900, 'the fallback must actually wait, not spin');
  assert.ok(e.sshCalls().length > 0, 'the timer path refreshes the remote hosts');
});
```

Add `AGENT_VIEW_WATCH_INTERVAL: '1'` to the `env` helper's spawned environment so the fallback test waits one second rather than thirty.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: FAIL — `--watch-once` is not a mode.

- [ ] **Step 3: Add the watch iteration to `rows.sh`**

```bash
# How long a quiet picker waits before re-fetching the remote hosts. Local changes do not
# wait for this -- they arrive as inotify events.
AV_WATCH_INTERVAL="${AGENT_VIEW_WATCH_INTERVAL:-30}"

av_watch_once() {  # $1 = portfile. One iteration: wait for a local change or time out.
  local rc
  if command -v inotifywait >/dev/null 2>&1; then
    # -qq stays silent; the trailing || captures the exit code without tripping set -e style
    # callers. 2 means "timed out with no event", which is the cue to look at the remote hosts.
    inotifywait -qq -t "$AV_WATCH_INTERVAL" \
      -e close_write -e create -e delete -e moved_to "$statedir" >/dev/null 2>&1
    rc=$?
  else
    # No inotify-tools on this machine. Degrade to a plain timer rather than stopping: a
    # picker that silently never repaints is the bug this task exists to fix.
    sleep "$AV_WATCH_INTERVAL"
    rc=2
  fi
  [ "$rc" -eq 2 ] && refresh_remote
  post_reload "$1"
  return 0
}

av_watch_loop() {  # $1 = portfile. Runs until the picker's EXIT trap kills it.
  while :; do av_watch_once "$1"; done
}
```

`post_reload` is the existing POST at `executable_agentview:341-346`; extract those lines into a function of that name so both the startup refresh and this loop call it rather than duplicating the curl invocation.

- [ ] **Step 4: Add the dispatches and start the watcher**

In `home/dot_local/bin/executable_agentview`, beside the other dispatches:

```bash
if [ "$mode" = "--watch" ]; then av_watch_loop "${2:-}"; exit 0; fi
if [ "$mode" = "--watch-once" ]; then av_watch_once "${2:-}"; exit 0; fi
```

Add `--watch` and `--watch-once` to the `_avmods` case so they load `common rows`, matching `--refresh-remote`.

Start the watcher beside the existing background refresh, and extend the trap so it dies with the picker:

```bash
"$SELF" --watch "$portfile" >/dev/null 2>&1 &
watch_pid=$!
trap 'kill "$poster_pid" "$watch_pid" 2>/dev/null; rm -f "$portfile" 2>/dev/null' EXIT
```

The existing trap kills only `poster_pid`; a surviving watcher would hold the picker's ConPTY open, which is the failure the comment at `:404-407` records for the old CTRL+W hang.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/agentview/agentview-ssh.test.js`
Expected: PASS (14 tests)

- [ ] **Step 6: Add inotify-tools to the tools inventory**

`inotifywait` is not installed on this box. Add `inotify-tools` to `home/.chezmoidata/packages.toml`, following the entries already there (check whether that file or `home/.chezmoidata/tools.toml` is the right home for a distro package before editing — match the existing convention rather than inventing a section). The fallback in Step 3 keeps the picker working wherever the package is missing.

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/share/agentview/rows.sh home/dot_local/bin/executable_agentview tests/agentview/agentview-ssh.test.js
git commit -m "Repaint the Agent View picker while it is open

The list was a snapshot: the reload POST fired once at startup, so a session
that changed state while the picker was up showed nothing until CTRL+F.
Local changes now arrive as inotify events; a quiet picker re-fetches the
remote hosts on a timer. Machines without inotify-tools fall back to the
timer alone rather than silently never repainting."
```

---

### Task 8: Verify on the real machines and open the PR

**Files:** none — this task is verification.

**Interfaces:**
- Consumes: everything above.
- Produces: a draft PR.

- [ ] **Step 1: Run the whole suite**

Run: `node --test tests/`
Expected: PASS. Record the pass/fail count in the PR body.

- [ ] **Step 2: Deploy the branch to the primary checkout**

```bash
bin/try <branch-name>
```

Do not `chezmoi apply` from the worktree — chezmoi reads its source from `~/.local/share/chezmoi`, so an apply from a worktree deploys main instead of the branch.

- [ ] **Step 3: Measure the jump, cold and warm**

```bash
ssh -O exit -o ControlPath="$HOME/.ssh/agentview/%C" daniel-server 2>/dev/null
time agentview --jump "$(agentview --body | grep daniel-server | head -1 | cut -f1)"
time agentview --jump "$(agentview --body | grep daniel-server | head -1 | cut -f1)"
```

Expected: the first call pays roughly 0.5s, the second roughly 0.08s. If the second is not markedly faster, the master socket is not being reused — check `ssh -O check -o ControlPath="$HOME/.ssh/agentview/%C" daniel-server`.

- [ ] **Step 4: Confirm the unreachable path on a real host**

Temporarily block the route (`sudo ip route add blackhole <daniel-box-ip>`), open the picker, confirm it renders `Box · unreachable` rather than dropping the rows, then remove the route (`sudo ip route del blackhole <daniel-box-ip>`).

- [ ] **Step 5: Confirm the picker repaints while open**

Open the picker and leave it alone. From another terminal, change a session's state (start a Claude session, or touch a file in `~/.claude/agent-view/`). The row must move between groups with no keypress. Then wait out `AV_WATCH_INTERVAL` with the picker idle and confirm the remote rows refresh on their own.

- [ ] **Step 6: Return the primary checkout**

```bash
bin/try --back
```

- [ ] **Step 7: Open a draft PR and stop**

```bash
git push -u origin <branch-name>
gh pr create --draft --title "Agent View: remote freshness, multi-host, list density" --body "..."
```

Do not run `bin/land`. Landing is the operator's call.

---

## Self-Review

**Spec coverage.** §3.1 ssh multiplexing → Tasks 1-2. §3.2 multi-host, labels, per-host cache, concurrent fan-out → Tasks 3-4. §3.3 outcome recording → Task 4 (write side), Task 5 (read side). §3.4 fold line and the `--skip` inversion → Task 6. §3.5 repaint while open → Task 7. §5 testing → tests in every task, full-suite gate in Task 8. No spec section is unimplemented.

**Placeholder scan.** The one deliberate elision is `<<< the existing REMOTE_FOLD heredoc body, unchanged >>>` in Task 4 Step 4 — the body is 40 lines of correct remote-side jq that must be preserved verbatim, and reproducing it invites a transcription error. The instruction is to keep it, not to write it.

**Type consistency.** `remote_cache_for` / `remote_status_for` / `remote_hosts` are defined in Task 4 Step 3 and used in Steps 4-5 and Task 5. `av_ssh_opts` / `AV_SSH_OPTS` are defined in Task 1 and used in Tasks 2 and 4. `do_fold` is defined in Task 6 Step 5 and called from both the dispatch and `jump_or_report`. `_hl` (set by `host_label`) and `_age` (set by `fmt_age`) follow the existing out-parameter convention in this codebase.

**Known risk.** Task 6 Step 5's `enter` bind uses an fzf `transform` to branch between toggle and accept. If the installed fzf rejects that form, the fallback is a separate binding (e.g. `space`) for expand, leaving `enter` as accept — a smaller change with the same outcome.
