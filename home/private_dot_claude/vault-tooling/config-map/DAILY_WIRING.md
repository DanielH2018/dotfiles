# Daily refresh wiring (SPEC.md §9)

This generator is vault-agnostic and knows nothing about your scheduler. The two
options below are analyzed for keeping the map fresh; **Option A is recommended.**
Record whichever you actually deploy — and its concrete plist/cron/log paths — in
your private, machine-specific config repo, not in this (shareable) tool.

## Option A — dedicated launchd job (chosen)

A dedicated `com.<you>.claude.config-map` plist, running before the vault's
daily auto-commit job, invoking the generator directly by its deployed path
(not via `cd` into the vault — the generator resolves the vault location
itself from `$CLAUDE_VAULT_DIR`):

```xml
<key>ProgramArguments</key>
<array>
  <string>/bin/zsh</string>
  <string>-lc</string>
  <string>exec python3 "$HOME/.claude/vault-tooling/config-map/generate.py"</string>
</array>
```

Pros: fully deterministic, no model invocation, cheapest and fastest of the
two options considered, easy to reason about in isolation (`launchctl
kickstart` reruns just this).

Cons: one more plist to maintain; needs its own log path
and its own entry in your scheduled-jobs README, if you keep one.

## Option B — a step inside a `healthcheck`-style skill (rejected)

Some setups run a daily "healthcheck" skill that already ends with an
auto-commit; "regenerate the config map" could be a step before that commit.

Pros: no new plist; reuses scheduling and commit logic that already exists.

Cons: couples an unrelated, purely-mechanical script run to a skill that's
otherwise about vault health (lint + monthly checks); a config-map bug now
blocks/complicates the healthcheck commit; harder to rerun config-map alone
without also re-running the rest of healthcheck.

## Recommendation (why Option A)

`generate.py` has no LLM in its path and no reason to route through a Claude
skill invocation at all; running it directly via launchd (like a cron job) is
simpler and avoids coupling it to a healthcheck skill's scope. Sequence it a
few minutes before any daily auto-commit job so its output is included in
that day's commit without the two jobs racing.

Whichever option you pick, the **diff hygiene** behavior (content-hash
gate in `generate.py`) is the same either way — the HTML is only rewritten,
and therefore only committed, when the semantic payload actually changed.
