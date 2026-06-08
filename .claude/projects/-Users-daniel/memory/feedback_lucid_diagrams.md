---
name: Lucid diagram style preferences
description: How Daniel wants Lucid architecture diagrams styled — high-level, no port numbers, semantic labels
type: feedback
originSessionId: 578bda03-d91c-4063-b2ed-8c3baa5144ac
---
Keep Lucid diagrams high-level and readable:
- **No port numbers** on shapes or connection labels (remove `:5432`, `:443`, `:9096`, etc.)
- **No scope labels** on individual shapes — use color coding + a legend instead of putting "CDE"/"shared"/"segmented" in every box
- **Semantic connection labels** ("rules check", "velocity check", "publish events") rather than technical ones (":443", ":5432")
- **Scope legend**: small set of colored swatches at the bottom of each page — red=CDE, yellow=Shared, green=Segmented

**Why:** Shown when Daniel asked to "polish and simplify" the processing domain diagram — the first version had port numbers everywhere and scope text on every shape, which added noise without adding clarity.

**How to apply:** Any time generating a Lucid diagram — apply these conventions from the start rather than waiting for feedback.
