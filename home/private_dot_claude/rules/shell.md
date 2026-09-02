---
paths:
  - "**/*.sh"
  - "**/*.bash"
  - "**/*.zsh"
---
- Use `set -u` at minimum at the top of scripts; add `-e`/`pipefail` too unless the script is sourced by a caller, or a non-zero exit from a sub-step has meaning the script needs to handle itself (both common in Claude Code hooks)
- Quote all variable expansions: `"$var"` not `$var`
- Use `[[ ]]` over `[ ]` for conditionals
- Prefer `$(command)` over backticks
- Use shellcheck-clean patterns; the lint hook runs shellcheck automatically

## Comments

Adapted from the *Comments* section of Google's shell style guide
(<https://google.github.io/styleguide/shellguide.html#s4-comments>). The shared rules are in
`comments.md`.

- **Every file opens with a header comment** after the shebang giving a brief overview of
  what it does. Copyright and author lines are optional.

  ```bash
  #!/bin/bash
  #
  # Perform hot backups of Oracle databases.
  ```

- **A function that is not both short and obvious has a header comment,** and every
  function in a sourced library has one regardless. It lets a reader use the function
  without reading its body, and it lists, in this order and labelled: a description,
  `Globals:` (variables read and modified), `Arguments:`, `Outputs:` (STDOUT and STDERR),
  `Returns:` (only a value other than the last command's exit status). This is the one
  place a `#####` ruler is Google style.

  ```bash
  #######################################
  # Cleanup files from the backup directory.
  # Globals:
  #   BACKUP_DIR
  #   ORACLE_SID
  # Arguments:
  #   None
  #######################################
  function cleanup() {
    …
  }
  ```

- **Implementation comments** go on the tricky, non-obvious or important part only. Do not
  comment everything.
- **A comment line beginning with the word `shellcheck` is parsed as a directive,** and a
  `disable=` placed before the first command applies to the whole file. Word such a comment
  differently or move it.
- **TODO:** Google's shell guide still writes `# TODO(username): ... (bug ####)`. Write the
  link form from `comments.md` in new code, and match the file's existing form otherwise.
