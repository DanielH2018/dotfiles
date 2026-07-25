# Driven-UI testing for the terminal stack — feasibility

**Verdict: feasible for the TUI layer, and now proven across all three surfaces.** Real
keystrokes and real mouse clicks into a real pty, assertions against the rendered screen.
23 driven tests — 13 against the real `agentview` picker, 5 against the real tmux binds, 5
against the real zsh keybindings. The harness is ~430 lines and adds no dependencies.

The WezTerm layer (its ~31 keybindings and 2 mouse binds) is out of scope by decision — it is a
Windows GUI app and `wezterm cli send-text` bypasses the keybinding layer by design, so it is not
reachable from WSL. See *Not reachable* below.

## What the current tests do, and the gap

Before this work, every one of the 66 files in `tests/` used the same technique: stub the
dependency binaries on `PATH`, run the script as a subprocess, assert on the argv the stubs logged
or on stdout text. Nothing spawned a pty or read rendered output.

For hotkeys this means the binding and the handler are verified *separately*:

```js
// tests/agentview-hotkeys.test.js:309-326 — asserts the bind string exists in the source
assert.match(src, /ctrl-r:execute\([^)]*--rename {1}/, 'ctrl-r renames the selected row');
```

```js
// elsewhere in the same file — asserts the handler works when called directly
run(env, ['--rename', key], { input: 'new title\n' });
```

Both can pass while ctrl-r does nothing: nothing checks that the key reaches the handler. The new
test presses the key and waits for the prompt to appear on screen.

## Three blockers, and what each cost

**1. fzf blocks on a cursor-position query.** The first pty attempt rendered nothing. The pty had
emitted exactly 46 bytes and stopped:

```
ESC[?2026h ESC[?7l ESC[?25l ESC[6n ESC[0m ESC[?25h ESC[?7h ESC[?2026l
```

`ESC[6n` is a Device Status Report — fzf's `--height` mode asks the terminal where the cursor is
and waits for the reply before drawing. A pipe never answers, so it hangs forever, looking exactly
like a hung app. **The harness has to act like a terminal, not just parse one.** `tests/lib/pty.js`
answers DSR, DA1/DA2, kitty-keyboard and synchronized-output queries.

This is also why the obvious approach fails. `tmux send-keys` + `capture-pane` delivers keys
correctly (typing `gam` + Enter into fzf really did return `gamma`) but captures a blank screen,
with `alternate_on=1` and fzf alive in the foreground — same unanswered query, and tmux won't
answer it for a detached client. `less` captures fine under the same setup, which is what makes the
failure look mysterious. **Don't reach for `capture-pane`.**

**2. The selected row is not identifiable by text.** agentview sets `--pointer='▌'`, and `▌` is the
glyph fzf already draws in the gutter of *every other* row. Confirmed by running plain fzf with
`--pointer='>'`: the selected row gets `>`, the rest get `▌`. With the pointer set to the gutter
glyph, every row looks identical in plain text.

The selected row is distinguishable only by `--highlight-line`'s background, so the screen model
tracks background colour per cell and erases fill with the current background (back-colour erase,
which is how a full-width highlight is actually painted). `Screen.highlightedRows()` returns the
row whose background differs from the page.

**3. The source file is not executable.** chezmoi only sets the `executable_` bit on deploy, so the
source is mode 644. The picker shells out to `$AGENTVIEW_SELF` for previews and every hotkey bind,
so the test copies the script to a scratch dir with mode 755 and points `AGENTVIEW_SELF` at it —
which also means the tests exercise the *source*, not the deployed copy.

## Harness

Two library files and three suites, no dependencies. npm and pip are both unavailable here (`tests/python-suites.test.js`
records that this machine has no pytest/pip), which rules out `node-pty`, `@xterm/headless` and
`pyte` — so both the pty and the VT parser are hand-rolled.

| File | Lines | Role |
|---|---|---|
| `tests/lib/pty.js` | 173 | pty via `script(1)`; key/mouse encoding; terminal query replies; `waitFor`; the tier gate |
| `tests/lib/vt.js` | 256 | VT100/xterm screen model — cursor, erases, scroll region, alt screen, background colour |
| `tests/agentview-ui.test.js` | 310 | 13 driven tests against the real picker |
| `tests/tmux-binds-ui.test.js` | 152 | 5 tests against a real tmux server attached inside the harness pty |
| `tests/zsh-keys-ui.test.js` | 162 | 5 tests against the chezmoi-rendered `dot_zshrc.tmpl` in an interactive zsh |

`script(1)` is the pty provider: node has no stdlib pty and this repo carries no native modules.
`stty` sizes the pty from inside, since `script` would otherwise inherit the pipe's absent winsize
and fzf would size itself wrong.

`waitFor` polls the parsed screen rather than sleeping, so a slow machine costs latency instead of
a false failure, and a timeout prints the rendered screen — which is how all three blockers above
were diagnosed.

## What the tests cover

**`agentview-ui.test.js` — 13 tests.** Render, type-to-filter, arrow selection, mouse
click, `enter` switch, `alt-2` jump, `ctrl-r` rename, `ctrl-p` pin, `ctrl-o` preview toggle, `?`
cheatsheet, `ctrl-x` cancel, `ctrl-x` confirm, `esc` close.

The ctrl-r test is the one the existing suite cannot express: it presses the key, waits for
`new name>` to appear on screen, types a name, and asserts the resulting
`tmux -S /tmp/s.sock send-keys -t %2 -l /rename renamed-by-test` in the stub log. Key → rendered
prompt → typed input → correct backend command, end to end.

The ctrl-x pair is the sharpest: outside tmux the bind runs under `execute()`, so the confirm
chooser is a *second* fzf that replaces the picker in the same pty. Both branches are asserted —
cancel leaves the session file on disk, confirm deletes it and leaves the other row alone. That
also proves the harness survives one TUI handing off to another mid-pty.

The mouse test writes the same SGR byte sequence a terminal sends on a click
(`ESC[<0;col;rowM` / `m`); fzf enables SGR mouse reporting (`?1000h ?1002h ?1006h`) on startup.

**`tmux-binds-ui.test.js` — 5 tests.** A real tmux server on a private socket, loading the real
`dot_tmux.conf`, attached by a real client *inside the harness pty* — so tmux paints into a screen
the model already parses and `capture-pane` never enters the picture. Covers `prefix+g`,
`prefix+G` (asserting the `--spawn` argv the bind passes), and both branches of the conditional
no-prefix `C-Left`: passed through at a shell prompt, stolen over a non-shell process. The
non-shell test waits on `#{pane_current_command}` reaching `sleep` before pressing the key, so it
cannot pass merely because the pane had not started yet.

**`zsh-keys-ui.test.js` — 5 tests.** The rc under test is chezmoi's own render of
`dot_zshrc.tmpl` (`chezmoi execute-template`, read-only — it never touches the deployed
`~/.zshrc`), plus the real `common.sh`, in an interactive zsh. Covers `ctrl-r` history widget
(asserting the line lands on the prompt *without* running), `ctrl-t` file insert, `alt-c` cd,
`ctrl-left` → `backward-word`, and prefix history search on `up`. Only the prompt is overridden —
starship's precmd repaints `PROMPT` every line, and the tests need one fixed string to
synchronise on.

## Three more traps the extension turned up

**A query hides fzf's group headers.** The pin test first asserted `PINNED` appeared after
`ctrl-p` while a filter was active. Group headers are rows with an empty key, so any query
filters them out along with everything else that doesn't match. Assertions about grouping have to
run on an unfiltered list.

**Pressing enter before the query has filtered accepts the wrong row.** Typing into fzf and
immediately sending `enter` races the redraw — the first zsh `ctrl-r` run accepted the previous
selection instead of the match. Every filter-then-accept sequence now seeds a decoy entry and
waits for it to *disappear* before pressing enter.

**Waiting for row text is not waiting for a settled picker.** The `?` test passed 20+ times and
then failed once under full-suite load, with the preview showing the session card instead of the
cheatsheet. agentview's `load` bind fires a `--skip` transform chain that walks the cursor off the
group header, and every cursor move refreshes the preview — so a `?` that lands mid-chain has its
temporary `preview(--keys)` overwritten by the standing `--preview`. The fix is to wait on
`highlightedRows()` reaching the first real row, not on the row's text appearing.

All three are the same lesson: **synchronise on the state the next keystroke depends on, not on
the first pixel that proves the app is alive.** They surface as intermittent failures, so they
only appear under load or repetition — which is why the suites were run 15× isolated and 8× inside
the full suite rather than once.

The remaining fix was a timeout, not a synchronisation bug: `waitFor`'s default went 5 s → 10 s
and the tmux prompt wait to 20 s, because `node --test` runs files in parallel and every wait here
is on a real process start. A high ceiling costs nothing on a passing test.

## Measured

Every figure below was run in this session. Treat them as ranges, not benchmarks: the box carried
a heavy concurrent workload from other sessions throughout (load average 16–29), and the same
suite varied by 4–5× across runs. Nothing here was measured on an idle machine.

| Run | Observed range |
|---|---|
| `agentview-ui.test.js` (13 tests) | 2.5 s – 12.8 s |
| `tmux-binds-ui.test.js` (5 tests) | 3.0 s – 8.8 s |
| `zsh-keys-ui.test.js` (5 tests) | 21.3 s – 28.5 s |
| Full suite, Tier A | 15.6 s – 17.2 s |
| Full suite, both tiers | 24.1 s – 72.9 s |

Stability: `agentview-ui` 15/15 isolated runs clean; Tier B 8/8 clean after the timeout fix; the
full suite 8× Tier A and 5× both tiers with **no failure from any of the three new suites**.
Totals with both tiers on: 559 tests, 555 pass, 4 skipped (pre-existing Windows-only wezterm).

The load sensitivity is the argument for the tier split on its own — `zsh-keys-ui` never dropped
below 21 s once the machine was busy, which is the wrong shape for a default `node --test`.

**One pre-existing flake, not caused by this work.**
`tests/agent-view-state-hook.test.js` fails intermittently with `spawnSync bash EPIPE`. It was
reproduced at **5/12 runs with all three new suites stashed out of the tree**, so it is a
load-sensitive defect in that test, not a consequence of adding pty tests — though the extra
parallel load does make it fire more often.

## Reachable but not yet built

Verified reachable in principle by the same harness; **not yet written or run** — treat as
projected, not proven:

- agentview's `--spawn` sub-pickers (host / backend / repo / branch) and `ctrl-f` refresh.
- zsh's completion menu and autosuggestion ghost text.

## Not reachable

**WezTerm's own keybindings and mouse binds.** `wezterm cli send-text` pastes into a pane and never
passes through the input layer, so `CTRL+SHIFT+S → open_agentview()` cannot be triggered by it. The
only true options are OS-level injection into the Windows GUI (needs an interactive desktop, flaky,
not headless) or a Linux wezterm under Xvfb + xdotool — but `wezterm.lua.tmpl` is Windows-gated and
renders no config on this host, and the WSL binary is `20240203` against the Windows `20260716`.

The cheap partial substitute, if this ever matters: unit-test the Lua `action_callback`s with a
stubbed `wezterm` module, which would cover the CTRL+Left shell-vs-app heuristic
(`wezterm.lua.tmpl:297-323`). That is logic testing, not UI testing.

## Limits of the screen model

- Wide characters count as width 1. Text assertions are unaffected; column-precise clicks on a row
  containing CJK or emoji would drift.
- Only background colour is tracked, not foreground or bold — so "is this row selected" works,
  "is this text green" does not.
- `script(1)` flags are util-linux-specific. Fine for WSL and Linux; macOS `script` takes different
  arguments and would need a branch.
- The parser implements the subset these apps emit. A TUI using something exotic may need
  additions — the failure mode is a visibly wrong screen dump in the timeout message, not a silent
  pass.

## Tier split

The gate is `tierB()` in `tests/lib/pty.js`; the two slow suites start their `skip` expression
with it.

- **Tier A, headless / CI — default.** `agentview-ui.test.js`. Plain `node --test`, no desktop, no
  network (`ssh`, `curl` and `claude` are stubbed inert so the background remote refresh can't cost
  a connect timeout). ~190 ms per test on a quiet machine, ~1 s under load.
- **Tier B, opt-in — `UI_TIER_B=1 node --test`.** `tmux-binds-ui.test.js` and
  `zsh-keys-ui.test.js`. Both boot a real process tree — a tmux server, or an interactive zsh
  sourcing the full rc — which costs ~1 s of startup per test regardless of what the test then
  does. Ten tests at that price would dominate the default run, and neither depends on a desktop,
  so the split is about wall-clock, not capability. CI can turn the var on where the budget allows.

Tier B also skips the `chezmoi execute-template` render at module load, so the gate costs nothing
when it's off.
