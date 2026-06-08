Capture session: Extract knowledge from this conversation and integrate it into the LLM Wiki at /Users/daniel/Documents/My_Vault.

STEP 1 — Scan this conversation for new information

Review the full conversation history (everything above this message). Extract all facts, findings, decisions, and corrections that are worth retaining beyond this session. Organize them by category:

**People signals**
- New teammates discovered, role corrections, TZ clarifications, email addresses
- Expertise or domain ownership confirmed through demonstrated knowledge
- New 1:1s scheduled or cancelled; new attendees in recurring meetings

**Systems and codebase**
- New repos discovered or clarified
- Service architecture details, data flows, infrastructure components
- Tool access granted or revoked; new Retool apps, dashboards, runbooks
- Bugs found or fixed; architectural decisions made

**Operational**
- New incidents, new patterns in PagerDuty alerts
- On-call rotation changes
- Active migration status changes (e.g., Majority migration)
- Runbook corrections or new runbook steps learned

**Company and team context**
- Org chart corrections
- Strategy, product, or business context learned
- Engineering principles or process rules observed

**Corrections to vault**
- Any fact that contradicts what is currently in the vault — flag these explicitly so stale info gets overwritten

If a topic has no new information beyond what the vault already contains, skip it.

STEP 2 — Read the index

Read /Users/daniel/Documents/My_Vault/index.md to identify which existing pages cover each finding from Step 1. Use these mappings to route findings:

- People roles, TZ, emails, expertise → Team/Processing Team.md, Team/Team Expertise.md
- 1:1s or meeting schedule → Team/One-on-Ones.md, Work/Recurring Meetings.md
- Repos, services, architecture, epics, tools → Work/Codebase.md
- Access, credentials, internal tools → Work/Systems and Tools.md
- Slack channels → Work/Slack Channels.md
- PD incidents, alert patterns, on-call changes → Ops/Production Incidents.md, Ops/On-Call.md
- Active migration status → Ops/Majority Migration.md
- Runbook details → Ops/On-Call.md
- Company leadership, products, scale, revenue → Lithic/About Lithic.md

If a finding doesn't fit any existing page, note it — a new page may be needed.

STEP 3 — Update affected pages

For each affected page:
- Read the current page content first
- Integrate new findings: add new sections, update stale facts, correct errors
- Be concise — integrate into existing structure rather than appending raw notes
- Update the frontmatter `updated` field to today's date (YYYY-MM-DD)
- Preserve all existing accurate content

Do not touch pages with nothing new to add.

STEP 4 — Create new pages if needed

If a finding is substantial enough to warrant its own page (a new service, a new incident, a significant new topic), create it at the appropriate vault path with proper frontmatter:

```yaml
---
title: <Title>
summary: <One sentence — what this note covers>
tags: [relevant, tags]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

Then add an entry to index.md and add backlinks from related pages.

STEP 5 — Append to log

Append a new entry to /Users/daniel/Documents/My_Vault/log.md:

## YYYY-MM-DD — session capture
- Source: Claude Code session (manual /capture-session)
- Pages updated: <list, or "none">
- Pages created: <list, or "none">
- Key findings: <bullet list of the most important things captured>
- Skipped (already in vault): <brief note on anything that was already known>

If there was nothing new to capture (no vault pages updated or created), skip the log entry entirely — do not append a "no changes" entry.

STEP 6 — Renew schedule

To avoid accumulating duplicate crons, first call CronList. Delete every existing cron whose prompt is "Execute the /capture-session skill." using CronDelete. Then call CronCreate with:
- cron: "0 9-18 * * *"
- durable: true
- recurring: true
- prompt: "Execute the /capture-session skill."

This ensures exactly one capture-session cron is active at any time.
