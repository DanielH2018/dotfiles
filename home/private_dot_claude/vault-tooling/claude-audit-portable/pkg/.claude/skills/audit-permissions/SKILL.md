---
name: audit-permissions
description: Audit the permission log and propose allowlist improvements. Use when reviewing which Bash commands or tools keep prompting for approval, or when tuning the Claude Code permission setup in .claude/settings.json.
---

Review the permission audit log and propose concrete improvements to the allowlist.

1. Run the audit script and read its output:

   `node .claude/scripts/audit-permissions.js`

   (Add `--since YYYY-MM-DD` to scope to recent activity, or `--json` for raw data.)

2. If the script reports no data, tell the user the log is empty (the hooks may not have run yet — they take effect on the next session after install) and stop.

3. Summarize the findings for the user:
   - Overall prompt rate and per-tool breakdown (auto-approved vs. prompted).
   - The most-prompted commands — these are the allowlist gaps.
   - The **Suggested Bash allowlist rules** — already segment-aware (splits compound `a && b | c` commands, ignores quoted/heredoc bodies and env prefixes) and cross-referenced against the current `allow`/`deny`/`ask` tiers, so already-covered and policy-blocked patterns are filtered out for you.
   - The **Left to prompt by design** section — commands that keep prompting because they contain a segment that is unsafe to blanket-allow (`powershell.exe`, `cd`, `rm`, `find`, `awk`, …). These are *expected* prompts, not gaps; do not propose allowlisting them.

4. For the top suggested rules, propose specific edits to the `allow` list in `.claude/settings.json`. Prefer the narrowest rule that covers the pattern (e.g. `Bash(gh pr *)` over `Bash(gh *)`). The script already excludes anything in `deny`/`ask`, but still sanity-check each pick and call out anything risky to auto-approve (e.g. utilities that can redirect-overwrite files, or anything with an exec/delete vector).

5. Present the proposed `settings.json` changes as a diff and ask for confirmation before editing. Only edit `.claude/settings.json` after the user approves.

6. After any edit, validate the JSON:

   `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('valid')"`

   and remind the user that permission changes take effect on the next Claude Code session.
