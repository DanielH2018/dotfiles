# claude-guard: sandbox port handoff

Written 2026-09-17 on daniel-box, for the laptop. Everything below is measured on daniel-box
unless it says otherwise; the laptop is where the port happens, because it has docker and
daniel-box does not.

> **Outcome (2026-09-18).** The port shipped as dotfiles #508; the operator ran step 4's gates
> on the laptop after `--rebuild-base` (operator-reported: the vector replay and one live deny
> both passed). Step 5 landed as the second half of slice 6, with one departure: `bin/lint-bsd-portability`
> stays, because its header records four macOS incidents across the repo and the bash hook was
> only one of them. The spec's Rollout row 6 is the record; the rest of this document is the
> plan as written.

## Where the rollout stands

The spec is `docs/specs/2026-09-06-claude-guard-design.md`; its Rollout table is the ledger.

| Slice | State | PR |
|---|---|---|
| 1 segmenter, 2 judge | done | earlier |
| 3 PermissionRequest cutover, six bash allow hooks deleted | done, deployed | dotfiles #501 |
| 4 PreToolUse cutover, `block-dangerous-bash.sh` unregistered on the host | done, deployed | dotfiles #502 |
| 5 server repo | **narrowed**: bootstrap + two tables + deployed-import test | server #1861 |
| 6 retire the old layering | **narrowed**: allow-side shadow apparatus only | dotfiles #504, #505 |

Both narrowings are blocked on the same thing: the sandbox still runs the bash deny hook.
`block-dangerous-bash.sh` is bind-mounted at `executable_claude-sandbox:884` and registered in
`sandbox/settings.base.json:177`; it sources `cmdparse.sh`. Until the sandbox runs the Python
port, those two files, their five JS suites, `bin/lint-bsd-portability`, and the deny-side
comparison tooling in the package (`replay --deny --compare-hook`, `CLAUDE_GUARD_DENY_SHADOW`)
all stay, because they are the only oracle for a control that is still live.

The host side is at its end state. `~/.claude/settings.json` registers one PermissionRequest
hook (`guard-permission-request.sh`) and one deny PreToolUse hook (`guard-pre-tool-use.sh`),
both shims over `~/.local/share/claude-guard`. The allow-side shadow switch is gone; the
deny-side one (`CLAUDE_GUARD_DENY_SHADOW`) is live at `0`.

## The port, step by step

### 0. The design constraint that changes the shape

`guard-pre-tool-use.sh:48-51`: when `uv`, the managed Python 3.14 or the package is missing,
`fail()` prints a `permissionDecision: "ask"` and exits 0. On the host that is fail-closed: the
prompt stands. The sandbox's CMD is `claude --dangerously-skip-permissions`, and under that
flag an `ask` is skipped (your answer, 2026-09-17; the docs document only that a `deny` still
blocks there). So the same shim in the sandbox is a silent fail-open: a container missing any
prerequisite runs with no deny hook and nothing says so.

**The sandbox's failure path must be `deny`.** Two shapes, pick one:

- An env switch the sandbox sets — `CLAUDE_GUARD_FAIL_CLOSED=1` in `sandbox/settings.base.json`'s
  `env` — that makes `fail()` print a `deny` JSON (same reason text) instead of `ask`. One shim,
  one file to mount, one branch to test each way. Preferred.
- `exit 2` in `fail()`. Blocks regardless of JSON (hooks.md, "Exit code output"), but the reason
  reaches the user only via stderr, and it changes the host's behaviour too unless gated.

Whichever you pick, the node test for the shim gets a pair: `fail()` under the sandbox env
prints `deny`; `fail()` without it still prints `ask`. `tests/settings/settings-base-shape.test.js`
is where the host-side shape lives; `tests/sandbox/sandbox-settings-base.test.js:53-61` is the
test that today asserts `block-dangerous-bash.sh` stays registered — it flips to asserting
`guard-pre-tool-use.sh` is, and that the fail-closed env key is present.

### 1. Image: `uv` and a managed Python 3.14

`home/private_dot_claude/sandbox/Dockerfile.base`. Base is `debian:stable-slim` (line 2); its
`python3` is 3.12/3.13 and is used only for two venvs (lines 101-135). No `uv` in the base image;
`executable_sandbox-image.sh:147` installs it per repo only when `detect_uv_need()` says so,
via `curl … | sh` — not the shape to copy.

Add a layer after the chezmoi one (lines 57-69 are the pattern: pinned version, checksum
verified, `install -m 0755`):

```dockerfile
ARG UV_VERSION=<pin>
RUN set -eux; \
    arch="$(uname -m)"; \
    base="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}"; \
    file="uv-${arch}-unknown-linux-gnu.tar.gz"; \
    cd /tmp; \
    curl -fsSL -O "${base}/${file}"; \
    curl -fsSL -O "${base}/${file}.sha256"; \
    sha256sum -c "${file}.sha256"; \
    tar -xzf "${file}" --strip-components=1; \
    install -m 0755 uv /usr/local/bin/uv; \
    rm -f "${file}" "${file}.sha256" uv uvx; \
    uv --version
```

Then, **as `claudebot`** (after `USER claudebot`, line 73), `RUN uv python install 3.14`. The
shim resolves the interpreter with `uv python find --no-project --managed-python --system 3.14`
(`guard-pre-tool-use.sh:55`), which only finds a uv-managed install in the running user's data
dir (`~/.local/share/uv/python`). Installing as root puts it in root's home and the lookup
fails — which, after step 0, is a deny on every Bash call rather than a silent hole, so you will
notice, but do it as `claudebot`. Check that no later mount shadows `/home/claudebot/.local/share`
(the package mount below is one directory deeper and does not).

Pin `UV_VERSION` to what the host runs: daniel-box has `uv 0.12.1` on 2026-09-17; check the
laptop's too, since the package is judged by whichever interpreter `uv python find` returns.

### 2. Launcher: two mounts

`home/private_dot_claude/sandbox/executable_claude-sandbox`, the hook mount block at ~866-885.
Replace the `block-dangerous-bash.sh` line (884) with the shim, and add the package:

```
-v "$HOME/.claude/hooks/guard-pre-tool-use.sh:/home/claudebot/.claude/hooks/guard-pre-tool-use.sh:ro"
-v "$HOME/.local/share/claude-guard:/home/claudebot/.local/share/claude-guard:ro"
```

The shim reads `SHARE="${CLAUDE_GUARD_HOME:-$HOME/.local/share/claude-guard}"` (line 53), so the
container path must be under claudebot's `$HOME` or `CLAUDE_GUARD_HOME` must be set in the
sandbox env. The package directory on the host is a plain chezmoi target
(`home/dot_local/share/claude-guard/`), so the mount is of deployed files, same as the hooks.
Read-only matters for the same reason the comment at 866-870 gives for the hooks: a `:ro`
mount point cannot be rewritten by the agent it fences.

`tests/sandbox/claude-sandbox-mounts.test.js` pins the mount list; update it in the same commit.

### 3. Settings: registration and the fail-closed env

`home/private_dot_claude/sandbox/settings.base.json:174-178`: change the first PreToolUse
command from `block-dangerous-bash.sh` to `guard-pre-tool-use.sh`, keep `"timeout": 10`. Add
the fail-closed env key from step 0 to the sandbox's `env` block, and `CLAUDE_GUARD_DENY_SHADOW:
"0"` — the shim defaults to `0` when the key is absent (`:=0`), but the two-place rule from
slice 4 applies: the settings value and the shim default say the same thing on purpose.

`resolve-sandbox-settings.sh` never propagates `hooks` from the host settings (by design), so
the sandbox's wiring is this file alone.

### 4. Gate it the way slice 4 was gated

Inside the container, before switching the registration:

1. `uv python find --no-project --managed-python --system 3.14` prints a path as `claudebot`.
2. The 281-vector corpus agrees: from `/home/claudebot/.local/share/claude-guard`,
   `PYTHONPATH=. <that python> -S -P -m claude_guard.cli replay <corpus.jsonl> --deny --compare-hook /home/claudebot/.claude/hooks/block-dangerous-bash.sh` → `AGREE 281/281`. Build the
   corpus by flattening `tests/fixtures/block-dangerous-bash-vectors.json` (32 deny / 27 allow
   groups) into `{command, cwd}` records — slice 4 did this with a short `jq` over the
   fixture and did not keep the file. Mount `block-dangerous-bash.sh` for this run only.
3. Drive the shim as the container's Claude would: `bash ~/.claude/hooks/guard-pre-tool-use.sh
   < payload.json` with `{"tool_name":"Bash","tool_input":{"command":"git push --force origin
   main"},"cwd":"/workspace"}` → `permissionDecision: "deny"`; with `ls -la` → no output, exit 0.
4. The failure path, both ways: rename the package dir (or point `CLAUDE_GUARD_HOME` at an empty
   dir) and drive it again → `deny`, not `ask`, not silence.

After switching the registration, one end-to-end check that the harness honours it: start the
sandbox, ask Claude to run `git push --force origin main` on a throwaway branch, and confirm
the deny reason appears. That is the measurement the spec still calls unmeasured — a hook
`deny` under `--dangerously-skip-permissions` — and one run settles it.

### 5. Then the real slice 6, one dotfiles PR

Only after the port has shipped and a sandbox has run on it:

- Delete `hooks/executable_block-dangerous-bash.sh` and `hooks/executable_cmdparse.sh`; add
  both to `home/.chezmoiremove` (chezmoi apply does not remove a target dropped from source —
  slice 3 learned this, memory `chezmoi-apply-leaves-deleted-targets-in-place`).
- Delete `tests/hooks/block-dangerous-bash*.test.js`, `tests/hooks/cmdparse*.test.js`,
  `tests/lib/block-dangerous-bash.js`, `bin/lint-bsd-portability` and its test, and the family
  check in `tests/shadow-report.test.js:182`. Keep `tests/fixtures/block-dangerous-bash-vectors.json`
  — `test_deny.py` in the package reads it and it is the deny rules' corpus, not the hook's.
- In the package: `DENY_LOG_NAME`, `DENY_HOOK`, `bash_deny_verdict`, `deny_shadow_record`,
  `summarize_deny`, `replay --deny --compare-hook`, the `shadow-report` subcommand, and the
  `CLAUDE_GUARD_DENY_SHADOW` switch in the shim and `settings.base.json` (both places).
  `test_hook.py` / `test_cli.py` lose their tests for those names; `pre_tool_use` keeps its
  live-path tests.
- `config-soak.json` and `retention-manifest.json`: drop the `cmdparse-shadow.jsonl` entries.
- Docs: spec row 6 to done; `README.md`'s deny-shadow sections; the `settings.base.json`
  comment block above `CLAUDE_GUARD_DENY_SHADOW`.

## Landing mechanics on the laptop

- `bin/land` from the worktree, after `gh pr create`. It rebases, pushes, merges under a lock,
  and the pre-push gate runs the full node suite.
- `config-soak.json` conflicts on every rebase that touches a tracked config file. Resolve with
  `git checkout --ours -- config-soak.json && node bin/config-soak land && git add config-soak.json`.
  `Dockerfile.base`, `executable_claude-sandbox`, `settings.base.json` and the shim are all
  tracked by it, so expect the gate to demand a `config-soak land` before the first push.
- The gate caches a result per clean tree, including a FAIL. `tests/hooks/planka-claim.test.js:136`
  flakes under the full suite (order-dependent; passes alone; reproduces on main). A red gate
  naming it gets one `GATE_CACHE_OFF=1 git push` before it means anything.
- Landing is not deploying: `git merge --ff-only origin/main` in the primary checkout, then
  `chezmoi apply`, then `claude-sandbox --rebuild-base`.

## Follow-ups filed elsewhere

- server #1863 — 58 ssh-dependent auto-approve vectors pass against the CI stand-in with nothing
  showing it; split the tables so CI shows them skipped.
- server #1864 — two PermissionRequest hooks judge every ssh command since the cutover; measure
  the double `uv run` cost before the full slice-5 consolidation decides which retires.
- Not filed (dotfiles has no `findings.py`): the `POSIX_SPACE` locale finding and the H1
  absolute-target exemption (4 gate rows), both in the slice-3 ledger at
  `~/.claude/artifacts/claude-guard-slice3/sdd-ledger/` on daniel-box; the `planka-claim` flake.
- The full slice-5 hook consolidation is re-planned from
  `docs/plans/2026-09-17-claude-guard-slice-5-survey.md`; its first decision is whether `TIER1`
  and `REMOTE_READONLY_VERBS` converge (they differ by 32+11 names, a policy change).

## Artifacts on daniel-box, do not delete

`~/.claude/artifacts/claude-guard-slice3/` — `hooks-snapshot-precutover/` (the only bash oracle
left for the allow chain), `prompted_inputs-2026-09-12.jsonl` (the 1058-record corpus; the
gate is `replay --judge` → `ALLOW 84/1058`, floor 84, zero headroom), the SDD ledger.
`~/.claude/artifacts/claude-guard-slice4/` — the PR body and the flattened deny corpus.
