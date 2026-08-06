# Agent View upgrade-restart — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A picker open across a `chezmoi apply` that changes the row schema re-execs itself instead of rendering skewed columns.

**Architecture:** Every repaint becomes an fzf `transform` that asks a subprocess which action to perform. That subprocess compares a fingerprint of the launcher and its modules against the one the picker exported at startup, and prints either `reload(...)` (unchanged) or `become('$SELF' --query …)` (changed). `become` replaces the fzf process, so the new picker parses its own argv — which is the fix, since the stale `--with-nth` lives in argv.

**Tech Stack:** bash 3.2-clean shell, fzf 0.74.2, `node --test` with the repo's pty harness (`tests/lib/pty.js`, real `script(1)` pty + real fzf).

Spec: `docs/specs/2026-08-06-agentview-upgrade-restart-design.md`

## Global Constraints

- **Never inline a conditional producing parens into a `--bind` string.** fzf's `--bind` parser finds a `transform(...)` action's extent by naive paren counting, so literal parens inside the argument truncate it there. The decision must live in a dispatch mode that *prints* the action string. This is documented at `executable_agentview:96-101` and is why `--enter` exists.
- **`_av_fp` and `av_remote_fingerprint` are taken.** They are slice-1b instrumentation for the *remote snapshot* (`common.sh:131`). The new helper is `av_script_fingerprint` → `_av_sfp`, env var `AV_SCRIPT_FP`. Do not reuse or extend the remote one.
- **Use `cksum`, not `stat`.** `common.sh:141` already fingerprints by content, and there is no `stat` in agentview at all — its `-c`/`-f` flags differ between GNU and BSD. Content also gives the semantics we want: `chezmoi apply` rewriting a file with identical bytes must **not** restart the picker.
- Modules are sourced at top level only, never inside a function (`executable_agentview:308-313`) — they carry `declare -A` globals.
- Shell rules: `set -u` is already set; quote every expansion; the shellcheck gate runs in pre-push.
- Test files are discovered by `git ls-files '*.test.js'`, so a new test file must be `git add`ed to run in the gate.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `home/dot_local/share/agentview/common.sh` | shared helpers | **Modify** — add `av_script_fingerprint` |
| `home/dot_local/bin/executable_agentview` | mode dispatch, fzf invocation, binds | **Modify** — `--fingerprint`, `--repaint`, `--query`; export `AV_SCRIPT_FP`; rewrite 9 repaint sites |
| `home/dot_local/share/agentview/rows.sh` | row gathering, `post_reload()` | **Modify** — make the POSTed action conditional |
| `tests/agentview/agentview-repaint.test.js` | the new mode's unit behaviour | **Create** |
| `tests/agentview/agentview-ui.test.js` | pty-driven picker tests | **Modify** — expose `lib` from `makeEnv`, add the upgrade-mid-picker test |

---

### Task 1: `av_script_fingerprint` and the `--fingerprint` mode

**Files:**
- Modify: `home/dot_local/share/agentview/common.sh` (after `av_remote_fingerprint`, ~line 145)
- Modify: `home/dot_local/bin/executable_agentview:292-306` (mode dispatch) and after line 316
- Test: `tests/agentview/agentview-repaint.test.js` (create)

**Interfaces:**
- Consumes: `AV_LIB` (set at `executable_agentview:291`), `AGENTVIEW_SELF`
- Produces: `av_script_fingerprint` → sets `_av_sfp`; `agentview --fingerprint` prints it on one line

- [ ] **Step 1: Write the failing test**

Create `tests/agentview/agentview-repaint.test.js`:

```javascript
// The picker's argv (--with-nth, --id-nth) is fixed at launch, but its rows come from a
// later `--body` process reading the script off disk. These cover the fingerprint that
// tells the two apart. The end-to-end proof -- that a picker actually restarts rather
// than rendering skewed columns -- is in agentview-ui.test.js, through a real pty.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_agentview');
const LIB = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview');

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A self-contained copy of launcher + modules, so a test may rewrite a module without
// touching the checkout the suite is running from.
function copyTree() {
  const root = scratch('av-fp-');
  const bin = path.join(root, 'bin');
  const lib = path.join(root, 'share', 'agentview');
  fs.mkdirSync(bin, { recursive: true });
  fs.cpSync(LIB, lib, { recursive: true });
  const self = path.join(bin, 'agentview');
  fs.copyFileSync(SRC, self);
  fs.chmodSync(self, 0o755);
  return { self, lib };
}

const run = (t, args, env = {}) => execFileSync('bash', [t.self, ...args], {
  encoding: 'utf8',
  env: { ...process.env, AGENTVIEW_SELF: t.self, AGENTVIEW_LIB: t.lib, ...env },
}).trim();

test('--fingerprint is stable across calls when nothing changed', () => {
  const t = copyTree();
  assert.strictEqual(run(t, ['--fingerprint']), run(t, ['--fingerprint']));
});

test('--fingerprint is non-empty', () => {
  const t = copyTree();
  assert.ok(run(t, ['--fingerprint']).length > 0, 'an empty fingerprint would compare equal forever');
});

test('--fingerprint changes when a module changes', () => {
  const t = copyTree();
  const before = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  assert.notStrictEqual(run(t, ['--fingerprint']), before);
});

test('--fingerprint changes when the launcher itself changes', () => {
  const t = copyTree();
  const before = run(t, ['--fingerprint']);
  fs.appendFileSync(t.self, '\n# nudge\n');
  assert.notStrictEqual(run(t, ['--fingerprint']), before);
});

test('--fingerprint is unchanged when a module is rewritten with identical bytes', () => {
  // chezmoi apply rewrites files whether or not their content moved; a stat-based
  // fingerprint would restart the picker on every apply, including no-op ones.
  const t = copyTree();
  const before = run(t, ['--fingerprint']);
  const p = path.join(t.lib, 'render.sh');
  const body = fs.readFileSync(p);
  fs.writeFileSync(p, body);
  assert.strictEqual(run(t, ['--fingerprint']), before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agentview/agentview-repaint.test.js`
Expected: FAIL — the launcher has no `--fingerprint` mode, so `execFileSync` throws a non-zero exit.

- [ ] **Step 3: Add the helper**

In `home/dot_local/share/agentview/common.sh`, after `av_remote_fingerprint`'s closing brace:

```bash
# The picker's field selection (--with-nth, --id-nth) is argv, read once at launch, but its
# rows come from a separate `--body` process reading these files off disk at repaint time.
# An upgrade landing between the two renders correct rows into the wrong columns, silently,
# until the picker is closed (a493a71 did exactly that). This is what the two are compared on.
#
# CONTENT, like av_remote_fingerprint above and for a second reason: `chezmoi apply` rewrites
# a managed file whether or not its bytes moved, so size+mtime would restart the picker on
# every apply, including one that changed nothing here.
av_script_fingerprint() {  # -> _av_sfp
  local f h
  _av_sfp=""
  for f in "${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}" "$AV_LIB"/*.sh; do
    [ -f "$f" ] || continue
    h=$(cksum < "$f" 2>/dev/null) || h=NA
    _av_sfp="$_av_sfp$h|"
  done
}
```

- [ ] **Step 4: Wire the mode**

In `home/dot_local/bin/executable_agentview`, add to the `case "$mode"` at line 292-306:

```bash
  --fingerprint)                     _avmods="common" ;;
```

and after the `--resolve` handler (line 316):

```bash
if [ "$mode" = "--fingerprint" ]; then av_script_fingerprint; printf '%s\n' "$_av_sfp"; exit 0; fi
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/agentview/agentview-repaint.test.js`
Expected: PASS, 5/5.

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/share/agentview/common.sh home/dot_local/bin/executable_agentview tests/agentview/agentview-repaint.test.js
git commit -m "agentview: fingerprint the launcher and its modules"
```

---

### Task 2: `--repaint`, `--query`, and `ctrl-f`

**Files:**
- Modify: `home/dot_local/bin/executable_agentview` — dispatch, arg capture, startup export, the `ctrl-f` bind at line 664
- Test: `tests/agentview/agentview-repaint.test.js` (extend)

**Interfaces:**
- Consumes: `av_script_fingerprint` → `_av_sfp` (Task 1)
- Produces: `agentview --repaint <query>` prints exactly one fzf action string; `agentview --query <str>` opens the picker with that filter pre-typed; the picker exports `AV_SCRIPT_FP`

- [ ] **Step 1: Write the failing test**

Append to `tests/agentview/agentview-repaint.test.js`:

```javascript
test('--repaint asks for a reload when the fingerprint matches', () => {
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  const out = run(t, ['--repaint', ''], { AV_SCRIPT_FP: fp });
  assert.match(out, /^reload\(/, `expected a reload action, got: ${out}`);
  assert.doesNotMatch(out, /become/);
});

test('--repaint asks fzf to replace itself when a module changed underneath it', () => {
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  const out = run(t, ['--repaint', ''], { AV_SCRIPT_FP: fp });
  assert.match(out, /^become\(/, `expected a become action, got: ${out}`);
});

test('--repaint carries the typed query into the restart', () => {
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  const out = run(t, ['--repaint', 'chez'], { AV_SCRIPT_FP: fp });
  assert.match(out, /--query 'chez'/, `query must survive the restart, got: ${out}`);
});

test("--repaint quotes a query that would otherwise break out of the become string", () => {
  // become() hands its argument to a shell, so an apostrophe in the filter is a
  // quoting hole, not a cosmetic issue.
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  const out = run(t, ['--repaint', "it's"], { AV_SCRIPT_FP: fp });
  assert.match(out, /--query 'it'\\''s'/, `expected a shell-safe query, got: ${out}`);
});

test('--repaint with no exported fingerprint does not restart in a loop', () => {
  // A missing AV_SCRIPT_FP means "launched by something that never set it" -- an old
  // picker, or a direct call. Restarting on that would replace the picker on every
  // keypress forever, which is worse than the skew being fixed.
  const t = copyTree();
  const out = run(t, ['--repaint', '']);
  assert.match(out, /^reload\(/, `expected reload when no baseline was exported, got: ${out}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agentview/agentview-repaint.test.js`
Expected: FAIL on the five new tests — no `--repaint` mode.

- [ ] **Step 3: Add the `--repaint` mode**

Dispatch entry, beside the `--fingerprint` one added in Task 1:

```bash
  --repaint)                         _avmods="common" ;;
```

Handler, directly after the `--fingerprint` handler:

```bash
# --repaint QUERY: what every repaint bind now calls. It prints ONE fzf action -- a reload
# when this fzf's argv still matches the script on disk, and a become when it does not, so
# the replacement process parses its own --with-nth instead of inheriting a stale one.
# An unset AV_SCRIPT_FP means nobody exported a baseline (a direct call, or a picker from
# before this existed): reload, because restarting against no baseline never converges.
if [ "$mode" = "--repaint" ]; then
  av_script_fingerprint
  _av_rp_self="${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}"
  if [ -z "${AV_SCRIPT_FP:-}" ] || [ "$_av_sfp" = "$AV_SCRIPT_FP" ]; then
    printf "reload('%s' --body)+refresh-preview" "$_av_rp_self"
  else
    # become() runs this through a shell, so the query is single-quoted with the
    # embedded-quote escape rather than interpolated raw.
    _av_rp_q=$(printf '%s' "${2:-}" | sed "s/'/'\\\\''/g")
    printf "become('%s' --query '%s')" "$_av_rp_self" "$_av_rp_q"
  fi
  exit 0
fi
```

- [ ] **Step 4: Add `--query` and export the baseline**

`--query` reaches the picker through the `*)` arm of the dispatch, which already loads every module, so only the value needs capturing. Immediately before `SELF=` at line 589:

```bash
# --query STR: seeds fzf's filter. Exists so --repaint's become can hand the typed query
# to the picker that replaces it; harmless to pass by hand.
AV_QUERY=''
[ "$mode" = "--query" ] && AV_QUERY="${2:-}"
```

After `SELF=...` (line 589):

```bash
# The baseline every --repaint compares against. Exported, not passed as an argument,
# because fzf's transform children inherit this process's environment.
av_script_fingerprint
export AV_SCRIPT_FP="$_av_sfp"
```

In the fzf invocation, beside `--prompt`:

```bash
  --query="$AV_QUERY" \
```

- [ ] **Step 5: Rewrite the `ctrl-f` bind**

At `executable_agentview:664`, replace:

```bash
  --bind='ctrl-f:reload('"'$SELF'"' --body)+refresh-preview+execute-silent(nohup '"'$SELF'"' --refresh-remote '"$portfile"' >/dev/null 2>&1 &)' \
```

with:

```bash
  --bind='ctrl-f:transform('"'$SELF'"' --repaint {q})+execute-silent(nohup '"'$SELF'"' --refresh-remote '"$portfile"' >/dev/null 2>&1 &)' \
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/agentview/agentview-repaint.test.js tests/agentview/agentview-ui.test.js`
Expected: PASS. The ui suite must stay green — it drives `ctrl-f` already.

- [ ] **Step 7: Prove it by hand**

```bash
AGENTVIEW_SELF=$PWD/home/dot_local/bin/executable_agentview \
AGENTVIEW_LIB=$PWD/home/dot_local/share/agentview \
  bash home/dot_local/bin/executable_agentview
```

With the picker open, in another terminal append a comment line to `home/dot_local/share/agentview/render.sh`, then press `ctrl-f`. The picker restarts and rows stay correct.

- [ ] **Step 8: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview/agentview-repaint.test.js
git commit -m "agentview: restart the picker when ctrl-f finds the script changed"
```

---

### Task 3: The remaining seven binds and the fold toggle

**Files:**
- Modify: `home/dot_local/bin/executable_agentview:659-666` (binds) and `:107` (fold toggle)
- Test: `tests/agentview/agentview-repaint.test.js` (extend)

**Interfaces:**
- Consumes: `--repaint` (Task 2)
- Produces: no new interface — every keyboard repaint path routes through `--repaint`

- [ ] **Step 1: Write the failing test**

Append to `tests/agentview/agentview-repaint.test.js`:

```javascript
test('no repaint bind reloads unconditionally', () => {
  // One missed bind is a picker that still renders skewed columns, and only on the key
  // nobody thought to press. Read the binds rather than trusting the edit.
  const src = fs.readFileSync(SRC, 'utf8');
  const binds = src.split('\n').filter((l) => /^\s*--bind='/.test(l) && l.includes('--body'));
  const unconditional = binds.filter((l) => !l.includes('--repaint'));
  assert.deepStrictEqual(unconditional, [], 'every bind that repaints must go through --repaint');
  assert.ok(binds.length >= 8, `expected the repaint binds to still be there, found ${binds.length}`);
});

test('the fold toggle repaints conditionally too', () => {
  // --enter is the one repaint that is neither a key bind nor the poster.
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  const out = run(t, ['--enter', 'fold:completed'], { AV_SCRIPT_FP: fp });
  assert.match(out, /become\(/, `a fold toggle on a changed script must restart, got: ${out}`);
});

test('the fold toggle still folds when nothing changed', () => {
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  const out = run(t, ['--enter', 'fold:completed'], { AV_SCRIPT_FP: fp });
  assert.match(out, /--fold fold:completed/, `expected the fold action, got: ${out}`);
  assert.match(out, /reload\(/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agentview/agentview-repaint.test.js`
Expected: FAIL — seven binds still say `reload(`, and `--enter` is unconditional.

- [ ] **Step 3: Rewrite the seven binds**

In `executable_agentview:659-666`, replace each `reload('$SELF' --body)+refresh-preview` with `transform('$SELF' --repaint {q})`. `--repaint` already emits `+refresh-preview` in its reload branch, so it is dropped from the bind:

```bash
  --bind='ctrl-t:execute('"'$SELF'"' --send {1})+transform('"'$SELF'"' --repaint {q})' \
  --bind='ctrl-v:execute('"'$SELF'"' --resume {1})+transform('"'$SELF'"' --repaint {q})' \
  --bind='ctrl-g:execute-silent('"'$SELF'"' --groupby)+transform('"'$SELF'"' --repaint {q})' \
  --bind='ctrl-r:execute('"'$SELF'"' --rename {1})+transform('"'$SELF'"' --repaint {q})' \
  --bind='ctrl-p:execute-silent('"'$SELF'"' --pin {1})+transform('"'$SELF'"' --repaint {q})' \
  --bind='ctrl-n:'"$AV_EXEC"'('"'$SELF'"' --spawn '"$portfile"')+transform('"'$SELF'"' --repaint {q})' \
  --bind='ctrl-x:'"$AV_EXEC"'('"'$SELF'"' --remove {1})+transform('"'$SELF'"' --repaint {q})' \
```

- [ ] **Step 4: Make the fold toggle conditional**

`--enter` already prints an action string, so it gains a branch rather than a mechanism. It needs `common` for the helper — change its dispatch arm so the fold path can call it. In the `case "$mode"` block, move `--enter` to:

```bash
  --enter)                           _avmods="common" ;;
```

Then at line 107, replace the `fold:*` arm:

```bash
    fold:*) av_script_fingerprint
            if [ -n "${AV_SCRIPT_FP:-}" ] && [ "$_av_sfp" != "$AV_SCRIPT_FP" ]; then
              # Fold the group first regardless -- the restart must not swallow the keypress.
              "${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}" --fold "$2" >/dev/null 2>&1
              printf "become('%s')" "${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}"
            else
              printf "execute-silent('%s' --fold %s)+reload('%s' --body)" \
                "${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}" "$2" "${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}"
            fi ;;
```

Note: `--enter` receives no `{q}`, so its restart carries no query. That is correct — enter is not a filtering key, and adding `{q}` to the bind would change the argument positions `--skip` and `--enter` already share.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/agentview/agentview-repaint.test.js tests/agentview/agentview-ui.test.js tests/agentview/agentview-hotkeys.test.js`
Expected: PASS. `agentview-hotkeys.test.js` greps the `--bind` strings, so it is the suite most likely to notice a malformed edit.

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/bin/executable_agentview tests/agentview/agentview-repaint.test.js
git commit -m "agentview: route every keyboard repaint through the fingerprint check"
```

---

### Task 4: The background poster

**Files:**
- Modify: `home/dot_local/share/agentview/rows.sh:624-637` (`post_reload`)
- Test: `tests/agentview/agentview-repaint.test.js` (extend)

**Interfaces:**
- Consumes: `av_script_fingerprint` (Task 1), `AV_SCRIPT_FP` inherited from the picker that spawned the poster
- Produces: `post_reload` POSTs a `become(...)` instead of a `reload(...)` when the script changed

- [ ] **Step 1: Settle the open question from the spec**

Run this probe to find out whether fzf's `--listen` API resolves `{q}` inside a POSTed `transform`:

```bash
printf 'K\tI\tROW-A\n' > /tmp/av-listen-probe.tsv
fzf --delimiter='\t' --with-nth=3.. --listen=8099 < /tmp/av-listen-probe.tsv &
sleep 1
curl -s -XPOST 127.0.0.1:8099 --data "transform(printf 'reload(printf %s' \"q=[{q}]\")"
```

Expected if it works: the list shows `q=[]` (the query resolved to empty). If instead the literal text `{q}` appears, or fzf ignores the action, the placeholder is not resolved on this path.

Either way the implementation in Step 3 is the same — the poster checks the fingerprint itself, which needs no placeholder. Record the answer in the commit message so nobody re-probes it.

- [ ] **Step 2: Write the failing test**

Append to `tests/agentview/agentview-repaint.test.js`:

```javascript
const { spawnSync } = require('node:child_process');

// post_reload is a shell function, so it is exercised by sourcing rows.sh with a stub curl
// on PATH and reading what it would have POSTed.
function postedAction(t, { changed }) {
  const bin = scratch('av-post-');
  const log = path.join(bin, 'curl.log');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\nfor a in "$@"; do printf '%s\\n' "$a"; done >> ${log}\n`, { mode: 0o755 });
  const portfile = path.join(bin, 'port');
  fs.writeFileSync(portfile, '8099\n');

  const fp = run(t, ['--fingerprint']);
  if (changed) fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');

  spawnSync('bash', ['-c', `source "$1/common.sh"; source "$1/rows.sh"; post_reload "$2"`, 'bash', t.lib, portfile], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AGENTVIEW_SELF: t.self,
      AGENTVIEW_LIB: t.lib,
      AV_SCRIPT_FP: fp,
      HOME: scratch('av-post-home-'),
    },
  });
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
}

test('the background poster reloads while the script is unchanged', () => {
  const t = copyTree();
  const posted = postedAction(t, { changed: false });
  assert.match(posted, /reload\(/, `expected a reload POST, got: ${posted}`);
  assert.doesNotMatch(posted, /become\(/);
});

test('the background poster restarts the picker when the script changed', () => {
  // The inotify-driven repaint is the one that fires without anybody pressing a key, so
  // leaving it unconditional means the skew can appear while the picker sits untouched.
  const t = copyTree();
  const posted = postedAction(t, { changed: true });
  assert.match(posted, /become\(/, `expected a become POST, got: ${posted}`);
});
```

- [ ] **Step 3: Make the POSTed action conditional**

In `rows.sh`, replace the `curl` call at the end of `post_reload`:

```bash
  local pf="$1" p self action
  command -v curl >/dev/null 2>&1 || return 0
  [ -n "$pf" ] || return 0
  for _ in $(seq 1 40); do [ -s "$pf" ] && break; sleep 0.05; done   # await fzf's port (start-bind)
  p=$(cat "$pf" 2>/dev/null)
  self="${AGENTVIEW_SELF:-$HOME/.local/bin/agentview}"
  # This is the repaint nobody triggers -- it arrives from inotify while the picker sits
  # untouched -- so it needs the same check the key binds get. The poster does it here
  # rather than POSTing a transform: it is already a separate process reading the same
  # files, and it inherited the picker's baseline through the environment.
  action="reload('$self' --body)+refresh-preview"
  av_script_fingerprint
  if [ -n "${AV_SCRIPT_FP:-}" ] && [ "$_av_sfp" != "$AV_SCRIPT_FP" ]; then
    # No query: the poster does not know what is typed, and fzf resolves no placeholder
    # for it here. Losing the filter on a background restart beats rendering wrong columns.
    action="become('$self')"
  fi
  [ -n "$p" ] && curl -s -XPOST "127.0.0.1:$p" --data "$action" >/dev/null 2>&1
  return 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agentview/agentview-repaint.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/share/agentview/rows.sh tests/agentview/agentview-repaint.test.js
git commit -m "agentview: check the fingerprint on the inotify-driven repaint too"
```

---

### Task 5: The end-to-end proof through a real pty

**Files:**
- Modify: `tests/agentview/agentview-ui.test.js:82` (`makeEnv` return) and append one test

**Interfaces:**
- Consumes: everything above
- Produces: nothing — this is the test that the earlier unit tests cannot be a substitute for

- [ ] **Step 1: Expose the module copy from `makeEnv`**

At `tests/agentview/agentview-ui.test.js:82`, change:

```javascript
  return { bin, home, env, self, tmuxLog };
```

to:

```javascript
  return { bin, home, env, self, lib, tmuxLog };
```

- [ ] **Step 2: Write the failing test**

Append to `tests/agentview/agentview-ui.test.js`:

```javascript
test('a picker whose row format changes under it restarts instead of skewing', { skip }, async (t) => {
  // The failure this prevents, exactly: a493a71 added a column and moved --with-nth from
  // 2.. to 3.., and every picker already open rendered the new field 2 -- the \x1f-joined
  // host/cwd/kind identity -- as display text. Asserting that --repaint prints "become("
  // would pass while the screen still showed that, so this drives the real picker and
  // reads the real screen.
  const env = makeEnv();
  seed(env.home);
  const term = open(env.env);
  t.after(() => term.stop());

  await term.waitFor('alpha');

  // Genuinely shift the row format, rather than merely touching the file: with the
  // fingerprint pinned (the mutation check below) this MUST make the screen wrong, or the
  // test is not testing anything. Redefining build_pretty over itself is how a real schema
  // change looks from the picker's side -- rows gain a leading field while the running
  // fzf's argv still says --with-nth=3.., so field 2, the \x1f-joined identity, lands in
  // the display column.
  const render = path.join(env.lib, 'render.sh');
  fs.appendFileSync(render, [
    '',
    '# test-only: shift every row one field to the right',
    'eval "orig_build_pretty() $(declare -f build_pretty | sed \'1d\')"',
    'build_pretty() { orig_build_pretty "$@" | sed \'s/^/EXTRA\\t/\'; }',
    '',
  ].join('\n'));

  term.send('ctrl-f');

  // Wait on the row rather than a fixed delay, so a loaded machine costs latency
  // instead of a false pass.
  await term.waitFor((s) => s.contains('alpha'));
  const screen = term.text();

  // The full cwd is display text ONLY when the columns have skewed -- an intact row shows
  // the leaf name, and the full path lives in the CTRL+O card.
  assert.ok(
    !screen.includes('/home/daniel/dev/alpha'),
    `an identity field leaked into the display:\n${screen}`,
  );
  assert.ok(screen.includes('alpha'), 'the session row must still be there after the restart');
});
```

- [ ] **Step 3: Run it and confirm it passes**

Run: `node --test tests/agentview/agentview-ui.test.js`
Expected: PASS.

- [ ] **Step 4: Mutation check — the test must be able to fail**

Pin the fingerprint so the comparison can never differ:

```bash
perl -pi -e 's/^  av_script_fingerprint$/  av_script_fingerprint; _av_sfp=PINNED/' home/dot_local/bin/executable_agentview
node --test tests/agentview/agentview-ui.test.js
```

Expected: the new test FAILS. Restore with `git checkout home/dot_local/bin/executable_agentview` and re-run to confirm PASS. If it passes while pinned, the test is not exercising the restart and must be fixed before commit.

- [ ] **Step 5: Full gate and commit**

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"   # bg shells lack node
shellcheck home/dot_local/bin/executable_agentview home/dot_local/share/agentview/*.sh
node --test $(git ls-files '*.test.js' '*.test.mjs')
git add tests/agentview/agentview-ui.test.js
git commit -m "agentview: prove the upgrade restart against a real picker"
```

---

## Verification checklist

- [ ] `agentview --fingerprint` changes on a module edit, not on an identical rewrite
- [ ] Every `--bind` that repaints contains `--repaint`; none contains a bare `reload('$SELF' --body)`
- [ ] The fold toggle restarts on a changed script and folds normally otherwise
- [ ] `post_reload` POSTs `become(...)` when the script changed
- [ ] The pty test fails with the fingerprint pinned and passes without
- [ ] shellcheck clean; full `node --test` green
