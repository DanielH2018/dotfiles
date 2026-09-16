# pr-dash always-on design

**Goal:** open `http://127.0.0.1:8770` from a browser bookmark and see the dashboard, with no
command to run first and nothing to clean up when something goes wrong.

Extends the `2026-09-14` dashboard spec, which stays the authority on the grouping axes, the
staleness model and the token source, and the `2026-09-15` startup-and-collapse spec, which
stays the authority on the pre-load, the persisted payload and the collapsible sections.

## Why the current design cannot deliver this

`bin/pr-dash` generates a per-launch secret, starts the server, and opens the browser at
`http://127.0.0.1:<port>/#<secret>`. The fragment is what makes that safe — a fragment is
never sent to a server, so nothing can scrape it — and it is also what makes the working URL
un-bookmarkable. Caching the fragment in `localStorage` (commit `05eac8d`) made the bare URL
work for the life of one launch, and no further: the cached secret dies with the process that
minted it, so the bookmark fails whenever no launch has run since.

The deeper problem is direction. A launcher can hand a secret to a browser it opens. A
bookmark the operator opens themselves initiates from the other end, and nothing is positioned
to give that page a secret it does not already have.

## The shape

A launchd agent owns the server's lifecycle. The server starts without a credential, resolves
the GitHub token on the first request that needs one, and exits after an idle period. launchd
restarts it, so the port is always held.

Three consequences follow, and each is a deliberate decision rather than a side effect:

- **The per-launch secret is removed.** `Host` and `Origin` become the whole request boundary.
- **The token is resolved lazily.** Listening needs no credential, so the agent starts
  instantly at login and the first Touch ID prompt arrives when the operator first opens the
  dashboard — which also requires the startup pre-load to become opt-in, for the reason below.
- **The process is disposable.** Any failure state — a wedged fetch, an exhausted retry
  budget, a corrupt anything — is cleared by an idle exit and a restart that costs nothing,
  because there is no per-launch state left to lose.

### Why not socket activation

launchd can hold a listening socket and start a job only when a connection arrives, which is
the textbook answer for an on-demand local service. It hands the process a pre-opened socket
through `launch_activate_socket`, a C API. Node has no binding for it in core, and this project
has no dependencies and no build step — adding a native module to reach it would cost more than
the design it saves.

So the agent uses `KeepAlive` instead, and the idle exit lives in the server. launchd respawns
within `ThrottleInterval`, so the port is held except during a respawn — see the respawn gap
under Deferred, which rejecting socket activation leaves unmitigated. What the idle exit buys
is not an idle machine but a bound on how long the token stays in memory.

## Dropping the per-launch secret

This is a reduction in defence, taken deliberately, and it is the decision a later reviewer
should find already made.

### What the secret was protecting

Not the browser threat. A cross-origin page that fetches `127.0.0.1` sends its own `Origin`,
and a DNS-rebinding attacker's page sends a `Host` naming the attacker's domain; `checkHost`
refuses both, before any route dispatch, and it is unchanged by this design. That half was
never the secret's job.

The secret's own job was the other half: a **local process** can set any `Host` and `Origin` it
likes, so those checks do nothing against it. The secret stopped such a process from reading
`/api/prs`.

### Why removing it costs little

A process running **as the operator** already has the data without the server. The persisted
payload at `~/.local/state/pr-dash/last-payload.json` is mode 0600 — owner-only, which stops
other users and not the owner — and it holds every repository name, branch name and PR title
the API would return. Such a process can also read the token path's own inputs. The
`2026-09-14` spec already conceded this in its `ps` exposure note: anyone who can read your
process list can read your home directory.

What is genuinely lost is a process running as a **different local user** — on a personal work
laptop, a system daemon rather than a person. Before this change it received a 403; now it
receives the PR list. That is a real reduction, bounded to metadata: repository names, branch
names, PR titles, review and CI states. No cardholder data and no credential, so PCI-DSS is
not implicated. It is a SOC 2 access-control question, and the answer is that the loss was
accepted knowingly in exchange for a dashboard that opens from a bookmark.

### Two properties this argument has to name

**Version control is an egress path, and it is not about who can read the file on the host.**
`~/.local/state/pr-dash/` holds `last-payload.json` and `agent.log`, and both carry every
private repository name, branch name and PR title the API returned. A recursive `chezmoi add`
— by hand, by an autocommit sweep, or by `chezmoi-guard.sh`'s auto-resync on a managed path —
would commit them into the dotfiles repo, and the secret-scanning pre-commit hook would not
fire, because there is no credential in either file. Two things block that path: the agent
plist lives in `scheduled/`, outside `home/`, so no part of this feature makes the state
directory a chezmoi target; and `home/.chezmoiignore` carries `.local/state`, which refuses a
`chezmoi add` of either file.

**Dropping the credential makes the server drivable, not merely readable.** "Readable by
anything on this machine that speaks HTTP" undersells the change. Any local process can force
`/api/prs?refresh=1`, which makes the operator's GitHub credential issue API calls on that
process's behalf, and — on a cold start — can trigger a 1Password biometric prompt at will, a
prompt the operator may well approve, since it is a genuine `op` process started by their own
tooling. That is a confused-deputy property, not just an information disclosure: the server
holds an authority the caller does not have and spends it on request.
`FORCE_MIN_INTERVAL_MS` in `main-lib.ts` is the bound — one forced fetch per ten seconds, so
360 an hour rather than as many as a caller can issue — and `TOKEN_FAILURE_TTL_MS` bounds the
prompts behind a failing resolution.

### What replaces it

Nothing. `checkHost` is the boundary, and the honest description of the posture is that the
dashboard is readable by anything on this machine that speaks HTTP with a correct `Host`. The
alternative considered and rejected was a persistent secret injected into the page shell the
server hands out: any local process can fetch that shell, so it would stop nothing determined
while looking like it does — worse than removal, because it invites a reviewer to believe a
boundary exists.

## Lazy token resolution

`main.ts` resolves the token before it listens, and exits non-zero when 1Password is
unavailable. Under launchd that exit is invisible: the agent restarts, fails again, and the
operator sees a port that refuses connections with nothing to read.

The token moves behind the first request that needs it. The server listens immediately; the
first `/api/prs` triggers `resolveToken`, and the result is cached in memory for the process's
life. A failure becomes a `500` carrying the message `resolveToken` already composes — the same
message that used to reach a terminal, now reaching the banner the page already renders for a
failed refresh.

### The pre-load becomes opt-in

The startup pre-load exists to overlap the first GitHub fetch with the launcher's port poll and
the browser's own start, so that a `pr-dash` run paints fresh rows sooner. It calls `loadPrs`
unawaited before `listen()`, which under a lazy token means **it resolves the token at process
start** — and that fires a Touch ID prompt with no operator present.

Under an always-on agent that is not a small cost. `KeepAlive` plus a 30-minute idle exit means
a respawn roughly every 30 minutes, so an unconditional pre-load would prompt for biometrics
all day, unprompted, whether or not anyone opened the dashboard. It would also defeat the idle
exit's only purpose: the token would be re-resolved and resident again seconds after each exit
dropped it.

There is also nothing left to overlap. The agent's server is listening long before the operator
opens a bookmark, so the fetch has no browser startup to hide behind, and the restored payload
paints instantly without a pre-load: `withFallback` answers the first request of the process's
life from the retained payload and starts the fetch behind that response — the **prime path**,
marked by its `primed` flag. Removing that flag reinstates the blank first paint this section
claims not to have, because on the agent path nothing else puts a fetch in flight before the
browser's first `/api/prs` arrives.

So the pre-load is **off by default** and enabled by `PR_DASH_PRELOAD=1`, which `bin/pr-dash`
sets because that path is about to open a browser. The agent does not set it. This keeps the
foreground launcher's original behaviour intact and stops the agent from asking for credentials
nobody requested.

Two properties hold, and both need tests:

- **Concurrent first requests resolve the token once.** The startup pre-load and the browser's
  first request overlap by design, so the in-flight promise is shared the way
  `createPrLoader` already shares a fetch. Two Touch ID prompts for one page load is a defect.
- **A failed resolution is not cached.** A biometric prompt the operator dismisses must not
  poison the process for its remaining life; the next request tries again.

## The idle exit

The server exits 0 after **30 minutes** with no request. The window is a security knob: it
bounds how long the token stays in memory after first use. Shorter means more Touch ID
prompts, longer approaches holding the credential all day, which was declined.

The timer is armed by every request, including the poll. A page left open polls only while a
response says `refreshing`, so an idle tab does not hold the process alive indefinitely.

An exit is not a failure and must not be reported as one: launchd sees status 0, waits
`ThrottleInterval`, and starts a fresh process that listens again.

## The launchd agent

A plist in the repo's `scheduled/` directory, **outside `home/`**, so `chezmoi apply` never
deploys it. The operator renders it to `~/Library/LaunchAgents/` and bootstraps it by hand,
from the activate block in the plist's own header — which also carries deactivate, reload and
check commands, per the convention `README.md` records for that directory.

Why not deploy it: launchd reads a plist only at bootstrap. An auto-deployed plist means an
apply rewrites the file while the loaded job keeps the old definition, so a port or path
change looks applied and is not. Keeping the file out of `~/Library/LaunchAgents` makes
re-activation an explicit step instead of a silently skipped one. The reload block is also
what a code change needs: `chezmoi apply` deploys new `public/` assets under the running
server while `src/` stays at whatever the process loaded.

It sets `PR_DASH_PORT`, runs the server directly rather than through `bin/pr-dash`, keeps the
job alive, and writes stdout and stderr to a log under `~/.local/state/pr-dash/`. The activate
block creates that directory at mode 700 first, because launchd creates the log file but not
its parent.

`bin/pr-dash` survives as the foreground path — useful for watching the log live and for a
machine where the agent is not installed. It loses its secret generation and its port-in-use
refusal, which was advice the bookmark made misleading: it told the operator to open a URL that
could not authenticate.

## Testing

- `checkSecret` and its tests are deleted, and no test asserts a secret header.
- `checkHost` keeps every test it has, and gains no exemption: it still runs first, on every
  path, including the page shell and static assets.
- The token resolves once across concurrent first requests, and a failed resolution is retried
  rather than cached.
- A token failure surfaces as a `500` whose body carries `resolveToken`'s message.
- The idle timer exits 0, is re-armed by a request, and is not armed twice.
- The plist parses, and names the same port and program path the server expects.

## Deferred

- **Socket activation**, for the reasons above. Worth revisiting only if a native binding
  arrives in Node core.
- **A per-user boundary on the API.** If the different-local-user exposure ever matters —
  a shared machine, a multi-tenant host — the answer is a Unix socket with 0600 ownership and
  a local proxy, not a secret in a URL.
- **Restarting on a changed build.** `chezmoi apply` deploys new files under a running server,
  which serves the new static assets immediately and the old server code until the next idle
  exit. Acceptable while the idle window is 30 minutes, and the plist header's reload block is
  the operator's way to skip the wait after a change to the `/api/prs` response shape.
- **The respawn gap.** Between an idle exit and launchd's respawn, `127.0.0.1:8770` refuses
  connections. A browser handed ERR_CONNECTION_REFUSED does not retry, so the operator gets a
  browser error page with nothing about pr-dash on it and has to reload. The window is short —
  the process ran 30 minutes, so `ThrottleInterval` has long expired and launchd respawns
  promptly — but rejecting socket activation means there is no mitigation, only a reload.
- **A foreground `pr-dash` that wins the port wedges the agent.** The probe and the bind are
  not atomic, so if the agent has just idle-exited, the launcher can take 8770 first. Every
  launchd respawn then fails `EADDRINUSE` and retries every `ThrottleInterval` for as long as
  the foreground run lives — six appends a minute to `agent.log`. Accepted: the symptom is
  launchd churn and a growing log, not data loss, and the plist header's deactivate block is
  the operator's way out.
- **`agent.log` is unrotated**, one file taking both stdout and stderr. Steady state is
  roughly 48 lines a day, one per respawn; it is unbounded only under the case above.
- **The credential-failure poll.** A dismissed Touch ID prompt on a cold start leaves the page
  polling a 500 every 600ms for 60 seconds before the give-up banner. `TOKEN_FAILURE_TTL_MS`
  bounds that to roughly a dozen `op` spawns rather than one per poll. Two alternatives were
  rejected: inverting the client's 4xx/5xx contract would make a locked vault permanent when
  it is not, and identifying the error type at the server would mean modifying `src/token.ts`,
  whose `op` runners must stay unexported because their rejections carry the credential.
- **The agent's node path on a fresh machine.** `ProgramArguments[0]` is fnm's
  `aliases/default/bin/node`, which does not exist until fnm has installed a Node and set a
  default alias. Under unconditional `KeepAlive` that is a 10-second crash loop whose failures
  land in the unified log rather than in `agent.log`, because node never runs and so nothing
  writes to `StandardErrorPath`. Accepted: activation is a deliberate operator step on a
  machine that already has fnm.
