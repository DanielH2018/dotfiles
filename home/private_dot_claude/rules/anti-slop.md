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
  - "**/*.kts"
  - "**/*.mts"
  - "**/*.cts"
  - "**/*.zsh"
  - "**/*.rs"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.sh"
  - "**/*.bash"
  - "**/*.pyi"
  - "**/*.sql"
---
Write code that reads like a person wrote it, not a model. This applies to any code you add or
change here. This file covers names, strings, logs and errors; `comments.md` covers comments.

- **Name for what it is.** A function that fetches a user is `fetchUser`, not
  `retrieveUserEntity`; a retry counter is `retries`, not `attemptOrchestrator`. Don't reach for
  a metaphor or a thesaurus word, and don't name a vague `Manager`/`Helper`/`Handler` when a
  concrete noun exists.
- **Plain strings, logs, and errors.** Say what happened in concrete terms. Never write
  "gracefully orchestrating" or "magic happens here", and never decorate a message with an
  emoji.

The tell that you're slipping: reaching for an impressive word where a plain one is exact. Use
the plain one.
