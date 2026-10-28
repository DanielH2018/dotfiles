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
- **A mandate in a per-language file applies only where the repo already follows it.**
  Before adding a file header, a function header or a doc comment that a per-language rule
  requires, check the neighbouring files. If they do not carry one, match them instead.
- **The default is no implementation comment.** Add one only when a maintainer who has the
  code, but not the PR, the ticket or this conversation, would get something wrong without
  it: a constraint the code cannot express, a non-obvious invariant, a trap. Assume the
  reader knows the language better than they know this code. If a better name or a smaller
  function would carry the point, change the code instead.
- **Write for the next maintainer, not for the reviewer.** Anything that explains the change
  belongs in the commit message or the PR body: what the code replaces, what it used to do,
  how it matches an old implementation, which ticket asked for it, the SHA of a dependency
  it imitates. Do not write "previously", "now", "the old callers", "added for" or
  "reproduces what X did", and do not name a file that is not in this repo.
- **One line is the budget.** Go past one line only to state a constraint that needs the
  space. The prose rules in CLAUDE.md govern documents, not code comments, so a short
  fragment is better than two full sentences.
- **No decorative comments.** Do not restate the code (`// increment i`), label a section
  (`// Validate input`), narrate the obvious, address the reader ("Note that…"), or write
  flavor text.
- **Remove what you added to get the code working.** Debug comments, commented-out code and
  "TODO: remove" lines do not survive into the commit.
- **Capitalise and punctuate a sentence.** A fragment is fine, most of all as an
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
  more than none, so delete one you cannot keep true rather than leave it. Leave comments
  on code you did not change alone, unless your change made one false.
- **Wrap at the file's existing width.** Google fixes no comment line length; 80 or 100 are
  both common, and consistency within a file matters more than the number.
