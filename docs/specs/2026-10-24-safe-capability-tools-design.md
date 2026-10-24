# Safe capability tools: routes instead of denial gaps

Date: 2026-10-24. Status: approved in conversation; slice 1 ships with this document.

## Goal

claude-guard keeps refusing commands whose job is legitimate. Each refusal ends one of four
ways:

- a route to a tool that already does the job safely;
- a new tool, built like `jsonq` and `ghread`, that offers the capability without the risk;
- a guard change the operator ruled on;
- a deliberate keep.

Narrowing a rule each time a session trips it is the pattern this replaces. Each narrowing
opens the next gap.

## Non-goals

- A general sudo tool. A privileged read a session needs gets its own sudoers wrapper, as
  `homelab-takeover-check` did.
- Reading a secret's value. Every tool here prints names, counts or structure, never a value.

## The input

A replay of 32,188 unique Bash commands from 2026-10-17 to 2026-10-24. After dotfiles #1002,
212 of them were refused:

| Outcome | Refusals |
|---|---|
| Routed to a tool that exists | 77 |
| Retired by five new tools | 48 |
| Retired by the literal-variable guard change | 24 |
| Kept on purpose | 32 |

## The rule every route passes

A deny message fires on true and false matches alike, so following its advice must be safe
even when the match is real. Advice that would let Claude do the dangerous thing on a real
match is a bypass recipe, not a route. Two candidates failed this test:

- "Write the file with the Write tool, then run it." On a real match, the written program
  still reads the secret.
- "Write the secret-named fixture with the Write tool." On a real match, it puts plaintext at
  a real SOPS path.

The Edit-tool route passes. The Read tool is refused every path `secret_paths.json` names,
and the Edit and Write tools never print what a file holds.

## What every new tool states

| Property | Why |
|---|---|
| An `autoMode.allow` prose entry and a `Bash(<tool>:*)` allow rule | `classifyAllShell: true` suspends every `Bash()` allow rule in auto mode, so the classifier alone decides there. The allow rule covers sessions outside auto mode. |
| A guard test on its own argv | The tool's documented invocations must trip no deny rule, checked by rows in `tests/test_deny.py`. |
| Construction, not checks | No caller argv is passed through, and the binary path and environment are fixed. A caller value travels as `--flag=value`. If a passthrough lands, the allow rule comes out in the same commit. |
| Routing | The deny message that fires names the tool, and a line in CLAUDE.md's *Tool use* section points to it. |

Each tool is a stdlib Python script at `home/dot_local/bin/executable_<name>`, with a
`node:test` file at `tests/<name>.test.js` in the style of ghread's.

## Guard decisions (ruled 2026-10-24)

1. **Literal variable command words resolve.** `F="uv run …"; $F x` is judged as the literal.
   Resolution gives up on anything that could set a name the text does not show. The
   `DECIDED (2026-10-24, approved)` marker in `deny.py` lists the cases.
2. **A secret-named fixture may be written into a session scratch directory**:
   `~/.claude/jobs/<id>/tmp/` or a per-user `$TMPDIR`. Bare `/tmp` and repo paths stay refused.
3. **The secrets-directory entry protects the runtime stores by path**: `/run/secrets/`,
   `/run/credstore/`, `/run/homelab-secrets/`, `/var/lib/homelab-secrets/` and the libvirt
   secrets directories. It no longer protects every directory named `secrets`.
4. **`Bash(find *-exec*)` stays denied.** CLAUDE.md names `rg`, the Grep tool and
   `find … -print0 | xargs -0 grep -l` instead.

Kept as they are: #865 (a stored heredoc that the same command runs) and the `remote` rule's
whole-string scan.

## Slices

| Slice | Delivers | Rows | Status |
|---|---|---|---|
| 1 | This spec; Edit-tool, `claude-guard replay` and while-read routes in the deny messages; CLAUDE.md lines | 77 | shipped with this document |
| 2 | `takeover-check`: runs the allowed `sudo -n` takeover line with checked arguments and merged stderr, so its output can be piped | 10 | planned |
| 3 | `secretq`: key names, presence, all-encrypted check and a SOPS-file hash, never a value | 13 | planned |
| 4 | `unitq cat UNIT`: a unit and its drop-ins with `Environment=` values, `EnvironmentFile=` contents and `Exec*` arguments removed structurally | 14 | planned |
| 5 | `claude-guard probe <check> <cases-file>`: a named internal check's verdict per case | part of 31 | planned; measure after slice 1 first |
| 6 | `killown PATTERN`: kills only processes in the session's own tree | 8 | planned; first confirm how the session root shows in `/proc` |
| 7 | `envq NAME…`: a value only for a non-credential name with a plain-shaped value, otherwise `set` or `unset` | 3 | planned |

`secretq` never hashes a plaintext file, because a low-entropy value hashes to something a
dictionary can reverse. `unitq` has no heuristic for what looks like a token; a redactor like
that leaks whatever it fails to recognise.

## Kept on purpose

- 24 real sudo calls: 19 local `sudo -n` and 5 over ssh.
- 4 command words built from `$(…)`, which no static check can resolve.
- 1 plaintext stub written at a real SOPS path.
- The code-scanning PATCH calls, which stay an ask.

## Measuring it

A route does not change a replay verdict, because the old command is still refused.
Success is a drop in hook denials per rule in the week after each slice, read from OTEL
against this week's 212. Each slice's PR names the rows it targets.
