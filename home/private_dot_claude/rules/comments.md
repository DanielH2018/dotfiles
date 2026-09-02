---
paths:
  - "**/*.py"
  - "**/*.pyi"
  - "**/*.go"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.kts"
  - "**/*.rs"
  - "**/*.sh"
  - "**/*.bash"
  - "**/*.zsh"
  - "**/*.sql"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mts"
  - "**/*.cts"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/*.md"
---
Comments and doc comments, the part every language shares. Adapted from Google's style
guides (<https://google.github.io/styleguide/>). The per-language rule file carries the
syntax, the required sections and where a doc comment is mandatory; this file is what those
have in common, so it is not repeated there.

- **Two kinds of comment, two audiences.** A doc comment (docstring, Javadoc, KDoc, JSDoc,
  rustdoc `///`, a shell function header) is written for the caller, and tools extract it.
  An implementation comment (`#`, `//`) is written for the next person editing the body.
  Never use doc-comment syntax for an implementation note, and never bury an interface
  contract in a `//` inside the body.
- **A doc comment lets the reader call the thing without reading its body.** It states what
  the thing does, what it takes, what it returns, what it raises, and any obligation it puts
  on the caller: a lock to hold, a resource to release, whether it is safe to call
  concurrently. Google's Go guide names these last three as the facts docs most often omit.
- **Document the contract, not the code.** Skip a doc comment that only restates the
  signature when the name already says it (`getFoo()` returning foo). Keep it when a typical
  reader needs a term explained, such as what "canonical name" means.
- **Implementation comments explain why, on the code that needs it.** Comment the tricky,
  non-obvious or surprising part, the part you would have to explain in review. Assume the
  reader knows the language better than they know this code, and do not describe what the
  code does. `anti-slop.md`'s no-decorative-comments rule is this rule's floor.
- **Complete sentences, capitalised and punctuated.** A fragment is acceptable only as an
  end-of-line note where the field or variable name is the subject (`// lines per page`).
- **Summary first.** A doc comment opens with one summary line, then a blank line, then the
  detail. Use the descriptive third person ("Fetches rows from Bigtable") or the imperative
  ("Fetch rows from Bigtable"), and keep one form per file.
- **No boxes.** Do not frame a comment in asterisks, dashes or rulers. The shell function
  header is the one Google-sanctioned exception, and it stays in shell.
- **Name an opaque argument at the call site.** `render(/* shouldRender= */ true)` in
  Java, Kotlin, JS and TS; a keyword argument in Python; a named variable in Go and Rust.
- **TODO format is `TODO: <link> - <explanation>`.** Link an issue or bug, not a person. A
  TODO that waits on a future event names the date or the event. Google's older guides
  (shell among them) use `TODO(username):`; write the link form in new code and match the
  file's existing form otherwise.
- **The comment changes in the same edit as the code it describes.** A stale comment costs
  more than none, so delete one you cannot keep true rather than leave it.
- **Wrap at the file's existing width.** Google fixes no comment line length; 80 or 100 are
  both common, and consistency within a file matters more than the number.
