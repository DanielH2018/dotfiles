---
title: Settlement Retry Race Incident
summary: Postmortem for the duplicate-settlement race under concurrent retries
tags: [ops, incident, settlement]
created: 2026-05-12
updated: 2026-05-12
---

Incident TICKET-1234. Duplicate settlements were produced when the settlement
processor received concurrent retries.

## Root cause

The processor did not hold the lock across the database read and write, so two
concurrent retries could both observe an unsettled transaction and each write a
settlement row.

## Fix

Hold the advisory lock for the full read-modify-write span. Deploy tracked in
TICKET-1234.
