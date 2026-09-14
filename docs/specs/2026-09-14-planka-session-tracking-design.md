# planka: track Claude session work on the local Kanban board

## Goal

Keep the local Planka board current from Claude Code sessions, without the operator
moving cards by hand. A session that edits code resolves or creates the card for its
branch, mirrors its todo list into the card, records what happened when it stops, and
moves the card to Done when `bin/land` merges the PR.

The machinery lives in the public dotfiles repo. Every board-specific value — board id,
list names, custom-field ids, the credential reference — lives in the private
`work-laptop-config` overlay. Without that overlay the machinery is inert.

## Non-goals

- Card-first flow. Nothing reads a card and starts a session from it. The direction is
  session → card only.
- An MCP server. Hooks cannot call MCP tools, so an MCP server would serve only the
  conversational path while adding a server to every session start. The `grafana` server
  timed out at startup during the session that produced this spec; that cost is real.
  An MCP server remains possible later, on top of the same CLI.
- Reading the board to drive planning. Planka is a record of work, not a work queue.
- Any Planka deployment change. The instance stays as it is.

## Current state

Planka runs locally at `http://127.0.0.1:3001`, published from Docker, deployed
2026-08-05 to replace Notion. It is a 2.x build (Vite bundle, task lists, custom field
groups, `linkedCardId` on tasks).

No Planka configuration exists anywhere yet — not in the dotfiles repo, not in
`work-laptop-config`, not in the vault. This spec starts from nothing.

### API surface, read off the instance's own client bundle

There is no `/api/api-keys` route: unknown `/api/*` paths fall through to the SPA and
return `text/html`. Authentication is therefore `POST /api/access-tokens` with an email
or username and a password, returning a JWT. Personal API keys are not available on this
version.

The endpoints this design uses, all confirmed present in the bundle:

| Purpose | Endpoint |
|---|---|
| Mint a token | `POST /api/access-tokens` |
| Read a board and its lists | `GET /api/boards/:id` |
| Read a list's cards | `GET /api/lists/:id/cards` |
| Create a card | `POST /api/lists/:id/cards` |
| Move or retitle a card | `PATCH /api/cards/:id` |
| Comment | `POST /api/cards/:id/comments` |
| Create a task list on a card | `POST /api/cards/:id/task-lists` |
| Create a task | `POST /api/task-lists/:id/tasks` |
| Tick, rename, or link a task | `PATCH /api/tasks/:id` |
| Attach a custom field group | `POST /api/cards/:id/custom-field-groups` |
| Write a custom field value | `PATCH /api/cards/:id/custom-field-values/customFieldGroupId::g:customFieldId::f` |

### Token behaviour, read from the running container

The deployment is `ghcr.io/plankanban/planka:latest` as `kanban-planka-1`, with
`BASE_URL=http://localhost:3001`, alongside `kanban-postgres-1`.

- **A token is valid for 365 days.** `config/custom.js:48` computes `tokenExpiresIn` from
  `TOKEN_EXPIRES_IN`, defaulting to 365 days, and that variable is unset here. Re-minting
  is therefore an annual event, not a routine one — the keychain seeding really is
  once-and-forget, and the 401 path exists for a password change more than for expiry.
- **The token comes back in the response body.** `HTTP_ONLY_TOKEN` is unset, so Planka
  does not switch to its cookie-only mode. The CLI reads the token out of the JSON.
- **No terms gate.** `POST /api/access-tokens` can answer with an `ACCEPT_TERMS` step
  instead of a token (`constants.js`, `controllers/access-tokens/create.js:126`), but
  `TERMS_UPDATED_AT` is unset on this deployment, so it will not.
- **Card creation and moves are both recorded** as `createCard` and `moveCard` actions
  (`api/models/Action.js:71`), as are `completeTask` and `uncompleteTask`.

### Nesting

Planka 2.x nests work two ways, and this design uses both.

A card holds several named **task lists**, each holding tasks. A task carries
`isCompleted` and `assigneeUserId`; the list carries `showOnFrontOfCard`. This is
checklist depth.

A task also carries **`linkedCardId`**. Setting it promotes the task into a full card of
its own, which still appears inside the parent card's checklist. This is card depth — a
parent card with child cards.

Above the card sit Project → Board → List. Below the card, custom field groups carry
typed metadata, so branch and PR never have to be parsed back out of a description.

### Board shape

The board has six lists: **Backlog**, **On Deck**, **In Progress**, **Waiting on
Review**, **Blocked**, **Done**. The integration writes three of them. Backlog and On
Deck are the operator's queue and are never written automatically; a card only leaves
them when a session starts editing.

The design never refers to a list by name in code. It refers to named config keys, which
the overlay maps to real list ids:

| Config key | This board's list | Set by |
|---|---|---|
| `lists.active` | In Progress | First edit of a session |
| `lists.review` | Waiting on Review | PR opened |
| `lists.blocked` | Blocked | `/planka pause`, manual only |
| `lists.backlog` | Backlog | Never written automatically |
| `lists.onDeck` | On Deck | Never written automatically |
| `lists.done` | Done | `bin/land` merge |

## Architecture

### One CLI is the spine

`home/dot_local/bin/executable_planka` is the only code that speaks to the Planka API.
Hooks call it, `bin/land` calls it, the skill calls it, and the operator calls it. A
single code path means a hook and a conversational request cannot drift apart, and it
matches the repo's existing grain of small focused CLIs (`otelq`, `jsonq`, `effort`,
`spares`).

Subcommands:

| Command | Does |
|---|---|
| `planka auth` | Mint or refresh the token; print its expiry |
| `planka board show` | Print the board's lists, labels, and custom fields with their ids |
| `planka card resolve [--branch B] [--create]` | Print the card id for a branch, optionally creating it |
| `planka card show \| move \| comment \| field` | Read one card; change its list; add a comment; set a custom field |
| `planka plan sync --json -` | Reconcile the card's Plan task list against a todo list on stdin |
| `planka task promote <task-id>` | Create a card from a task and link it back |
| `planka status` | What card, list, and URL this branch maps to |
| `planka open` | Open the card in a browser |

**Absent configuration, every subcommand exits 0 and prints nothing.** This is what keeps
the public repo working on a machine with no work overlay — the same gating
`CLAUDE_VAULT_DIR` already does for the vault mounts. `--strict` turns a missing config
into a non-zero exit, for use when the operator is debugging.

### Configuration lives in the work overlay

`work-laptop-config/.config/planka/config.json`, symlinked to `~/.config/planka/config.json`
by `install.sh`. Symlinked files are live immediately — no `chezmoi apply`, unlike
`settings.work.json`, which is merged into the generated settings and does need one.

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:3001",
  "credential": { "username": "<planka login>",
                  "keychainService": "planka.password",
                  "opRef": "op://<vault>/<item>/password" },
  "boardId": "<board id>",
  "lists": { "active": "<id>", "review": "<id>", "blocked": "<id>",
             "backlog": "<id>", "onDeck": "<id>", "done": "<id>" },
  "taskLists": { "plan": "Plan" },
  "customFields": { "groupId": "<id>", "branch": "<id>", "repo": "<id>",
                    "pr": "<id>", "worktree": "<id>", "session": "<id>" },
  "repos": { "allow": ["*"] }
}
```

One board for all work. The repo goes on a custom field and a label, not on a separate
board.

### Credentials

This follows the pattern `_op_load_keys` already establishes in
`work-laptop-config/.config/zsh/local.zsh` for the Anthropic, Grafana, and Cargo
credentials: **the login keychain is the cache, and `op read` runs only on a miss.**

`planka` reads the Planka password with
`security find-generic-password -a "$USER" -s planka.password -w`. The login keychain
unlocks automatically at login, so this needs no 1Password connection, no Touch ID, and
no interactive terminal — which is what makes it safe to call from a hook. Verified from
inside the Bash-tool sandbox against an existing entry.

On a miss, `planka auth --refresh` does the `op read` against the `opRef` in the config
and writes the result into the keychain. That path needs Touch ID, so it runs by hand,
once, the same way the existing three credentials are seeded. `planka auth --forget`
clears the entry, matching `op-refresh-keys`.

The minted JWT is cached separately at `~/.cache/planka/token.json`, mode 0600, created
under an explicit `umask 077` — the login shell's `umask 0007` would otherwise leave it
group-readable. A 401 discards the token and re-mints once from the keychain password.

No secret material reaches either repository: the config holds a keychain service name
and an `op://` reference, nothing more.

### Correlation: repo + branch, stored outside the worktree

`~/.claude/planka/branch/<repo-slug>--<branch-slug>.json` holds
`{cardId, url, createdAt, lastSessionId}`.

It is keyed by repo and branch, and it lives outside the worktree, because a worktree can
be deleted while its branch survives — that happened during the session that produced
this spec, with a live session working inside the deleted directory. A `.claude/planka-card`
file inside the worktree would have died with it.

The sidecar is a cache, not the record. `planka card resolve` falls back to searching the
board for a card whose `branch` custom field matches, and rewrites the sidecar from what
it finds. Losing `~/.claude/planka/` costs one API search, not the mapping.

## Hook wiring

All wiring goes in `home/.chezmoitemplates/settings.base.json`, which generates
`~/.claude/settings.json`. Every hook calls the CLI, and every hook is inert without the
overlay config.

| Event | Matcher | Action |
|---|---|---|
| `PostToolUse` | `Edit\|Write` | First edit of the session only — resolve or create the card, move it to `lists.active`, stamp branch, repo, worktree, and session id |
| `PostToolUse` | `TodoWrite` | `planka plan sync` — mirror the todo list into the card's Plan task list |
| `Stop` | — | One session-log comment |

The claim fires on the **first real edit**, not at session start, so a session that only
reads and answers questions never touches the board.

"First edit only" is enforced by a marker file in the session directory. Without it,
every `Edit` would make an HTTP call. Each invocation is backgrounded and capped with a
short connect and total timeout: a board that is down, slow, or simply not running must
never add latency to an edit, and must never fail one.

Two call sites are edits to existing code rather than new hooks:

- `bin/land`, after a successful merge: move the card to `lists.done` and comment the PR
  URL. This is the only change to `bin/land`.
- The PR-open path: set the `pr` custom field and move the card to `lists.review`.

## Skill

`planka-tracking`, in the public repo, covers the judgement the hooks cannot make:

- When to retitle a card away from its branch slug to something a human would write.
- What belongs in the session-log comment: what changed, what was verified and with which
  command, what is next. Never a paraphrase of an error string.
- When a Plan task has grown into its own unit of work and should be promoted to a linked
  card.
- **No customer data, no PANs, no transaction detail in card titles, comments, or task
  text.** Planka is local and outside PCI scope, but the existing PAN-redaction hook
  redacts command output — it does not see what this CLI posts. This rule is the only
  control on that path.

## Reverse states and entry points

Every state the integration can put a card into has a way back and a way to see it.

| State | Way in | Way back | Way to see |
|---|---|---|---|
| Tracked | First edit | `/planka detach` drops the sidecar and stops tracking the branch | `planka status` |
| In Progress | First edit | `planka card move --list onDeck` | Statusline segment, `planka open` |
| Waiting on Review | PR opened | `planka card move --list active` | `planka status` |
| Blocked | `/planka pause`, manual only | `planka card move --list active` | Board |
| Done | `bin/land` merge | `planka card move --list active` | Board |

A session that ends without landing leaves the card in In Progress and adds a session-log
comment. Stale work is visible as a card whose last comment is old, rather than as a card
in a list nobody set. Blocked is never written automatically — a card is blocked because
the operator says so, and nothing a session can observe distinguishes blocked from
paused.

Kill switches: `PLANKA_TRACKING=0` in the environment for one session,
`"enabled": false` in the config for all of them, and removing the overlay config
entirely for a machine.

## Failure contracts

- No config, `enabled:false`, or `PLANKA_TRACKING=0` — exit 0, no output, no network.
- Planka unreachable, or any HTTP error — log to `~/.claude/planka/log`, exit 0. A
  tracking tool must never fail an edit or block a `Stop`.
- Keychain entry missing — log a line naming `planka auth --refresh`, exit 0. Never
  attempt an `op read` from a hook: it would block on Touch ID behind a session the
  operator is not looking at.
- 401 — discard the cached token, re-mint once, then give up for the session.
- A token response that carries a step rather than a token (`ACCEPT_TERMS`) — log and
  exit 0. Terms are not enabled on this deployment, but enabling them later must degrade
  to silence, not to a hook that retries a login it cannot complete.
- Card deleted from the board underneath a sidecar — `resolve` finds nothing, recreates,
  and rewrites the sidecar.

## Testing

Tests follow the repo's existing shell-test layout, one focused test per stated behaviour:

- The no-config path is silent and exits 0 — the single most important test, because it
  is what protects every machine without the overlay.
- `card resolve` prefers the sidecar, falls back to a custom-field search, and rewrites
  the sidecar after a fallback.
- The first-edit marker makes the claim fire once per session, not once per edit.
- `plan sync` is idempotent: syncing the same todo list twice leaves one task per item.
- Every HTTP failure mode exits 0.

API calls are stubbed against a fixture server. No test touches the live board.

## Rollout

Vertical slices, each exercisable by hand before the next begins.

1. `planka auth --refresh` (seed the keychain once, Touch ID), then `planka auth` and
   `planka board show`. Proves the keychain read and the token mint, and prints the real
   list and custom-field ids to fill the overlay config with. Writes nothing to the board.
2. `planka card resolve --branch` read-only, plus `planka status`. No creation.
3. `resolve --create` and `card move`, driven by hand. Then the `PostToolUse` claim, gated
   behind `PLANKA_TRACKING=1` so it is opt-in per session.
4. `plan sync` from `TodoWrite`.
5. The `Stop` comment, and `bin/land` → Done.
6. `task promote` to a linked card, and the statusline segment.

Slice 1 is the only slice whose output is configuration rather than behaviour: the board
id, the six list ids, and the custom-field ids all have to be read off the live board
before anything else can be written.

## Decisions

- **A CLI, not an MCP server.** Hooks cannot call MCP tools, so an MCP server could only
  serve the conversational half of this, while adding a startup dependency to every
  session. The community Planka MCP servers are also unvetted third-party code that would
  be handed a Planka credential.
- **Hybrid, not fully automatic.** Hooks own the deterministic facts — the card exists, it
  is active, the PR is linked, it is done. The skill owns titles, comment prose, and
  promotion decisions. Fully automatic would fill the board with branch-slug titles;
  skill-only would decay over a long session, which is the failure the voice-reminder hook
  already exists to fight.
- **Claim on first edit, not session start.** Read-only and throwaway sessions must not
  create cards.
- **Sidecar outside the worktree, board as the fallback record.** Proven necessary: a
  worktree was deleted under a live session while this spec was being written.
- **Named list keys, not discovered ids.** The board's shape lives in the overlay, so the
  public repo carries no knowledge of it.
- **Keychain first, `op read` only to seed it.** Reusing the `_op_load_keys` pattern from
  `local.zsh` rather than calling `op` at hook time. The login keychain is unlocked at
  login, so a hook reads it with no prompt and no 1Password connection; `op` needs the
  desktop app, which is unreachable from a sandboxed context. The CLI does its own
  keychain read, so nothing depends on the shell having sourced `local.zsh` — but
  `op-refresh-keys` should learn the new service name so a rotation clears it with the
  others.
- **A new card is created directly in In Progress.** The session is by definition editing
  when it creates one, and Planka records a `createCard` action naming the list, so the
  history is intact without a Backlog hop. Creating in Backlog and then moving would
  record a card as having sat in a list it never really sat in — less true, not more —
  and a failure between the two calls would strand it there.

## Open questions

None. The two that stood — the token's lifetime and where an auto-created card lands —
are settled above, the first by reading the running container and the second as a
decision.
