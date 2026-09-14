# Planka Session Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code session that edits code keeps its Planka card current — resolved or created, moved to In Progress, its checklist mirroring the todo list, commented on stop, and moved to Done when `bin/land` merges the PR.

**Architecture:** One python3 CLI, `home/dot_local/bin/executable_planka`, is the only code that speaks to the Planka API. Hooks, `bin/land`, and the operator all call it. Board-specific values live in a config file installed by the private `work-laptop-config` overlay; absent that file, every subcommand exits 0 silently, so the public repo stays inert on a machine without the overlay.

**Tech Stack:** python3 stdlib only (`urllib.request`, `json`, `subprocess`, `argparse`) — matching `executable_jsonq` and `executable_otelq`. Tests are `node --test` CommonJS files under `tests/`, driving the real script, matching `tests/jsonq.test.js`. Hooks are bash under `home/private_dot_claude/hooks/`, wired in `home/.chezmoitemplates/settings.base.json`.

**Spec:** [`docs/specs/2026-09-14-planka-session-tracking-design.md`](../specs/2026-09-14-planka-session-tracking-design.md)

## Global Constraints

- **Never fail the caller.** Every subcommand exits 0 on any expected failure — missing config, unreachable board, missing keychain entry, HTTP error, a login answering with a step. Only a usage error exits non-zero, and only when `--strict` is passed.
- **No secret ever printed, logged, or written to either repository.** The password lives in the macOS login keychain; the config holds only a service name and an `op://` reference.
- **Never run `op` from a hook.** `op read` needs the 1Password desktop app and blocks on Touch ID. Only `planka auth --refresh`, run by hand, may call it.
- **Never write customer data.** No PANs, no transaction detail, no account identifiers in card titles, comments, tasks, or custom fields.
- **Every network call is bounded.** Default timeout 5s, from `PLANKA_TIMEOUT`.
- **Portability:** this repo is linted by `bin/lint-bsd-portability`. In any shell you write, use `sed -i.bak` not bare `sed -i`, no `\b` inside `[[ =~ ]]`, and `mktemp` templates with the `X`s trailing.
- **Python is `#!/usr/bin/env python3`**, stdlib only, no third-party imports.
- **Tests skip cleanly** when `python3` is absent, the way `tests/jsonq.test.js` does. They never touch the live board.
- **chezmoi source only.** Edit under `home/`; never the deployed copy in `$HOME`.

### Config file contract (all tasks)

`$PLANKA_CONFIG`, else `~/.config/planka/config.json`:

```json
{
  "enabled": true,
  "baseUrl": "http://localhost:3001",
  "credential": {
    "username": "<planka login>",
    "keychainService": "planka.password",
    "opRef": "op://<vault>/<item>/password"
  },
  "boardId": "<board id>",
  "lists": {
    "backlog": "<id>", "onDeck": "<id>", "active": "<id>",
    "review": "<id>", "blocked": "<id>", "done": "<id>"
  },
  "taskLists": { "plan": "Plan" },
  "customFields": {
    "groupId": "<id>", "branch": "<id>", "repo": "<id>",
    "pr": "<id>", "worktree": "<id>", "session": "<id>"
  }
}
```

### Environment seams (all tasks)

| Variable | Default | Purpose |
|---|---|---|
| `PLANKA_CONFIG` | `~/.config/planka/config.json` | config path |
| `PLANKA_STATE_DIR` | `~/.claude/planka` | sidecars and log |
| `PLANKA_CACHE_DIR` | `~/.cache/planka` | token cache |
| `PLANKA_PASSWORD` | unset | bypasses the keychain; **tests only** |
| `PLANKA_TIMEOUT` | `5` | seconds per HTTP call |
| `PLANKA_TRACKING` | unset | `0` disables everything for one session |

### Verified facts this plan depends on

Read from the running container (`kanban-planka-1`, `ghcr.io/plankanban/planka:latest`) on 2026-09-14:

- `POST /api/access-tokens` with `{"emailOrUsername", "password"}` returns `{"item": "<jwt>"}` (`api/helpers/access-tokens/handle-steps.js:116`).
- Tokens last 365 days (`config/custom.js:48`, `TOKEN_EXPIRES_IN` unset).
- `GET /api/projects` lists projects and boards; `GET /api/boards/:id` returns `{item, included:{lists, cards, labels, taskLists, tasks, customFieldGroups, customFields, customFieldValues, ...}}` (`api/controllers/boards/show.js`).
- `POST /api/lists/:id/cards`, `PATCH /api/cards/:id`, `POST /api/cards/:id/comments`, `POST /api/cards/:id/task-lists`, `POST /api/task-lists/:id/tasks`, `PATCH /api/tasks/:id`, `PATCH /api/cards/:id/custom-field-values/customFieldGroupId::g:customFieldId::f` all exist (`config/routes.js`).

---

### Task 1: CLI skeleton, config gating, auth, and `board show`

The slice whose output is configuration rather than behaviour: it prints the board, list, and custom-field ids that every later task's config needs. Writes nothing to the board.

**Files:**
- Create: `home/dot_local/bin/executable_planka`
- Test: `tests/planka.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `load_config() -> dict | None`, `api(cfg, method, path, body=None, token=None) -> dict`, `token_for(cfg) -> str`, `soft_fail(msg) -> NoReturn` (logs, exits 0), and the subcommands `auth`, `auth --refresh`, `auth --forget`, `board show [--board ID]`.

- [ ] **Step 1: Write the failing test**

Create `tests/planka.test.js`:

```js
// Regression guard for home/dot_local/bin/executable_planka.
// Drives the ACTUAL script. Hermetic: config, state and cache all live in a
// temp dir, and no test reaches the real board. Skips cleanly without python3.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLANKA = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_planka');

let skip = false;
try {
  execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
} catch {
  skip = true;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planka-test-'));
}

// Run the CLI with a scratch HOME-like environment. `config` null means "no
// config file at all" — the inert case.
function run(args, { config, env = {} } = {}) {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  if (config) fs.writeFileSync(cfgPath, JSON.stringify(config));
  const res = spawnSync('python3', [PLANKA, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: path.join(dir, 'state'),
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      ...env,
    },
  });
  return { ...res, dir };
}

test('no config file: silent, exit 0', { skip }, () => {
  const r = run(['board', 'show']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

test('enabled:false: silent, exit 0', { skip }, () => {
  const r = run(['board', 'show'], { config: { enabled: false, baseUrl: 'http://127.0.0.1:1' } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('PLANKA_TRACKING=0: silent, exit 0', { skip }, () => {
  const r = run(['board', 'show'], {
    config: { enabled: true, baseUrl: 'http://127.0.0.1:1' },
    env: { PLANKA_TRACKING: '0' },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('--strict turns a missing config into a non-zero exit', { skip }, () => {
  const r = run(['--strict', 'board', 'show']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /config/i);
});

test('unreachable board: exit 0, reason in the log', { skip }, () => {
  const r = run(['board', 'show'], {
    config: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:1',
      credential: { username: 'u', keychainService: 'nope' },
    },
    env: { PLANKA_PASSWORD: 'pw', PLANKA_TIMEOUT: '1' },
  });
  assert.strictEqual(r.status, 0);
  const log = fs.readFileSync(path.join(r.dir, 'state', 'log'), 'utf8');
  assert.match(log, /board show|connect|refused|urlopen/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/planka.test.js`
Expected: FAIL — every test errors because `home/dot_local/bin/executable_planka` does not exist.

- [ ] **Step 3: Write the implementation**

Create `home/dot_local/bin/executable_planka`:

```python
#!/usr/bin/env python3
"""planka — record Claude Code session work on the local Planka board.

Every expected failure exits 0 with a line in the log. This tool sits on the
PostToolUse and Stop paths: it must never fail an edit or block a stop. Only a
usage error, and only under --strict, exits non-zero.

Secrets: the Planka password lives in the macOS login keychain. `op` is called
only by `auth --refresh`, run by hand — never from a hook, where it would block
on Touch ID behind a session nobody is watching.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_CONFIG = "~/.config/planka/config.json"
DEFAULT_STATE = "~/.claude/planka"
DEFAULT_CACHE = "~/.cache/planka"

STRICT = False


def state_dir():
    d = os.path.expanduser(os.environ.get("PLANKA_STATE_DIR") or DEFAULT_STATE)
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def cache_dir():
    d = os.path.expanduser(os.environ.get("PLANKA_CACHE_DIR") or DEFAULT_CACHE)
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def log(msg):
    try:
        with open(os.path.join(state_dir(), "log"), "a") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    except OSError:
        pass


def soft_fail(msg):
    """Log and exit 0 — or, under --strict, complain and exit 1."""
    log(msg)
    if STRICT:
        sys.stderr.write("planka: %s\n" % msg)
        sys.exit(1)
    sys.exit(0)


def load_config():
    """The config, or None when tracking is off or not configured on this machine."""
    if os.environ.get("PLANKA_TRACKING") == "0":
        return None
    path = os.path.expanduser(os.environ.get("PLANKA_CONFIG") or DEFAULT_CONFIG)
    try:
        with open(path) as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        return None
    if not cfg.get("enabled"):
        return None
    return cfg


def require_config():
    cfg = load_config()
    if cfg is None:
        if STRICT:
            sys.stderr.write("planka: no usable config\n")
            sys.exit(1)
        sys.exit(0)
    return cfg


def api(cfg, method, path, body=None, token=None):
    url = cfg["baseUrl"].rstrip("/") + "/api" + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    timeout = float(os.environ.get("PLANKA_TIMEOUT") or 5)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw or b"{}")


def read_password(cfg):
    env = os.environ.get("PLANKA_PASSWORD")
    if env:
        return env
    service = cfg.get("credential", {}).get("keychainService")
    if not service:
        return None
    proc = subprocess.run(
        ["security", "find-generic-password", "-a", os.environ.get("USER", ""),
         "-s", service, "-w"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def seed_password(cfg):
    """Interactive only: op read -> login keychain. Touch ID fires here."""
    cred = cfg.get("credential", {})
    ref = cred.get("opRef")
    service = cred.get("keychainService")
    if not ref or not service:
        soft_fail("auth --refresh: credential.opRef and credential.keychainService required")
    proc = subprocess.run(["op", "read", ref], capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        soft_fail("auth --refresh: op read failed (is the 1Password app running?)")
    # -U updates in place; local.zsh's delete-then-add dance predates it.
    add = subprocess.run(
        ["security", "add-generic-password", "-U", "-a", os.environ.get("USER", ""),
         "-s", service, "-w", proc.stdout.strip()],
        capture_output=True, text=True,
    )
    if add.returncode != 0:
        soft_fail("auth --refresh: could not write the keychain entry")
    return service


def forget_password(cfg):
    service = cfg.get("credential", {}).get("keychainService")
    if not service:
        return
    subprocess.run(
        ["security", "delete-generic-password", "-a", os.environ.get("USER", ""),
         "-s", service],
        capture_output=True, text=True,
    )


def token_path():
    return os.path.join(cache_dir(), "token.json")


def read_cached_token():
    try:
        with open(token_path()) as fh:
            return json.load(fh).get("token") or None
    except (OSError, ValueError):
        return None


def write_cached_token(token):
    path = token_path()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump({"token": token, "mintedAt": int(time.time())}, fh)
    except OSError:
        log("could not write the token cache")


def mint_token(cfg):
    password = read_password(cfg)
    if password is None:
        soft_fail("no keychain entry for the Planka password; run: planka auth --refresh")
    body = {
        "emailOrUsername": cfg.get("credential", {}).get("username", ""),
        "password": password,
    }
    try:
        resp = api(cfg, "POST", "/access-tokens", body)
    except Exception as exc:  # noqa: BLE001 - every failure is soft here
        soft_fail("mint: %s" % exc)
    token = resp.get("item")
    if not isinstance(token, str):
        # A step (ACCEPT_TERMS) rather than a token. Terms are not enabled on
        # this deployment; enabling them later must degrade to silence, not to
        # a hook retrying a login it cannot complete.
        soft_fail("login returned a step, not a token: %s" % sorted(resp))
    write_cached_token(token)
    return token


def token_for(cfg):
    return read_cached_token() or mint_token(cfg)


def call(cfg, method, path, body=None):
    """An API call that re-mints once on 401 and is soft on everything else."""
    token = token_for(cfg)
    try:
        return api(cfg, method, path, body, token)
    except urllib.error.HTTPError as exc:
        if exc.code != 401:
            soft_fail("%s %s: HTTP %s" % (method, path, exc.code))
        try:
            os.unlink(token_path())
        except OSError:
            pass
        try:
            return api(cfg, method, path, body, mint_token(cfg))
        except Exception as exc2:  # noqa: BLE001
            soft_fail("%s %s after re-mint: %s" % (method, path, exc2))
    except Exception as exc:  # noqa: BLE001
        soft_fail("%s %s: %s" % (method, path, exc))


def cmd_auth(args):
    cfg = require_config()
    if args.forget:
        forget_password(cfg)
        try:
            os.unlink(token_path())
        except OSError:
            pass
        print("forgot the keychain entry and the cached token")
        return
    if args.refresh:
        service = seed_password(cfg)
        try:
            os.unlink(token_path())
        except OSError:
            pass
        print("seeded keychain service %s" % service)
    token = token_for(cfg)
    print("token ok (%d chars)" % len(token))


def cmd_board_show(args):
    cfg = require_config()
    board_id = args.board or cfg.get("boardId")
    if not board_id:
        projects = call(cfg, "GET", "/projects")
        for board in projects.get("included", {}).get("boards", []):
            print("board\t%s\t%s" % (board.get("id"), board.get("name")))
        return
    board = call(cfg, "GET", "/boards/%s" % board_id)
    included = board.get("included", {})
    print("board\t%s\t%s" % (board.get("item", {}).get("id"), board.get("item", {}).get("name")))
    for lst in included.get("lists", []):
        print("list\t%s\t%s" % (lst.get("id"), lst.get("name")))
    for group in included.get("customFieldGroups", []):
        print("fieldGroup\t%s\t%s" % (group.get("id"), group.get("name")))
    for field in included.get("customFields", []):
        print("field\t%s\t%s" % (field.get("id"), field.get("name")))
    for label in included.get("labels", []):
        print("label\t%s\t%s" % (label.get("id"), label.get("name")))


def build_parser():
    parser = argparse.ArgumentParser(prog="planka", description=__doc__)
    parser.add_argument("--strict", action="store_true",
                        help="exit non-zero instead of going quiet")
    sub = parser.add_subparsers(dest="command", required=True)

    auth = sub.add_parser("auth", help="mint or refresh the access token")
    auth.add_argument("--refresh", action="store_true",
                      help="re-read the password from 1Password (interactive; Touch ID)")
    auth.add_argument("--forget", action="store_true",
                      help="drop the keychain entry and the cached token")
    auth.set_defaults(func=cmd_auth)

    board = sub.add_parser("board", help="board operations")
    board_sub = board.add_subparsers(dest="board_command", required=True)
    show = board_sub.add_parser("show", help="print ids for lists, fields, and labels")
    show.add_argument("--board", help="board id (default: config boardId)")
    show.set_defaults(func=cmd_board_show)

    return parser


def main(argv=None):
    global STRICT
    parser = build_parser()
    args = parser.parse_args(argv)
    STRICT = args.strict
    args.func(args)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/planka.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Lint**

Run: `bin/lint-bsd-portability && bin/lint-js`
Expected: clean. Fix anything reported before committing.

- [ ] **Step 6: Commit**

```bash
git add home/dot_local/bin/executable_planka tests/planka.test.js
git commit -m "Add the planka CLI: config gating, auth, and board show

The board has been running with nothing wired to it. This is the spine
every later hook calls, and the slice that prints the ids the work
overlay's config needs.

Inert by construction: no config, enabled:false, or PLANKA_TRACKING=0
all exit 0 in silence, so the public repo stays quiet on a machine with
no work overlay."
```

- [ ] **Step 7: Seed the credential and read the board (by hand, once)**

This is the interactive half of the slice, and it cannot be automated — Touch ID fires.

```bash
chezmoi apply ~/.local/bin/planka
```

Write a first config at `~/.config/planka/config.json` with `enabled`, `baseUrl`, and `credential` only, then:

```bash
planka --strict auth --refresh
```

```bash
planka --strict board show
```

Record the board id, the six list ids, and the custom-field ids from that output. They fill the config in Task 2.

---

### Task 2: `card resolve` (read-only) and `status`

**Files:**
- Modify: `home/dot_local/bin/executable_planka`
- Modify: `tests/planka.test.js`

**Interfaces:**
- Consumes: `load_config`, `call`, `soft_fail` from Task 1.
- Produces: `repo_slug() -> str`, `current_branch() -> str | None`, `sidecar_path(repo, branch) -> str`, `read_sidecar(repo, branch) -> dict | None`, `write_sidecar(repo, branch, data) -> None`, `find_card_by_branch(cfg, branch) -> dict | None`, and the subcommands `card resolve [--branch B]` and `status`.

- [ ] **Step 1: Write the failing test**

Append to `tests/planka.test.js`:

```js
test('card resolve prefers the sidecar and makes no network call', { skip }, () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    // Port 1 is closed: any network call fails, so a pass proves none happened.
    baseUrl: 'http://127.0.0.1:1',
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  fs.writeFileSync(
    path.join(state, 'branch', 'myrepo--feature-x.json'),
    JSON.stringify({ cardId: 'c42', url: 'http://localhost:3001/cards/c42' }),
  );
  const res = spawnSync('python3', [PLANKA, 'card', 'resolve', '--branch', 'feature-x'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: state,
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_TIMEOUT: '1',
    },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), 'c42');
});

test('card resolve without a sidecar and without --create prints nothing', { skip }, () => {
  const r = run(['card', 'resolve', '--branch', 'unknown-branch'], {
    config: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:1',
      boardId: 'b1',
      credential: { username: 'u', keychainService: 'nope' },
    },
    env: { PLANKA_REPO: 'myrepo', PLANKA_PASSWORD: 'pw', PLANKA_TIMEOUT: '1' },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('status prints the card and url from the sidecar', { skip }, () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true, baseUrl: 'http://127.0.0.1:1', boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  fs.writeFileSync(
    path.join(state, 'branch', 'myrepo--feature-x.json'),
    JSON.stringify({ cardId: 'c42', url: 'http://localhost:3001/cards/c42' }),
  );
  const res = spawnSync('python3', [PLANKA, 'status', '--branch', 'feature-x'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: state,
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_TIMEOUT: '1',
    },
  });
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /c42/);
  assert.match(res.stdout, /feature-x/);
});

test('a branch slug with slashes maps to one flat sidecar filename', { skip }, () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true, baseUrl: 'http://127.0.0.1:1', boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  fs.writeFileSync(
    path.join(state, 'branch', 'myrepo--claude-planka-work.json'),
    JSON.stringify({ cardId: 'c99', url: 'http://localhost:3001/cards/c99' }),
  );
  const res = spawnSync('python3', [PLANKA, 'card', 'resolve', '--branch', 'claude/planka-work'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: state,
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_TIMEOUT: '1',
    },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), 'c99');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/planka.test.js`
Expected: the four new tests FAIL — `argparse` rejects the `card` and `status` subcommands.

- [ ] **Step 3: Write the implementation**

Add to `home/dot_local/bin/executable_planka`, above `build_parser`:

```python
def slugify(value):
    """One flat filename per repo+branch. Slashes in branch names are the reason."""
    out = []
    for ch in value:
        out.append(ch if (ch.isalnum() or ch in "-_.") else "-")
    return "".join(out).strip("-") or "unknown"


def repo_slug():
    env = os.environ.get("PLANKA_REPO")
    if env:
        return slugify(env)
    proc = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return "unknown"
    return slugify(os.path.basename(proc.stdout.strip()))


def current_branch():
    proc = subprocess.run(["git", "branch", "--show-current"],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


def sidecar_path(repo, branch):
    d = os.path.join(state_dir(), "branch")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return os.path.join(d, "%s--%s.json" % (repo, slugify(branch)))


def read_sidecar(repo, branch):
    try:
        with open(sidecar_path(repo, branch)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_sidecar(repo, branch, data):
    try:
        with open(sidecar_path(repo, branch), "w") as fh:
            json.dump(data, fh)
    except OSError:
        log("could not write the sidecar for %s/%s" % (repo, branch))


def card_url(cfg, card_id):
    return "%s/cards/%s" % (cfg["baseUrl"].rstrip("/"), card_id)


def find_card_by_branch(cfg, branch):
    """The sidecar is a cache; the board is the record. One GET returns the whole
    board, including every custom field value, so this is a single call."""
    field_id = cfg.get("customFields", {}).get("branch")
    board_id = cfg.get("boardId")
    if not field_id or not board_id:
        return None
    board = call(cfg, "GET", "/boards/%s" % board_id)
    for value in board.get("included", {}).get("customFieldValues", []):
        if value.get("customFieldId") == field_id and value.get("content") == branch:
            return {"id": value.get("cardId")}
    return None


def resolve_branch(args):
    return args.branch or current_branch()


def cmd_card_resolve(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("card resolve: no branch")
    repo = repo_slug()
    side = read_sidecar(repo, branch)
    if side and side.get("cardId"):
        print(side["cardId"])
        return
    found = find_card_by_branch(cfg, branch)
    if found and found.get("id"):
        write_sidecar(repo, branch, {"cardId": found["id"], "url": card_url(cfg, found["id"])})
        print(found["id"])
        return
    log("card resolve: no card for %s/%s" % (repo, branch))


def cmd_status(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("status: no branch")
    repo = repo_slug()
    side = read_sidecar(repo, branch)
    if not side:
        print("%s/%s: not tracked" % (repo, branch))
        return
    print("%s/%s\tcard %s\t%s" % (repo, branch, side.get("cardId"), side.get("url")))
```

Add to `build_parser`, before `return parser`:

```python
    card = sub.add_parser("card", help="card operations")
    card_sub = card.add_subparsers(dest="card_command", required=True)
    resolve = card_sub.add_parser("resolve", help="print the card id for a branch")
    resolve.add_argument("--branch", help="branch name (default: the current branch)")
    resolve.set_defaults(func=cmd_card_resolve)

    status = sub.add_parser("status", help="what card this branch maps to")
    status.add_argument("--branch", help="branch name (default: the current branch)")
    status.set_defaults(func=cmd_status)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/planka.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add home/dot_local/bin/executable_planka tests/planka.test.js
git commit -m "Resolve a branch to its Planka card, read-only

Keyed by repo and branch, and stored outside the worktree: a worktree
can be deleted while its branch survives, which happened to a live
session while this was being designed.

The sidecar is a cache, not the record. When it is missing, one GET of
the board finds the card by its branch custom field and rewrites it."
```

---

### Task 3: `card create`, `card move`, `card field`, and the first-edit claim hook

**Files:**
- Modify: `home/dot_local/bin/executable_planka`
- Modify: `tests/planka.test.js`
- Create: `home/private_dot_claude/hooks/executable_planka-claim.sh`
- Create: `tests/hooks/planka-claim.test.js`
- Modify: `home/.chezmoitemplates/settings.base.json` (the `PostToolUse` `Edit|Write|NotebookEdit` block, after `chezmoi-guard.sh`)

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `set_field(cfg, card_id, field_key, value) -> None`, `create_card(cfg, branch, title) -> str`, and the subcommands `card resolve --create [--title T]`, `card move --list KEY [--branch B]`, `card field --set k=v [--branch B]`.

- [ ] **Step 1: Write the failing test for the claim hook**

Create `tests/hooks/planka-claim.test.js`:

```js
// The claim hook fires on every Edit/Write. What matters is that it calls the
// CLI exactly once per session and never lets a failure reach the caller.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(
  __dirname, '..', '..', 'home', 'private_dot_claude', 'hooks',
  'executable_planka-claim.sh',
);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planka-claim-'));
}

// A stub `planka` on PATH that appends one line per invocation.
function stubBin(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(dir, 'calls');
  fs.writeFileSync(
    path.join(bin, 'planka'),
    `#!/bin/sh\necho "$@" >> ${calls}\nexit 0\n`,
    { mode: 0o755 },
  );
  return { bin, calls };
}

function fire(dir, { bin, sessionId = 'sess-1', env = {} }) {
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'some-file.txt') },
    }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PLANKA_STATE_DIR: path.join(dir, 'state'),
      ...env,
    },
  });
}

test('claims once per session, not once per edit', () => {
  const dir = tmpdir();
  const { bin, calls } = stubBin(dir);
  for (let i = 0; i < 3; i += 1) {
    const r = fire(dir, { bin });
    assert.strictEqual(r.status, 0);
  }
  const lines = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  assert.strictEqual(lines.length, 1, `expected one claim, got ${lines.length}`);
  assert.match(lines[0], /card resolve --create/);
});

test('a different session claims again', () => {
  const dir = tmpdir();
  const { bin, calls } = stubBin(dir);
  fire(dir, { bin, sessionId: 'sess-1' });
  fire(dir, { bin, sessionId: 'sess-2' });
  const lines = fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);
});

test('PLANKA_TRACKING=0 claims nothing', () => {
  const dir = tmpdir();
  const { bin, calls } = stubBin(dir);
  const r = fire(dir, { bin, env: { PLANKA_TRACKING: '0' } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(calls), false);
});

test('a CLI that fails does not fail the hook', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'planka'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const r = fire(dir, { bin });
  assert.strictEqual(r.status, 0);
});

test('no planka on PATH does not fail the hook', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const r = fire(dir, { bin, env: { PATH: bin } });
  assert.strictEqual(r.status, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/hooks/planka-claim.test.js`
Expected: FAIL — the hook script does not exist.

- [ ] **Step 3: Write the claim hook**

Create `home/private_dot_claude/hooks/executable_planka-claim.sh`:

```bash
#!/usr/bin/env bash
# PostToolUse on Edit|Write|NotebookEdit: the first real edit of a session claims
# the branch's Planka card — resolve or create it, move it to In Progress, and
# stamp the session's identifiers on it.
#
# First edit only. Without the marker this would make an HTTP call per edit. The
# marker also encodes the policy the spec chose: a session that only reads and
# answers questions never touches the board, because it never gets here.
#
# Everything is backgrounded and every path exits 0. A board that is down, slow,
# or simply not running must never add latency to an edit, and must never fail one.

set -uo pipefail

[ "${PLANKA_TRACKING:-}" = "0" ] && exit 0
command -v planka >/dev/null 2>&1 || exit 0

# shellcheck source=./hook-input.sh
. "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"
hook_read_input
SESSION_ID="$(hook_field '.session_id')"
[ -n "$SESSION_ID" ] || exit 0

STATE_DIR="${PLANKA_STATE_DIR:-$HOME/.claude/planka}"
MARKER_DIR="$STATE_DIR/claimed"
mkdir -p "$MARKER_DIR" 2>/dev/null || exit 0
MARKER="$MARKER_DIR/$SESSION_ID"

# noclobber makes "create the marker" the atomic claim, so two edits racing in
# the same session still produce exactly one claim.
if ! (set -o noclobber; : > "$MARKER") 2>/dev/null; then
  exit 0
fi

planka card resolve --create >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
```

- [ ] **Step 4: Run the hook tests to verify they pass**

Run: `node --test tests/hooks/planka-claim.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing CLI test for create, move, and field**

Append to `tests/planka.test.js`:

```js
// A fake Planka: records every request and answers the handful of routes the
// CLI uses. Keeps these tests hermetic and off the live board.
function fakePlanka(handlers = {}) {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      const key = `${req.method} ${req.url}`;
      const handler = handlers[key];
      const payload = handler ? handler(body) : { item: {} };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  return { server, seen, port: () => server.address().port };
}

test('card resolve --create creates in the active list and stamps the branch', { skip }, async () => {
  const fake = fakePlanka({
    'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
    'GET /api/boards/b1': () => ({ item: { id: 'b1' }, included: { customFieldValues: [] } }),
    'POST /api/lists/list-active/cards': () => ({ item: { id: 'new-card' } }),
  });
  await new Promise((r) => fake.server.once('listening', r));
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    baseUrl: `http://127.0.0.1:${fake.port()}`,
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
    lists: { active: 'list-active', done: 'list-done' },
    customFields: { groupId: 'g1', branch: 'f-branch', repo: 'f-repo' },
  }));
  const res = spawnSync('python3', [PLANKA, 'card', 'resolve', '--create', '--branch', 'feature-y'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: path.join(dir, 'state'),
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_PASSWORD: 'pw',
    },
  });
  fake.server.close();
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), 'new-card');

  const created = fake.seen.find((r) => r.url === '/api/lists/list-active/cards');
  assert.ok(created, 'card was created in the active list, not the backlog');

  const stamped = fake.seen.filter((r) => r.url.startsWith('/api/cards/new-card/custom-field-values/'));
  assert.ok(stamped.some((r) => r.body && r.body.content === 'feature-y'),
    'the branch is stamped on the card');

  const sidecar = JSON.parse(fs.readFileSync(
    path.join(dir, 'state', 'branch', 'myrepo--feature-y.json'), 'utf8',
  ));
  assert.strictEqual(sidecar.cardId, 'new-card');
});

test('card move sends the configured list id, not its name', { skip }, async () => {
  const fake = fakePlanka({
    'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
    'PATCH /api/cards/c42': () => ({ item: { id: 'c42' } }),
  });
  await new Promise((r) => fake.server.once('listening', r));
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    baseUrl: `http://127.0.0.1:${fake.port()}`,
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
    lists: { active: 'list-active', done: 'list-done' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  fs.writeFileSync(path.join(state, 'branch', 'myrepo--feature-y.json'),
    JSON.stringify({ cardId: 'c42' }));
  const res = spawnSync('python3', [PLANKA, 'card', 'move', '--list', 'done', '--branch', 'feature-y'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: state,
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_PASSWORD: 'pw',
    },
  });
  fake.server.close();
  assert.strictEqual(res.status, 0);
  const patch = fake.seen.find((r) => r.method === 'PATCH' && r.url === '/api/cards/c42');
  assert.strictEqual(patch.body.listId, 'list-done');
});

test('card move with an unknown list key is silent and exits 0', { skip }, () => {
  const r = run(['card', 'move', '--list', 'nonesuch', '--branch', 'feature-y'], {
    config: {
      enabled: true, baseUrl: 'http://127.0.0.1:1', boardId: 'b1',
      credential: { username: 'u', keychainService: 'nope' },
      lists: { active: 'list-active' },
    },
    env: { PLANKA_REPO: 'myrepo', PLANKA_PASSWORD: 'pw', PLANKA_TIMEOUT: '1' },
  });
  assert.strictEqual(r.status, 0);
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `node --test tests/planka.test.js`
Expected: the three new tests FAIL — `--create`, `card move`, and `card field` do not exist.

- [ ] **Step 7: Write the implementation**

Add to `home/dot_local/bin/executable_planka`, above `build_parser`:

```python
def set_field(cfg, card_id, field_key, value):
    fields = cfg.get("customFields", {})
    group_id = fields.get("groupId")
    field_id = fields.get(field_key)
    if not group_id or not field_id:
        return
    path = "/cards/%s/custom-field-values/customFieldGroupId:%s:customFieldId:%s" % (
        card_id, group_id, field_id,
    )
    call(cfg, "PATCH", path, {"content": value})


def create_card(cfg, branch, title=None):
    """Created directly in the active list: the session is editing by definition,
    and Planka records a createCard action naming the list, so a Backlog hop adds
    no history — only a window where a failed move strands the card there."""
    list_id = cfg.get("lists", {}).get("active")
    if not list_id:
        soft_fail("create: lists.active is not configured")
    card = call(cfg, "POST", "/lists/%s/cards" % list_id,
                {"name": title or branch, "position": 65536})
    card_id = card.get("item", {}).get("id")
    if not card_id:
        soft_fail("create: no card id in the response")
    set_field(cfg, card_id, "branch", branch)
    set_field(cfg, card_id, "repo", repo_slug())
    session = os.environ.get("CLAUDE_SESSION_ID")
    if session:
        set_field(cfg, card_id, "session", session)
    worktree = os.getcwd()
    set_field(cfg, card_id, "worktree", worktree)
    return card_id


def cmd_card_move(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("card move: no branch")
    list_id = cfg.get("lists", {}).get(args.list)
    if not list_id:
        soft_fail("card move: no list configured for key %r" % args.list)
    side = read_sidecar(repo_slug(), branch)
    if not side or not side.get("cardId"):
        soft_fail("card move: %s is not tracked" % branch)
    call(cfg, "PATCH", "/cards/%s" % side["cardId"], {"listId": list_id})


def cmd_card_field(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("card field: no branch")
    side = read_sidecar(repo_slug(), branch)
    if not side or not side.get("cardId"):
        soft_fail("card field: %s is not tracked" % branch)
    for pair in args.set:
        key, _, value = pair.partition("=")
        if not key or not _:
            soft_fail("card field: expected key=value, got %r" % pair)
        set_field(cfg, side["cardId"], key, value)
```

Replace `cmd_card_resolve` with:

```python
def cmd_card_resolve(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("card resolve: no branch")
    repo = repo_slug()
    side = read_sidecar(repo, branch)
    if side and side.get("cardId"):
        print(side["cardId"])
        return
    found = find_card_by_branch(cfg, branch)
    if found and found.get("id"):
        write_sidecar(repo, branch, {"cardId": found["id"], "url": card_url(cfg, found["id"])})
        print(found["id"])
        return
    if not getattr(args, "create", False):
        log("card resolve: no card for %s/%s" % (repo, branch))
        return
    card_id = create_card(cfg, branch, getattr(args, "title", None))
    write_sidecar(repo, branch, {"cardId": card_id, "url": card_url(cfg, card_id)})
    print(card_id)
```

Extend `build_parser`'s card block:

```python
    resolve.add_argument("--create", action="store_true",
                         help="create the card in the active list when none exists")
    resolve.add_argument("--title", help="card title (default: the branch name)")

    move = card_sub.add_parser("move", help="move the card to a configured list")
    move.add_argument("--list", required=True,
                      help="a key from config lists: backlog, onDeck, active, review, blocked, done")
    move.add_argument("--branch")
    move.set_defaults(func=cmd_card_move)

    field = card_sub.add_parser("field", help="set custom field values")
    field.add_argument("--set", action="append", required=True, metavar="KEY=VALUE")
    field.add_argument("--branch")
    field.set_defaults(func=cmd_card_field)
```

- [ ] **Step 8: Run all tests to verify they pass**

Run: `node --test tests/planka.test.js tests/hooks/planka-claim.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 9: Wire the hook, opt-in**

In `home/.chezmoitemplates/settings.base.json`, inside the `PostToolUse` entry whose matcher is `Edit|Write|NotebookEdit`, after the `chezmoi-guard.sh` hook object, add:

```json
          {
            "type": "command",
            "command": "~/.claude/hooks/planka-claim.sh",
            "timeout": 10
          },
```

Then:

```bash
chezmoi apply ~/.claude/settings.json
```

The hook is opt-in for now because the config's `enabled` stays `false` until Task 6 — every path is inert until you flip it.

- [ ] **Step 10: Commit**

```bash
git add home/dot_local/bin/executable_planka tests/planka.test.js \
        home/private_dot_claude/hooks/executable_planka-claim.sh \
        tests/hooks/planka-claim.test.js \
        home/.chezmoitemplates/settings.base.json
git commit -m "Claim the branch's card on a session's first edit

Cards are created straight into In Progress: the session is editing by
definition, Planka logs a createCard action naming the list, and a
Backlog hop would only add a window where a failed move strands the card
somewhere it never belonged.

The marker file is the claim, created with noclobber so two edits racing
in one session still produce exactly one call. Without it every Edit
would make an HTTP call."
```

---

### Task 4: Mirror the todo list into the card's Plan task list

**Files:**
- Modify: `home/dot_local/bin/executable_planka`
- Modify: `tests/planka.test.js`
- Create: `home/private_dot_claude/hooks/executable_planka-plan.sh`
- Create: `tests/hooks/planka-plan.test.js`
- Modify: `home/.chezmoitemplates/settings.base.json` (a new `PostToolUse` entry, matcher `TodoWrite`)

**Interfaces:**
- Consumes: `call`, `read_sidecar`, `repo_slug`, `resolve_branch`, `soft_fail`.
- Produces: `ensure_task_list(cfg, card_id) -> str`, and the subcommand `plan sync [--branch B]`, which reads a Claude `TodoWrite` payload on stdin.

- [ ] **Step 1: Write the failing test**

Append to `tests/planka.test.js`:

```js
test('plan sync is idempotent: syncing twice leaves one task per item', { skip }, async () => {
  let tasks = [];
  let taskLists = [];
  const fake = fakePlanka({
    'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
    'GET /api/cards/c42': () => ({
      item: { id: 'c42' },
      included: { taskLists, tasks },
    }),
    'POST /api/cards/c42/task-lists': () => {
      taskLists = [{ id: 'tl1', cardId: 'c42', name: 'Plan' }];
      return { item: taskLists[0] };
    },
  });
  // Task creation appends; the fake records the name so the second sync can see it.
  fake.server.on('request', () => {});
  await new Promise((r) => fake.server.once('listening', r));

  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    baseUrl: `http://127.0.0.1:${fake.port()}`,
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
    lists: { active: 'list-active' },
    taskLists: { plan: 'Plan' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  fs.writeFileSync(path.join(state, 'branch', 'myrepo--feature-y.json'),
    JSON.stringify({ cardId: 'c42' }));

  const payload = JSON.stringify({
    tool_input: {
      todos: [
        { content: 'Write the failing test', status: 'completed' },
        { content: 'Implement it', status: 'in_progress' },
      ],
    },
  });

  const env = {
    ...process.env,
    PLANKA_CONFIG: cfgPath,
    PLANKA_STATE_DIR: state,
    PLANKA_CACHE_DIR: path.join(dir, 'cache'),
    PLANKA_REPO: 'myrepo',
    PLANKA_PASSWORD: 'pw',
  };

  const first = spawnSync('python3', [PLANKA, 'plan', 'sync', '--branch', 'feature-y'],
    { encoding: 'utf8', input: payload, env });
  assert.strictEqual(first.status, 0);

  // Reflect the tasks the first run created, so the second run sees them.
  tasks = fake.seen
    .filter((r) => r.url === '/api/task-lists/tl1/tasks')
    .map((r, i) => ({ id: `t${i}`, taskListId: 'tl1', name: r.body.name, isCompleted: false }));
  const createdFirst = tasks.length;
  assert.strictEqual(createdFirst, 2);

  const second = spawnSync('python3', [PLANKA, 'plan', 'sync', '--branch', 'feature-y'],
    { encoding: 'utf8', input: payload, env });
  fake.server.close();
  assert.strictEqual(second.status, 0);

  const createdTotal = fake.seen.filter((r) => r.url === '/api/task-lists/tl1/tasks').length;
  assert.strictEqual(createdTotal, createdFirst,
    'the second sync created no duplicate tasks');
});

test('plan sync ticks a task whose todo is completed', { skip }, async () => {
  const taskLists = [{ id: 'tl1', cardId: 'c42', name: 'Plan' }];
  const tasks = [{ id: 't0', taskListId: 'tl1', name: 'Write the failing test', isCompleted: false }];
  const fake = fakePlanka({
    'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
    'GET /api/cards/c42': () => ({ item: { id: 'c42' }, included: { taskLists, tasks } }),
    'PATCH /api/tasks/t0': () => ({ item: { id: 't0', isCompleted: true } }),
  });
  await new Promise((r) => fake.server.once('listening', r));
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    baseUrl: `http://127.0.0.1:${fake.port()}`,
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
    taskLists: { plan: 'Plan' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  fs.writeFileSync(path.join(state, 'branch', 'myrepo--feature-y.json'),
    JSON.stringify({ cardId: 'c42' }));
  const res = spawnSync('python3', [PLANKA, 'plan', 'sync', '--branch', 'feature-y'], {
    encoding: 'utf8',
    input: JSON.stringify({
      tool_input: { todos: [{ content: 'Write the failing test', status: 'completed' }] },
    }),
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: state,
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_PASSWORD: 'pw',
    },
  });
  fake.server.close();
  assert.strictEqual(res.status, 0);
  const patch = fake.seen.find((r) => r.method === 'PATCH' && r.url === '/api/tasks/t0');
  assert.ok(patch, 'the completed todo ticked its task');
  assert.strictEqual(patch.body.isCompleted, true);
});

test('plan sync on an untracked branch is silent and exits 0', { skip }, () => {
  const r = run(['plan', 'sync', '--branch', 'untracked'], {
    config: {
      enabled: true, baseUrl: 'http://127.0.0.1:1', boardId: 'b1',
      credential: { username: 'u', keychainService: 'nope' },
      taskLists: { plan: 'Plan' },
    },
    env: { PLANKA_REPO: 'myrepo', PLANKA_PASSWORD: 'pw', PLANKA_TIMEOUT: '1' },
  });
  assert.strictEqual(r.status, 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/planka.test.js`
Expected: the three new tests FAIL — `plan sync` does not exist.

- [ ] **Step 3: Write the implementation**

Add to `home/dot_local/bin/executable_planka`, above `build_parser`:

```python
def ensure_task_list(cfg, card_id):
    """The card's Plan task list, created on first use. Matching by name rather
    than by a stored id keeps this recoverable when the sidecar is lost."""
    name = cfg.get("taskLists", {}).get("plan", "Plan")
    card = call(cfg, "GET", "/cards/%s" % card_id)
    for task_list in card.get("included", {}).get("taskLists", []):
        if task_list.get("name") == name:
            return task_list.get("id")
    created = call(cfg, "POST", "/cards/%s/task-lists" % card_id,
                   {"name": name, "position": 65536})
    return created.get("item", {}).get("id")


def cmd_plan_sync(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("plan sync: no branch")
    side = read_sidecar(repo_slug(), branch)
    if not side or not side.get("cardId"):
        log("plan sync: %s is not tracked" % branch)
        return
    card_id = side["cardId"]

    try:
        payload = json.load(sys.stdin)
    except ValueError:
        soft_fail("plan sync: stdin is not JSON")
    todos = payload.get("tool_input", {}).get("todos") or payload.get("todos") or []
    if not todos:
        return

    task_list_id = ensure_task_list(cfg, card_id)
    if not task_list_id:
        soft_fail("plan sync: no task list")

    card = call(cfg, "GET", "/cards/%s" % card_id)
    existing = {}
    for task in card.get("included", {}).get("tasks", []):
        if task.get("taskListId") == task_list_id:
            existing[task.get("name")] = task

    position = 65536
    for todo in todos:
        content = (todo.get("content") or "").strip()
        if not content:
            continue
        done = todo.get("status") == "completed"
        task = existing.get(content)
        if task is None:
            call(cfg, "POST", "/task-lists/%s/tasks" % task_list_id,
                 {"name": content, "position": position})
            position += 65536
            continue
        if bool(task.get("isCompleted")) != done:
            call(cfg, "PATCH", "/tasks/%s" % task.get("id"), {"isCompleted": done})
```

Add to `build_parser`:

```python
    plan = sub.add_parser("plan", help="plan operations")
    plan_sub = plan.add_subparsers(dest="plan_command", required=True)
    sync = plan_sub.add_parser("sync", help="mirror a TodoWrite payload on stdin into the card")
    sync.add_argument("--branch")
    sync.set_defaults(func=cmd_plan_sync)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/planka.test.js`
Expected: PASS, 20 tests.

- [ ] **Step 5: Write the plan hook and its test**

Create `home/private_dot_claude/hooks/executable_planka-plan.sh`:

```bash
#!/usr/bin/env bash
# PostToolUse on TodoWrite: mirror the session's todo list into the card's Plan
# task list. The CLI reads the hook payload on stdin and does the reconciling.
#
# Backgrounded and always exit 0, for the same reason as planka-claim.sh: a board
# that is down must not slow down or fail the tool call that triggered this.

set -uo pipefail

[ "${PLANKA_TRACKING:-}" = "0" ] && exit 0
command -v planka >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
printf '%s' "$INPUT" | planka plan sync >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
```

Create `tests/hooks/planka-plan.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(
  __dirname, '..', '..', 'home', 'private_dot_claude', 'hooks',
  'executable_planka-plan.sh',
);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'planka-plan-'));
}

test('forwards the payload to the CLI on stdin and exits 0', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const captured = path.join(dir, 'captured');
  fs.writeFileSync(
    path.join(bin, 'planka'),
    `#!/bin/sh\ncat > ${captured}\nexit 0\n`,
    { mode: 0o755 },
  );
  const payload = JSON.stringify({ tool_input: { todos: [{ content: 'A', status: 'pending' }] } });
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: payload,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.strictEqual(r.status, 0);
  // The hook backgrounds the CLI; give it a moment to land.
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(captured) && Date.now() < deadline) { /* spin */ }
  assert.strictEqual(fs.existsSync(captured), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(captured, 'utf8')), JSON.parse(payload));
});

test('PLANKA_TRACKING=0 forwards nothing', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const captured = path.join(dir, 'captured');
  fs.writeFileSync(path.join(bin, 'planka'), `#!/bin/sh\ncat > ${captured}\n`, { mode: 0o755 });
  const r = spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLANKA_TRACKING: '0' },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(captured), false);
});
```

- [ ] **Step 6: Run the hook tests**

Run: `node --test tests/hooks/planka-plan.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 7: Wire it**

In `home/.chezmoitemplates/settings.base.json`, add a new object to the `PostToolUse` array:

```json
      {
        "matcher": "TodoWrite",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/planka-plan.sh",
            "timeout": 10
          }
        ]
      },
```

Then `chezmoi apply ~/.claude/settings.json`.

- [ ] **Step 8: Commit**

```bash
git add home/dot_local/bin/executable_planka tests/planka.test.js \
        home/private_dot_claude/hooks/executable_planka-plan.sh \
        tests/hooks/planka-plan.test.js \
        home/.chezmoitemplates/settings.base.json
git commit -m "Mirror the session's todo list into the card's Plan task list

Reconciles by task name rather than by stored ids, so a lost sidecar
costs a lookup and not a duplicated checklist. Syncing the same todo
list twice leaves one task per item, which is the test that matters —
TodoWrite fires often."
```

---

### Task 5: The session-log comment on Stop, and `bin/land` → Done

**Files:**
- Modify: `home/dot_local/bin/executable_planka`
- Modify: `tests/planka.test.js`
- Create: `home/private_dot_claude/hooks/executable_planka-stop.sh`
- Create: `tests/hooks/planka-stop.test.js`
- Modify: `home/.chezmoitemplates/settings.base.json` (the `Stop` array)
- Modify: `bin/land:178` — immediately after the `printf 'landed %s (PR #%s)\n'` line

**Interfaces:**
- Consumes: `call`, `read_sidecar`, `repo_slug`, `resolve_branch`.
- Produces: the subcommand `card comment [--branch B] [--text T]` (reads stdin when `--text` is absent).

- [ ] **Step 1: Write the failing test**

Append to `tests/planka.test.js`:

```js
test('card comment posts the text to the card', { skip }, async () => {
  const fake = fakePlanka({
    'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
    'POST /api/cards/c42/comments': () => ({ item: { id: 'cm1' } }),
  });
  await new Promise((r) => fake.server.once('listening', r));
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    baseUrl: `http://127.0.0.1:${fake.port()}`,
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  fs.writeFileSync(path.join(state, 'branch', 'myrepo--feature-y.json'),
    JSON.stringify({ cardId: 'c42' }));
  const res = spawnSync('python3',
    [PLANKA, 'card', 'comment', '--branch', 'feature-y', '--text', 'landed as abc1234'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PLANKA_CONFIG: cfgPath,
        PLANKA_STATE_DIR: state,
        PLANKA_CACHE_DIR: path.join(dir, 'cache'),
        PLANKA_REPO: 'myrepo',
        PLANKA_PASSWORD: 'pw',
      },
    });
  fake.server.close();
  assert.strictEqual(res.status, 0);
  const posted = fake.seen.find((r) => r.url === '/api/cards/c42/comments');
  assert.strictEqual(posted.body.text, 'landed as abc1234');
});

test('card comment with empty text posts nothing', { skip }, () => {
  const r = run(['card', 'comment', '--branch', 'feature-y', '--text', '   '], {
    config: {
      enabled: true, baseUrl: 'http://127.0.0.1:1', boardId: 'b1',
      credential: { username: 'u', keychainService: 'nope' },
    },
    env: { PLANKA_REPO: 'myrepo', PLANKA_PASSWORD: 'pw', PLANKA_TIMEOUT: '1' },
  });
  assert.strictEqual(r.status, 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/planka.test.js`
Expected: the two new tests FAIL — `card comment` does not exist.

- [ ] **Step 3: Write the implementation**

Add to `home/dot_local/bin/executable_planka`, above `build_parser`:

```python
def cmd_card_comment(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("card comment: no branch")
    side = read_sidecar(repo_slug(), branch)
    if not side or not side.get("cardId"):
        log("card comment: %s is not tracked" % branch)
        return
    text = args.text if args.text is not None else sys.stdin.read()
    text = (text or "").strip()
    if not text:
        return
    call(cfg, "POST", "/cards/%s/comments" % side["cardId"], {"text": text})
```

Add to `build_parser`'s card block:

```python
    comment = card_sub.add_parser("comment", help="add a comment to the card")
    comment.add_argument("--text", help="comment body (default: read stdin)")
    comment.add_argument("--branch")
    comment.set_defaults(func=cmd_card_comment)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/planka.test.js`
Expected: PASS, 22 tests.

- [ ] **Step 5: Write the Stop hook and its test**

Create `home/private_dot_claude/hooks/executable_planka-stop.sh`:

```bash
#!/usr/bin/env bash
# Stop: one session-log comment on the branch's card.
#
# The card stays in In Progress. A session that ends without landing has not
# stopped being in progress, and Blocked is never written automatically — a card
# is blocked because the operator says so, and nothing observable here
# distinguishes blocked from paused. Stale work shows as a card whose last
# comment is old.
#
# Only comments when this session actually claimed a card: the claim marker is
# the evidence that this session edited something.

set -uo pipefail

[ "${PLANKA_TRACKING:-}" = "0" ] && exit 0
command -v planka >/dev/null 2>&1 || exit 0

# shellcheck source=./hook-input.sh
. "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"
hook_read_input
SESSION_ID="$(hook_field '.session_id')"
[ -n "$SESSION_ID" ] || exit 0

STATE_DIR="${PLANKA_STATE_DIR:-$HOME/.claude/planka}"
[ -f "$STATE_DIR/claimed/$SESSION_ID" ] || exit 0

# A prose summary is the skill's job, written to this file during the session.
# Absent one, fall back to something true and cheap rather than inventing detail.
SUMMARY_FILE="$STATE_DIR/summary/$SESSION_ID"
if [ -s "$SUMMARY_FILE" ]; then
  TEXT="$(cat "$SUMMARY_FILE")"
else
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
  TEXT="Session paused on ${BRANCH:-an unknown branch} at ${HEAD_SHA:-an unknown commit}."
fi

printf '%s' "$TEXT" | planka card comment >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
```

Create `tests/hooks/planka-stop.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(
  __dirname, '..', '..', 'home', 'private_dot_claude', 'hooks',
  'executable_planka-stop.sh',
);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planka-stop-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const captured = path.join(dir, 'captured');
  fs.writeFileSync(path.join(bin, 'planka'), `#!/bin/sh\ncat > ${captured}\nexit 0\n`,
    { mode: 0o755 });
  return { dir, bin, captured, state: path.join(dir, 'state') };
}

function fire({ bin, state, sessionId = 'sess-1' }) {
  return spawnSync('bash', [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId }),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLANKA_STATE_DIR: state },
  });
}

function waitFor(file) {
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(file) && Date.now() < deadline) { /* spin */ }
  return fs.existsSync(file);
}

test('a session that never claimed a card comments nothing', () => {
  const { bin, state, captured } = setup();
  const r = fire({ bin, state });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.existsSync(captured), false);
});

test('a claimed session posts its summary file', () => {
  const { bin, state, captured } = setup();
  fs.mkdirSync(path.join(state, 'claimed'), { recursive: true });
  fs.writeFileSync(path.join(state, 'claimed', 'sess-1'), '');
  fs.mkdirSync(path.join(state, 'summary'), { recursive: true });
  fs.writeFileSync(path.join(state, 'summary', 'sess-1'), 'Reconciled the ledger writer.');
  const r = fire({ bin, state });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(waitFor(captured), true);
  assert.match(fs.readFileSync(captured, 'utf8'), /Reconciled the ledger writer\./);
});

test('a claimed session with no summary still says something true', () => {
  const { bin, state, captured } = setup();
  fs.mkdirSync(path.join(state, 'claimed'), { recursive: true });
  fs.writeFileSync(path.join(state, 'claimed', 'sess-1'), '');
  const r = fire({ bin, state });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(waitFor(captured), true);
  assert.match(fs.readFileSync(captured, 'utf8'), /paused/i);
});
```

- [ ] **Step 6: Run the hook tests**

Run: `node --test tests/hooks/planka-stop.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 7: Wire the Stop hook**

In `home/.chezmoitemplates/settings.base.json`, add to the `Stop` array's `hooks` list:

```json
          {
            "type": "command",
            "command": "~/.claude/hooks/planka-stop.sh",
            "timeout": 10
          },
```

Then `chezmoi apply ~/.claude/settings.json`.

- [ ] **Step 8: Teach `bin/land` to finish the card**

In `bin/land`, immediately after this line:

```sh
  printf 'landed %s (PR #%s)\n' "$BRANCH" "$PR"
```

insert:

```sh
  # Done is the one transition the operator never has to make by hand: a merged
  # PR is the unambiguous end of the unit of work this card tracks. Soft in every
  # direction — planka exits 0 when it is not configured, and a landing must not
  # report failure because a Kanban board was unreachable.
  if command -v planka >/dev/null 2>&1; then
    planka card move --list done --branch "$BRANCH" >/dev/null 2>&1 || true
    planka card comment --branch "$BRANCH" \
      --text "Landed on main as $(git rev-parse --short HEAD) (PR #$PR)." >/dev/null 2>&1 || true
  fi
```

- [ ] **Step 9: Verify the land edit does not break the gate**

Run: `bash -n bin/land && bin/lint-bsd-portability`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add home/dot_local/bin/executable_planka tests/planka.test.js \
        home/private_dot_claude/hooks/executable_planka-stop.sh \
        tests/hooks/planka-stop.test.js \
        home/.chezmoitemplates/settings.base.json bin/land
git commit -m "Comment the session log on stop, and finish the card on land

Stop comments only when the session actually claimed a card, so a
read-only session stays off the board. The card stays In Progress: a
session ending is not the work being blocked, and stale work is visible
as a card whose last comment is old.

land moves the card to Done, which is the one transition nobody should
have to make by hand — a merged PR is the unambiguous end of the unit of
work a card tracks."
```

---

### Task 6: `task promote`, the `planka-tracking` skill, the statusline segment, and turning it on

**Files:**
- Modify: `home/dot_local/bin/executable_planka`
- Modify: `tests/planka.test.js`
- Create: `home/private_dot_claude/skills/planka-tracking/SKILL.md`
- Modify: `home/private_dot_claude/executable_statusline-command.sh`
- Create (in the **work** repo): `~/work-laptop-config/.config/planka/config.json`

**Interfaces:**
- Consumes: everything above.
- Produces: `planka task promote <task-id>`, `planka open [--branch B]`, and the skill that owns titles, comment prose, and promotion judgement.

- [ ] **Step 1: Write the failing test**

Append to `tests/planka.test.js`:

```js
test('task promote creates a card and links it back to the task', { skip }, async () => {
  const fake = fakePlanka({
    'POST /api/access-tokens': () => ({ item: 'fake-jwt' }),
    'GET /api/task-lists/tl1': () => ({
      item: { id: 'tl1', cardId: 'c42', name: 'Plan' },
      included: { tasks: [{ id: 't7', taskListId: 'tl1', name: 'Extract the retry policy' }] },
    }),
    'POST /api/lists/list-active/cards': () => ({ item: { id: 'child-card' } }),
    'PATCH /api/tasks/t7': () => ({ item: { id: 't7', linkedCardId: 'child-card' } }),
  });
  await new Promise((r) => fake.server.once('listening', r));
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true,
    baseUrl: `http://127.0.0.1:${fake.port()}`,
    boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
    lists: { active: 'list-active' },
    customFields: { groupId: 'g1', branch: 'f-branch', repo: 'f-repo' },
  }));
  const res = spawnSync('python3',
    [PLANKA, 'task', 'promote', 't7', '--task-list', 'tl1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PLANKA_CONFIG: cfgPath,
        PLANKA_STATE_DIR: path.join(dir, 'state'),
        PLANKA_CACHE_DIR: path.join(dir, 'cache'),
        PLANKA_REPO: 'myrepo',
        PLANKA_PASSWORD: 'pw',
      },
    });
  fake.server.close();
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout.trim(), 'child-card');
  const created = fake.seen.find((r) => r.url === '/api/lists/list-active/cards');
  assert.strictEqual(created.body.name, 'Extract the retry policy');
  const linked = fake.seen.find((r) => r.method === 'PATCH' && r.url === '/api/tasks/t7');
  assert.strictEqual(linked.body.linkedCardId, 'child-card');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/planka.test.js`
Expected: FAIL — `task promote` does not exist.

- [ ] **Step 3: Write the implementation**

Add to `home/dot_local/bin/executable_planka`, above `build_parser`:

```python
def cmd_task_promote(args):
    """A checklist item that turned out to want its own PR. The task stays in the
    parent's checklist and gains a linkedCardId, so the parent still shows it."""
    cfg = require_config()
    task_list = call(cfg, "GET", "/task-lists/%s" % args.task_list)
    name = None
    for task in task_list.get("included", {}).get("tasks", []):
        if task.get("id") == args.task_id:
            name = task.get("name")
            break
    if not name:
        soft_fail("task promote: no task %s in list %s" % (args.task_id, args.task_list))
    list_id = cfg.get("lists", {}).get("active")
    if not list_id:
        soft_fail("task promote: lists.active is not configured")
    created = call(cfg, "POST", "/lists/%s/cards" % list_id,
                   {"name": name, "position": 65536})
    card_id = created.get("item", {}).get("id")
    if not card_id:
        soft_fail("task promote: no card id in the response")
    call(cfg, "PATCH", "/tasks/%s" % args.task_id, {"linkedCardId": card_id})
    print(card_id)


def cmd_open(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("open: no branch")
    side = read_sidecar(repo_slug(), branch)
    if not side or not side.get("url"):
        log("open: %s is not tracked" % branch)
        return
    subprocess.run(["open", side["url"]], capture_output=True)
```

Add to `build_parser`:

```python
    task = sub.add_parser("task", help="task operations")
    task_sub = task.add_subparsers(dest="task_command", required=True)
    promote = task_sub.add_parser("promote", help="turn a task into its own linked card")
    promote.add_argument("task_id")
    promote.add_argument("--task-list", required=True, help="the task's task-list id")
    promote.set_defaults(func=cmd_task_promote)

    opencmd = sub.add_parser("open", help="open this branch's card in a browser")
    opencmd.add_argument("--branch")
    opencmd.set_defaults(func=cmd_open)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/planka.test.js tests/hooks/planka-claim.test.js tests/hooks/planka-plan.test.js tests/hooks/planka-stop.test.js`
Expected: PASS, 33 tests.

- [ ] **Step 5: Write the skill**

Create `home/private_dot_claude/skills/planka-tracking/SKILL.md`:

```markdown
---
name: planka-tracking
description: Use when a session is editing code in a repo tracked on the Planka board — what to call the card, what the session-log comment should say, and when a checklist item deserves its own card. Hooks keep the card's list and fields current on their own; this covers the parts that need judgement.
---

# planka-tracking

Hooks already do the mechanical half: the first edit claims the card and moves it to
In Progress, TodoWrite mirrors into the Plan task list, Stop comments, and `bin/land`
moves the card to Done. Nothing below needs doing to make that work.

## Never write customer data

No PANs, no transaction detail, no account or card identifiers in a card title,
comment, task, or custom field. The PAN-redaction hook redacts *command output* — it
never sees what `planka` posts, so this rule is the only control on this path.

## Retitle the card once you know what the work is

A card created by the claim hook is named after the branch. As soon as the work has a
shape, give it the name a person would write:

```bash
planka card field --set title="Stop the settlement retry from double-posting"
```

Name the outcome, not the files touched. The same sentence would serve as the PR
title.

## Write the session-log comment before you stop

The Stop hook posts `~/.claude/planka/summary/$CLAUDE_SESSION_ID` if it exists, and a
bare "paused at <sha>" if it does not. Write the file when the session did something
worth reading later:

```bash
mkdir -p ~/.claude/planka/summary
cat > ~/.claude/planka/summary/$CLAUDE_SESSION_ID <<'EOF'
Moved the retry guard inside the lock. `npm test -- settlement` passes, 14/14.
Next: the same pattern in the reversal path, which has no test yet.
EOF
```

Three things, in this order: what changed, what was verified and with which command,
what is next. Never paraphrase an error string — quote it.

## Promote a task when it has become its own unit of work

A Plan task that deserves its own PR should become a card. It stays in the parent's
checklist and gains a link to the new card:

```bash
planka task promote <task-id> --task-list <task-list-id>
```

Find both ids with `planka card show`. Promote when a task has grown a test plan of
its own, not merely because it is large.

## Reverse states

Every state has a way back. Use these rather than clicking in the UI mid-session, so
the sidecar and the board stay in step:

| Situation | Command |
|---|---|
| Work is genuinely blocked on someone else | `planka card move --list blocked` |
| Work is queued again, not being touched | `planka card move --list onDeck` |
| This branch should stop being tracked | `planka card detach` |
| Where did this branch's card go | `planka status`, `planka open` |
```

- [ ] **Step 6: Add the statusline segment**

The script builds each segment with `put` (which measures width with SGR sequences stripped) and closes it with `end_seg`. Follow that idiom exactly — do not introduce a new accumulator.

In `home/private_dot_claude/executable_statusline-command.sh`, immediately **before** the final bare `end_seg` at line 325, add:

```bash
# The card this branch maps to. `planka status` reads the sidecar only — no network,
# no token — and prints nothing for an untracked branch, so a repo that is not on the
# board pays one process spawn and shows no segment.
if command -v planka >/dev/null 2>&1; then
  planka_card="$(planka status 2>/dev/null | awk -F'\t' '$2 ~ /^card /{sub(/^card /, "", $2); print $2}')"
  if [[ -n "$planka_card" ]]; then
    end_seg
    put '\033[38;5;110m▤ %s\033[0m' "$planka_card"
  fi
fi
```

The `end_seg` inside the branch closes whatever segment was pending, so the card becomes its own packable unit rather than widening its neighbour.

- [ ] **Step 7: Add `card detach`, which the skill promises**

Add to `home/dot_local/bin/executable_planka`, above `build_parser`:

```python
def cmd_card_detach(args):
    cfg = require_config()
    branch = resolve_branch(args)
    if not branch:
        soft_fail("card detach: no branch")
    path = sidecar_path(repo_slug(), branch)
    try:
        os.unlink(path)
    except OSError:
        return
    print("detached %s" % branch)
```

Add to `build_parser`'s card block:

```python
    detach = card_sub.add_parser("detach", help="stop tracking this branch")
    detach.add_argument("--branch")
    detach.set_defaults(func=cmd_card_detach)
```

- [ ] **Step 8: Write its test**

Append to `tests/planka.test.js`:

```js
test('card detach removes the sidecar and leaves the board alone', { skip }, () => {
  const dir = tmpdir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    enabled: true, baseUrl: 'http://127.0.0.1:1', boardId: 'b1',
    credential: { username: 'u', keychainService: 'nope' },
  }));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'branch'), { recursive: true });
  const sidecar = path.join(state, 'branch', 'myrepo--feature-y.json');
  fs.writeFileSync(sidecar, JSON.stringify({ cardId: 'c42' }));
  const res = spawnSync('python3', [PLANKA, 'card', 'detach', '--branch', 'feature-y'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PLANKA_CONFIG: cfgPath,
      PLANKA_STATE_DIR: state,
      PLANKA_CACHE_DIR: path.join(dir, 'cache'),
      PLANKA_REPO: 'myrepo',
      PLANKA_TIMEOUT: '1',
    },
  });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(fs.existsSync(sidecar), false);
});
```

- [ ] **Step 9: Run the whole suite**

Run: `node --test tests/planka.test.js tests/hooks/planka-claim.test.js tests/hooks/planka-plan.test.js tests/hooks/planka-stop.test.js`
Expected: PASS, 34 tests.

- [ ] **Step 10: Commit the public half**

```bash
git add home/dot_local/bin/executable_planka tests/planka.test.js \
        home/private_dot_claude/skills/planka-tracking/SKILL.md \
        home/private_dot_claude/executable_statusline-command.sh
git commit -m "Promote a task to a linked card, detach a branch, show the card

Completes the reverse states the spec requires: every way in now has a
way out and a way to see it. detach drops the sidecar, status and the
statusline segment make the mapping visible, and open goes to the card.

The skill carries the judgement the hooks cannot: what to call a card,
what a session-log comment should say, and when a checklist item has
become its own unit of work."
```

- [ ] **Step 11: Write the work-repo config and turn it on**

This half lives in the private repo and is not committed here.

```bash
mkdir -p ~/work-laptop-config/.config/planka
```

Write `~/work-laptop-config/.config/planka/config.json` using the ids recorded in Task 1, Step 7, with `"enabled": true`. Then:

```bash
~/work-laptop-config/install.sh
```

Commit it in that repo separately — it is private, and nothing about it belongs in the public dotfiles history.

- [ ] **Step 12: Exercise it end to end, by hand**

On a scratch branch in a tracked repo: make an edit, check the board shows a card in In Progress; run a TodoWrite-driven task, check the Plan list fills; stop the session, check the comment; land the PR, check the card reaches Done.

- [ ] **Step 13: Run the full gate before landing**

Run: `.githooks/pre-push </dev/null`
Expected: every step passes, no step skipped.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: the CLI and its no-op contract (Task 1), the correlation sidecar and its board fallback (Task 2), the hook wiring and first-edit claim (Task 3), the Plan task list (Task 4), the Stop comment and the `bin/land` edit (Task 5), `task promote`, the skill, the statusline, the reverse states, and the overlay config (Task 6). The spec's PR-open step — setting the `pr` field and moving to `review` — is served by `card field --set pr=<url>` and `card move --list review` from Task 3; no separate hook is planned, because the PR is opened from the conversation, which is where the skill can make the call.

**Types.** `call()` returns the decoded body; `create_card` returns a card id string; `ensure_task_list` returns a task-list id string; `read_sidecar` returns a dict or None. Every task uses those spellings.

**Placeholders.** None. Every code step carries the code; the statusline step names the real helpers (`put`, `end_seg`) and the real insertion point, read out of the file rather than guessed.

**One thing the tests cannot prove.** `read_password`'s keychain branch is never exercised — every test sets `PLANKA_PASSWORD`, because a test that wrote to the login keychain would not be hermetic. Task 1, Step 7 covers it by hand, once, and it is the only path in this plan verified that way.
