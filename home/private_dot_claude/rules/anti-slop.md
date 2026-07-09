---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/*.py"
  - "**/*.go"
  - "**/*.rs"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.sh"
---
Write code that reads like a person wrote it, not a model. Applies to any code you add or change here:

- **Name for what it is.** A function that fetches a user is `fetchUser`, not `retrieveUserEntity`; a retry counter is `retries`, not `attemptOrchestrator`. No metaphors, no thesaurus reaches, no vague `Manager`/`Helper`/`Handler` when a concrete noun exists.
- **No decorative comments.** Don't restate the code (`// increment i`) or narrate the obvious, and don't write flavor text — a comment earns its place only by explaining *why* something non-obvious is done. (Per the top-level rules, don't add comments to code you didn't change.)
- **Plain strings, logs, and errors.** Say what happened in concrete terms — no "gracefully orchestrating", no "✨ magic happens here".

The tell that you're slipping: reaching for an impressive word where a plain one is exact. Use the plain one.
