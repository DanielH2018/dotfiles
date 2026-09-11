# claude-guard slice 3: the PermissionRequest cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the three unported PermissionRequest hooks and the two prototype PRs into `claude_guard`, adopt the spec's single-segment decision, then flip `CLAUDE_GUARD_SHADOW` to `0` and remove six bash hooks in one change.

**Architecture:** Three new modules under `claude_guard/checks/` (`remote.py`, `ansible.py`, `git_reset.py`), three new tables in `tables.py`, and three rule changes inside `judge.py`. Each check is a pure function from a command string to a bool, matching the `curl.py` / `scratch.py` house style: **a check never returns "deny" — it returns "yes, allow" or "no opinion"**, and the caller turns "no opinion" into silence so the prompt stands.

**Spec:** `docs/specs/2026-09-06-claude-guard-design.md` — Architecture (`checks/`), Rollout row 3, Decisions ("A single segment is judged like a chain").

**Exit criterion (spec row 3):** `replay --judge` allows at least the 84 of 677 the #477 prototype allowed; PRs #474 and #477 closed unmerged; the six bash hooks removed from `settings.base.json` and deleted.

---

## Global Constraints

- Python 3.14 syntax; stdlib only; no `from __future__`; no `noqa`.
- Edit only under the worktree `/home/ubuntu/.local/share/chezmoi/.claude/worktrees/slice3` (branch `worktree-slice3`). Never `cd` to `/home/ubuntu/.local/share/chezmoi` itself. Never `git stash`. Never `chezmoi apply`. Never `uv run` without `--no-project`. Do not touch `/home/ubuntu/server`.
- Pytest, from `home/dot_local/share/claude-guard`: `PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q`.
- Ruff, same directory: `uv run --no-project --python 3.14 --with ruff ruff check .` — line-length 100 applies to tests too.
- Node: `export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"` first.
- The lint hook runs `ruff --fix` after every Edit and strips an import added one edit before its use. Import and first use go in the same edit.
- Never write to the real `~/.claude/logs/` from a test.
- Commits explain why. No `--no-verify`. Push only in the last task.
- **This is a PORT.** Every rule reproduces the decision the bash makes today, with its `file:line` range cited in the function's docstring. The two deliberate behaviour changes are named in *Decisions* below and nowhere else.
- Every rule family ships an `…_is_allowed` / `…_is_refused` pair. A check that can only pass is not evidence.

---

## Decisions

Recorded here so a reviewer does not re-derive them. Each also gets a `# DECIDED:` marker at the line it governs.

**D1 — `remote.py` exposes two functions, not one tiered check.** The spec's open question ("whether `allow-readonly-remote`'s verb table and `allow-daniel-server`'s host trust collapse into one `remote` check with two tiers") is answered: **two**. They ask orthogonal questions. `allow-readonly-remote.sh` has no host filter at all and decides on the verb; `allow-daniel-server.sh` has no verb table at all and decides on the host, then allows the whole payload. Their outer-command parsers also differ — the first delegates to `cmd_parse`, the second runs its own quote-state machine and never carves out `ssh -O check` or `-o BatchMode=yes`. A single function would have to fork on host membership before choosing a grammar *and* an allow condition, which is two checks sharing a call site. Fusing them risks the trusted-host branch inheriting the verb allowlist, which would silently **narrow** a deliberate total-trust grant. Cost if wrong: one extra function in one module.

**D2 — a single segment is judged like a chain.** From the spec's *Decisions*. `judge()` currently returns `not-compound` for a command with no `&&`, `;` or `|`, a faithful port of `allow-compound-bash.sh:51-59`. Slice 3 removes that early return so a bare `rm -rf ./build` or `curl -sS https://…` reaches the same checks a chained one does. This is the one policy change in the slice and the reason its census carried a standing `not-compound` `bash_only` row (PR #487).

**D3 — `allow-daniel-server.sh` ships tests it never had.** It has no test file today. The port writes one against the bash's behaviour *before* the Python exists, so the port has an oracle rather than only the reimplementation's own say-so.

---

## File structure

| path (under the worktree) | responsibility |
|---|---|
| `home/dot_local/share/claude-guard/claude_guard/tables.py` (modify) | `TRUSTED_SSH_HOSTS`, `REMOTE_READONLY_VERBS`, `SECRET_PATH_RE` |
| `home/dot_local/share/claude-guard/claude_guard/checks/remote.py` | `readonly_remote_safe()`, `trusted_host_safe()` |
| `home/dot_local/share/claude-guard/claude_guard/checks/ansible.py` | `ansible_readonly_safe()` |
| `home/dot_local/share/claude-guard/claude_guard/checks/git_reset.py` | `clean_reset_safe()` |
| `home/dot_local/share/claude-guard/claude_guard/judge.py` (modify) | #477's three rules; D2's single-segment change; the new checks wired in |
| `home/dot_local/share/claude-guard/tests/test_remote.py` | pairs for both functions, incl. the suite `allow-daniel-server.sh` never had |
| `home/dot_local/share/claude-guard/tests/test_ansible.py` | pairs ported from `tests/hooks/allow-ansible-readonly.test.js` |
| `home/dot_local/share/claude-guard/tests/test_git_reset.py` | pairs ported from #474's `tests/hooks/allow-clean-reset.test.js` |
| `home/dot_local/share/claude-guard/tests/test_judge.py` (modify) | #477's rules, D2 |
| `home/.chezmoitemplates/settings.base.json` (modify) | `CLAUDE_GUARD_SHADOW` → `"0"`; six hook registrations removed |
| six files under `home/private_dot_claude/hooks/` | deleted |
| `docs/specs/2026-09-06-claude-guard-design.md` (modify) | row 3 marked done; the open question closed with D1 |

---

## Task 1: `tables.py` — the three tables the remote check reads

**Files:** modify `claude_guard/tables.py`; create `tests/test_tables_remote.py`

**Produces:** `TRUSTED_SSH_HOSTS: frozenset[str]`, `REMOTE_READONLY_VERBS: frozenset[str]`, `SECRET_PATH_RE: re.Pattern`.

`tables.py:3-4` already names the first two as arriving "with the remote check in a later slice" — this is that slice.

- `TRUSTED_SSH_HOSTS` is `{"daniel-server", "daniel-pi"}` from `allow-daniel-server.sh:93`. **It is NOT `CURL_HOSTS`** — that set also holds `daniel-box`, loopback and localhost, and `daniel-box` is deliberately absent here. A test must assert the two sets differ, so a later "tidy-up" cannot merge them.
- `REMOTE_READONLY_VERBS` is the flat list at `allow-readonly-remote.sh:158-165`. The nested `ip` / `docker` / `systemctl` sub-tables stay in `remote.py` beside the dispatch that reads them — they are not flat verb names.
- `SECRET_PATH_RE` is `SECRET_RE` from `allow-readonly-remote.sh:134`, compiled with `re.IGNORECASE` to match the bash's `grep -qiE`.

**Non-vacuity:** the test asserts a named frozenset of members each table must contain (`{"uptime", "journalctl", "nvidia-smi"}` for the verbs; both hosts for the hosts), not a count — per the repo's own convention, a count moving tells you nothing about which member went missing.

---

## Task 2: `checks/remote.py` — `readonly_remote_safe()`

**Files:** create `claude_guard/checks/remote.py`; create `tests/test_remote.py`

**Ports:** `allow-readonly-remote.sh:26-199`.

**Signature:** `readonly_remote_safe(command: str) -> bool`.

The bash's shape, in order — keep it:

1. Outer-command gate. The bash calls `cmd_parse`; the Python uses `segment.parse()`, which is the same contract. Require `parsed.ok`, exactly one segment, no substitutions, no heredocs. **A parse refusal is a refusal, never a skip.**
2. Raw-character ban on the whole command for what the segmenter does not model (`:63`): `< > { } * ? [ ] \` and a literal newline.
3. Tokenize: strip every `"` and `'`, then split on whitespace. Do this **once** and let every later check read the same stripped tokens — the bash computes `$rest` once at `:112-114` and reuses it, and re-tokenizing per check is how a port drifts.
4. Wrapper: `hl` → remote argv starts at token 1; `ssh` → the bare 4-token `-O check` form, else only `-oBatchMode=yes` / `-o BatchMode=yes` consumed, any other leading `-*` refuses. Any other basename refuses.
5. Metacharacter ban on the joined remote text (`:122-124`): `; & | ` $ ( )`.
6. `SECRET_PATH_RE` against the remote text — refuse on a match.
7. The three mutation-flag refusals: `journalctl` (`:137-139`), `dmesg` (`:141-142`), `ss` (`:145-146`). **`dmesg` and `ss` match a short cluster containing `C`/`c` and `K` respectively — a character class inside a cluster, not an equality test.** `-xKy` must refuse.
8. The verb dispatch (`:157-196`): flat table, then `ip` (third token in `{"", "show", "list", "ls", "get"}`), `docker` (flat sub-list plus the nested `network|volume|context|node|container|image|system|compose|service|stack` tables), `systemctl` (sub-list). `docker inspect`, `docker config`, `systemctl show`, `systemctl cat` and `systemctl show-environment` are **deliberately excluded** — cite the bash comments at `:173-174` and `:187-188` so nobody adds them back.
9. Fall-through returns `False` meaning *no opinion*.

**Hazard — the empty third token.** `case $third in ''|show|...)` at `:170` allows an **absent** third token: `ip a` has none. In Python, a missing token must compare equal to `""`, not `None`, or `ip a` silently stops being allowed.

**Tests:** port `tests/hooks/allow-readonly-remote.test.js` — 20 ALLOW cases and 62 DEFER cases, plus the literal-newline smuggle case it injects separately. Keep them as two parametrised lists so a rule that stops matching fails its own test.

---

## Task 3: `checks/remote.py` — `trusted_host_safe()` and the suite it never had

**Files:** modify `claude_guard/checks/remote.py`; modify `tests/test_remote.py`

**Ports:** `allow-daniel-server.sh:27-112`.

**Signature:** `trusted_host_safe(command: str) -> bool`.

Per **D3**, write the tests first, derived from reading the bash — there is no existing suite to port.

1. `local_split_risk()` — a character-by-character quote-state machine over the **raw** string (`:49-73`). Outside quotes, any of `; & | < > ( ) $ \`` or a newline is a risk. Inside double quotes, only `$` and `` ` `` are (they expand locally before ssh runs). Inside single quotes, nothing is. A backslash escapes the next character everywhere except inside single quotes. An unterminated quote at end-of-string is a risk.
   **Hazard:** do not approximate this with a regex. Banning `;` anywhere reintroduces a measured regression — `ssh daniel-server "cd /repo; git status"` was 67 of 361 prompts before the state machine fixed it (`:34-39`).
2. Tokenize by stripping quotes and splitting; fewer than three tokens refuses.
3. `TOK[0]` basename must be exactly `ssh`. **No option is ever consumed** — any `TOK[1]` starting with `-` refuses, unlike the sibling function. Do not reuse `readonly_remote_safe`'s `-O check` carve-out here; that would widen this grant.
4. Host: `TOK[1]` with any `user@` prefix stripped must be **exactly** in `TRUSTED_SSH_HOSTS`. Substring matching is explicitly ruled out at `:89-90` — `daniel-server-backup` and `notdaniel-server` must refuse, and both need a test.
5. Second-hop refusal (`:106-110`): **every** token from index 2 onward, basename-matched, must not be `ssh|hl|scp|sftp|rsync`. Not just token 2 — a hop can sit mid-payload after a `cd /tmp;` or as an argument to `docker exec`. A port that checks only `TOK[2]` passes its own naive test and misses the real case.
6. Otherwise allow — the entire remote payload, read-only or not. That is this hook's whole point (`:4-6`, `:112`). **Do not filter it through the verb allowlist.**

---

## Task 4: `checks/ansible.py`

**Files:** create `claude_guard/checks/ansible.py`; create `tests/test_ansible.py`

**Ports:** `allow-ansible-readonly.sh:53-172`.

**Signature:** `ansible_readonly_safe(command: str) -> bool`.

1. Two exact-pattern strips on the **raw** string, before tokenizing: a leading `stdio-blocking; ` (`:57-59`) and a trailing `2>&1 | tail -n N` / `2>&1 | tail -N` (`:60-62`). If a pattern does not match verbatim, leave the string untouched and let the tokenizer refuse whatever remains.
   **Hazard:** do not fold these into the tokenizer's grammar. Treating `stdio-blocking` as a recognised leading token would accept `stdio-blocking ;` with a space, which the bash never did.
   **Hazard:** the trailing regex is anchored and narrow — it accepts `-n 50`, `-n50` and bare `-3`, only immediately after `2>&1`, only at end of string. The live production shape is `stdio-blocking; uv run ansible-playbook ansible/deploy.yml --tags karakeep --check 2>&1 | tail -3` and it must keep passing.
2. Tokenizer: any shell-special character outside quotes is an outright refusal, same posture as `scratch.py` (the bash says so itself at `:68-71`). Unterminated quote refuses.
3. Head recognition, positional and **before any flag scanning**: `ansible-playbook`, `uv run ansible-playbook`, or `uv run --frozen ansible-playbook`. Nothing may precede it. An unrecognised head refuses immediately — otherwise `helm ansible-playbook.sh --check` could falsely allow.
4. `-e` / `--extra-vars` values are **opaque**: never scanned for a read-only word, only checked for a leading `@`, which disqualifies the whole command even alongside `--check`. Four token shapes: `-e VAL`, `--extra-vars VAL`, `--extra-vars=VAL`, `-eVAL` (short-attached, distinguished by *not* starting `--`). The value token is skipped entirely from the read-only scan.
5. Allow only if some remaining token equals — **whole-token, never substring** — one of `--check --list-tasks --list-tags --list-hosts --syntax-check`.

**Tests:** port all 12 ALLOW and 14 DEFER cases from `tests/hooks/allow-ansible-readonly.test.js`. Add the two the existing suite lacks: `uv run` followed by neither `ansible-playbook` nor `--frozen`, and an unterminated quote.

---

## Task 5: `checks/git_reset.py` — PR #474's rule

**Files:** create `claude_guard/checks/git_reset.py`; create `tests/test_git_reset.py`

**Ports:** `home/private_dot_claude/hooks/executable_allow-clean-reset.sh` on branch `worktree-allow-clean-reset` (PR #474, 107 lines) — read it with `git show origin/worktree-allow-clean-reset:home/private_dot_claude/hooks/executable_allow-clean-reset.sh`.

**Signature:** `clean_reset_safe(command: str, cwd: str) -> bool`.

Auto-approves `git reset --hard` onto `origin/master` or `origin/main` **only when the working tree is clean**. The cleanliness probe is the subtle half: it runs git itself, so it is a real subprocess with a real failure mode — a non-zero exit, a timeout, or an unreadable tree all mean *no opinion*, never *allow*.

Port #474's own `tests/hooks/allow-clean-reset.test.js` (131 lines) as the pair set, and keep its dirty-tree case, which is the rejecting half of the pair.

---

## Task 6: `judge.py` — PR #477's three rules

**Files:** modify `claude_guard/judge.py`; modify `tests/test_judge.py`

**Ports:** the 132 changed lines of `allow-compound-bash.sh` on branch `worktree-compound-hook-chains` (PR #477) — `git show origin/worktree-compound-hook-chains:home/private_dot_claude/hooks/executable_allow-compound-bash.sh`.

Three rules, and `judge.py:5-6` already names them as the target:

1. **A newline separates like `;`.** `judge.py:274` currently refuses a segment whose separator is `newline` or `&`. The segmenter already reports both correctly (slice 1); the judge stops treating `newline` as unjudgeable. A bare `&` stays refused — it backgrounds, which is not the same statement.
2. **A quoted-delimiter heredoc write is judged as a write to its path.** `judge.py:272-273` currently returns `unjudgeable:heredoc` for any segment carrying one. A heredoc whose delimiter was **quoted** cannot carry a live substitution — the segmenter records `heredoc_quoted` for exactly this — so `cat > path <<'EOF'` is judged as a write to `path` and reaches `scratch.py`. An **unquoted** delimiter stays unjudgeable.
3. **Benign prefixes are skipped before the program is judged.** A literal `VAR=value` prefix and `timeout N` are stripped; `set -…` segments are skipped entirely. `judge.py:58` and `:115` already carry the wrapper-unwrapping machinery this extends.

Port #477's 160 test lines alongside.

---

## Task 7: `judge.py` — the single-segment decision (D2)

**Files:** modify `claude_guard/judge.py`; modify `tests/test_judge.py`

Delete the `not-compound` early return at `judge.py:252-254` so a single-segment command is judged exactly like a chain of one, and wire the four checks in: `remote.readonly_remote_safe`, `remote.trusted_host_safe`, `ansible.ansible_readonly_safe`, `git_reset.clean_reset_safe`, alongside the existing `scratch` and `curl`.

**This is the slice's one policy change.** Tests must pin both directions: a bare `rm -f /tmp/x` now allowed where it previously returned `not-compound`, and a bare command matching no check still returning no opinion.

Add a `# DECIDED:` marker at the deleted guard's site naming D2 and pointing at the spec.

---

## Task 8: The cutover

**Files:** modify `home/.chezmoitemplates/settings.base.json`; delete six hooks; modify `tests/settings/settings-base-shape.test.js`; `config-soak.json` via `node bin/config-soak land`

1. `env.CLAUDE_GUARD_SHADOW` → `"0"`. `hook.py` treats every value except exactly `0` as shadow, and `guard-permission-request.sh` defaults it to `1` — **the shim's own default must be flipped too**, or a stale `settings.json` keeps the hook in shadow and the cutover silently does not happen.
2. Remove six `PermissionRequest` registrations: `allow-compound-bash.sh`, `allow-readonly-remote.sh`, `allow-safe-curl.sh`, `allow-safe-rm.sh`, `allow-ansible-readonly.sh`, `allow-daniel-server.sh`. `guard-permission-request.sh` stays and becomes the decision. (The spec says "five"; it was written before #476 added the ansible hook.)
3. Delete those six `home/private_dot_claude/hooks/executable_*.sh` files and their `tests/hooks/*.test.js` suites — the Python tests are the oracle now.
4. `settings-base-shape.test.js` asserts the six are **gone** and `guard-permission-request.sh` remains. That assertion is the red-proof: it fails if a hook is left registered.
5. **Do not delete `cmdparse.sh`.** `block-dangerous-bash.sh` still sources it until slice 4 cuts over, and slice 6 owns its retirement.

---

## Task 9: The exit gate and the PR

**Files:** none created

1. Rebuild the prompted corpus (it is transcript-derived and never committed) with the `otelq` query in slice 2's Task 8 step 1, widening `--since` to cover the 2026-09-06 week. Record the real record count; it will not be 677.
2. `replay --judge --compare-hooks ~/.claude/hooks` before the cutover, to show the Python allows **at least 84** of the corpus — the spec's gate, set by what the #477 prototype allowed.
3. Full package suite, ruff, and the whole node suite (`git ls-files '*.test.js' '*.test.mjs' | xargs -r node --test`).
4. Push, open the PR, land it, `chezmoi apply`, then **verify the change, not just the workload**: run one command of each newly-covered shape and confirm no prompt — a read-only `ssh daniel-server`, a `--check` ansible run, a bare scratch `rm`.
5. Close #474 and #477 unmerged, each with a comment naming the module their rule now lives in.
6. Mark spec row 3 done and close its open question with D1.

---

## Verification

The census is the instrument that proves the cutover was safe to make, and it keeps running afterwards: `guard-permission-request.sh` is now the decision, so a disagreement no longer has a bash hook to fall back on. Read `shadow-report` once a day for the first week — with the bash hooks gone it reports only the Python's own verdicts, which is a different question from agreement, and the README should say so.
