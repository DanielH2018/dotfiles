---
paths:
  - "**/*.sh"
  - "**/*.bash"
---
- Use `set -euo pipefail` at the top of scripts
- Quote all variable expansions: `"$var"` not `$var`
- Use `[[ ]]` over `[ ]` for conditionals
- Prefer `$(command)` over backticks
- Use shellcheck-clean patterns; the lint hook runs shellcheck automatically
