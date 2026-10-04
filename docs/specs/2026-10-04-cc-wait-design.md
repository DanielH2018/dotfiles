# cc-wait: one wait command for every Claude Code session

Date: 2026-10-04. Status: approved in conversation; slice 1 ships with this document.

## Goal

Every wait a Claude Code session makes runs through one CLI, `cc-wait`. That covers a
landing, CI, a rollout and a file. One `claude-guard` PreToolUse rule decides how the harness
runs the call. A repo contributes only small read-only probe scripts. The loop, the budget,
the output format and the exit codes are defined once, in this package.

## Non-goals

- A wait inside a script is not a Claude wait. The homelab deployer's CI gate and the merge
  poll inside a running landing keep their own loops.
- Loops inside deployed services (init containers, drills, cronjobs) are out of scope.

## Why

The homelab session transcripts for the 30 days to 2026-10-04 cover 317 sessions:

- **Backgrounding already works.** 112 of 115 backgrounded `land.sh … --await-verdict`
  calls woke their session through the task notification.
- **Foreground waits past 600s did not.** 15 foreground waits ran past the 600s limit and
  the harness moved them to the background. 12 of those 15 never delivered a notification,
  and all 12 ran in fan-out `claude -p` agents, which cannot be woken once their turn ends.
- **Hand-polling remained.** In the four days from 2026-10-01 there were 39 `gh pr checks`
  calls, 35 `gh run view/watch`, 34 `sleep N` and 31 tick-state checks, all in the
  foreground.
- **Monitors still polled underneath.** 36 Monitor calls wrapped a hand-written
  `while … sleep` loop.

Every wait site wrote its own loop, its own budget and its own idea of what failure looks
like. A wait that greps only for its success line reads a crash as "still waiting" until the
budget runs out.

## The contract

- **Re-running is resuming.** `cc-wait` keeps no state of its own. The state lives in what it
  waits on: a `.rc` file, GitHub's check runs, a unit's state. Running the same command again
  reattaches to the same wait.
- **The budget fits a foreground Bash call.** The default is 570s, below the 600s limit.
  `--budget S` changes it, wherever it appears in the command line, and `CC_WAIT_BUDGET` sets
  the default. When the budget elapses, `cc-wait` exits 75 and prints the waiter-only resume
  command. It never prints the command that started the work.
- **A source owns its exit codes.** Each terminal state declares the exit code it ends the
  wait with. The final line carries the state word, so a landing verdict such as `deferred`
  still reaches the caller.
- **Two codes are reserved.** 75 means "re-run this cc-wait command". 2 means "cc-wait could
  not wait": an unknown source, a malformed probe, or five failed reads in a row. A source
  that declares either code is refused. A probe whose own tool uses one remaps it.
- **A failure state is required.** A source must declare at least one terminal state with a
  non-zero code, or `cc-wait` refuses it. This enforces Monitor's "silence is not success"
  rule once instead of trusting every call.
- **One output format.** One line per change of state or detail
  (`16:20:01 <state>: <detail>`), then a final `WAIT: <state> <detail>`. The same command
  works as a background task, which gives one notification, and as a Monitor command, which
  gives a stream.

### Probe protocol

A repo probe is a git-tracked executable at `.claude/wait-sources/<name>`, in any language.

- `<probe> --describe <args>` prints a JSON object. It has `terminal` (state to exit code),
  `watch` (paths), `interval_s` and `remote`.
- `<probe> <args>` prints one JSON line, `{"state": …, "detail": …}`, and exits 0. Any other
  exit is a failed read, and `cc-wait` retries it.
- `cc-wait` refuses a probe that git does not track, and a probe named like a built-in.

### Transport

- A source that lists `watch` paths is re-read on each change reported by `inotifywait`
  (Linux) or `fswatch` (macOS), and at its interval as a backstop. Without either tool it is
  polled. Both are optional.
- Remote sources share one cache per host, so ten sessions waiting on one PR make one API
  call per interval. The cache is keyed on the bound source's `repr`, and a failed read is
  never cached.
- The GitHub sources call the `gh` CLI, so a wait spends the session's authenticated quota
  and never the anonymous 60 requests an hour a host shares with its deployer.

## Trust

`cc-wait` carries no allow entry: the auto-mode classifier approved every call during the
2026-10-04 rollout. `claude-guard`'s read-only classifier does not approve it, because a
repo probe is code it cannot prove read-only. A repo probe gets the same trust as that
repo's `.claude/hooks/`,
which already run without a prompt on every tool call, so probes add no trust boundary.
Probes must be read-only. This document states the rule, and nothing can check it. The one
mechanical condition is that git tracks the probe.

## Interpreter

The package is stdlib-only and 3.14-only, under uv's managed interpreter, like
`claude-guard`. `~/.local/bin/cc-wait` finds that interpreter the same way `claude-guard`'s
wrapper does. A missing interpreter exits 2.

## The harness binding (slice 3)

A `claude-guard` PreToolUse arm rewrites a Bash call that runs `cc-wait`:

- **A session that can be woken** gets `run_in_background: true` and a 30-minute Bash timeout.
  When `cc-wait` is the command's last stage, the rewrite also appends `--budget 1740`, which
  `cc-wait` reads wherever it appears. A landing of up to 29 minutes then wakes the session
  once, not every 570s.
- **One that cannot** stays in the foreground with `timeout: 600000`. The 120s default would
  cut off a 570s budget.
- **The rewrite copies the whole tool input.** The harness replaces the input with
  `updatedInput` rather than merging it (server #3501, dotfiles #771). The arm emits no
  `permissionDecision`.
- **The wakeable test.** A call is wakeable when its hook input has no `agent_id`, and the
  nearest `claude` ancestor either lacks `--print` or carries `--input-format stream-json`.
  The rule walks ancestors with `ps -o ppid=,args=`. When it cannot decide, the call stays in
  the foreground.

| Session | Signal | Result |
|---|---|---|
| Interactive terminal | `claude` with no `--print` | background |
| Bridge / remote-control | `claude --print --sdk-url … --input-format stream-json` | background |
| Fan-out agent | `claude -p … --output-format json` | foreground, 600s |
| Agent-tool subagent | `agent_id` in the hook input | foreground, 600s |
| Cannot tell | no `claude` ancestor | foreground, 600s |

The same rule denies hand-written waits in the foreground: `sleep` of 10s or more,
`until`/`while … sleep` loops, `tail -f` (alone or under `timeout`), `gh run watch`,
`gh pr checks --watch` and `kubectl … -w`. Each denial names `cc-wait` or
`run_in_background: true` as the replacement. The same commands run in the background pass.

Both checks that gated slice 3 passed on 2026-10-04. Each ran a headless `claude -p` (2.1.289)
with a scratch PreToolUse hook added through `--settings`:

- A subagent's Bash call carried `agent_id` and `agent_type: general-purpose`. The main
  agent's calls carried neither.
- The scratch hook set `run_in_background: true` on one Bash call. That call returned
  `Command running in background with ID: b0kjmt8p0`.

## Rollout

| Slice | Repo | What | Status |
|---|---|---|---|
| 0 | both | Hook rewrites keep the whole tool input | done: server #3503, dotfiles #772 |
| 1 | dotfiles | `cc-wait` core: contract, `file`, `exit`, probe discovery | done: dotfiles #773 |
| 2 | server | `land` probe; retire `--await-verdict` | done: server #3511 |
| 3 | dotfiles | the `claude-guard` binding | done: dotfiles #774 |
| 4 | dotfiles | `gh-pr`, `gh-ci`, the shared cache | done: dotfiles #775 |
| 5 | server | the `fanout` probe | done: server #3522 |
| 6 | dotfiles | `systemd`, `k8s-rollout`; `cc-wait --list` stays in the foreground | this PR; the binding fix landed alone as dotfiles #776 |

## Open questions

- Whether the work laptop has `fswatch`. Polling covers it either way.

## Decisions made during the rollout

- **No homelab `ci` probe.** The hand-polling the transcripts measured was `gh pr checks` and
  `gh run view/watch` on a PR before its merge, which `gh-ci --pr` covers. Master CI after a
  merge is `land.sh`'s job, through `await_ci.wait` inside the landing, so a session-level
  probe for it would serve a wait almost nobody makes.
- **A standalone `sleep` is also blocked by Claude Code itself,** before any hook, with its
  own message suggesting a Monitor loop. `claude-guard` adds the chained forms the built-in
  check lets through, such as `x && sleep 15 && y`.
- **Slice 6 builds only `systemd` and `k8s-rollout`.** The Kubernetes waits written by hand
  were a Deployment becoming ready (tdarr, home-assistant) and a Job finishing
  (kuma-maintenance-sync). The systemd wait was a script waiting for `gitops-deploy.service`
  to stop activating. Most other transcript matches for these commands were heredoc text, not
  loops.
- **No `http` source.** An HTTP status has no failure state of its own: a 502 during a rollout
  is the normal path to a 200, so the source could only wait for success and time out. The
  rollout and unit sources end on the failure an HTTP poll stands in for.
- **No homelab `tick` probe.** The 31 tick-state checks ask whether the running tick has
  finished, and `cc-wait systemd gitops-deploy.service` answers that. `gitops_tick.sh` keeps
  its own bounded wait. It runs inside `land.py`, whose landing `cc-wait land` already
  follows, and its join and contention verdicts belong to the deployer.
- **`k8s-rollout` fails on a new pod only for a reason that cannot clear on its own.**
  ImagePullBackOff, InvalidImageName, and CrashLoopBackOff after 3 restarts end the wait.
  ErrImagePull and CreateContainerConfigError can clear once the image or Secret arrives, so
  they appear in the detail and the wait continues. The homelab had no pod-reason set to
  reuse: it detects crash loops by restart count after the rollout
  (`ansible/post_tasks/k8s_stabilise_gate.yml`).
- **A `systemd` wait on a finished oneshot reports that run at once,** with the time it
  ended. A baseline taken when the wait starts would be lost when the wait is re-run, so the
  caller reads the timestamp instead.
