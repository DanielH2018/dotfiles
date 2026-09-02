---
paths:
  - "**/*.go"
---
- Use `go vet` and `gofmt`; follow standard Go project layout
- Errors are values — always handle them, never discard with `_`
- Use `context.Context` as first parameter for functions that do I/O
- Tests use `testing` stdlib + testify assertions where already in use
- Prefer table-driven tests

## Comments and doc comments

Adapted from Google's Go style guide, the *Commentary* decisions
(<https://google.github.io/styleguide/go/decisions#commentary>) and the *Documentation*
best practices (<https://google.github.io/styleguide/go/best-practices#documentation>).
The shared rules are in `comments.md`.

- **Every exported top-level name has a doc comment,** and so does an unexported type or
  function whose behaviour or meaning is not obvious. Write unexported doc comments in the
  same form as exported ones so a later export needs no rewrite.
- **A doc comment is a complete sentence that begins with the name:** `// Encode writes the
  JSON encoding of req to w.` An article may precede it: `// A Request represents ...`.
- **The package comment sits directly above `package`,** no blank line between, in exactly
  one file per package: `// Package math provides basic constants and mathematical
  functions.` For `package main`, the binary name replaces the package name.
- **A struct field's end-of-line comment may be a fragment** with the field as its subject:
  `PageLength int // lines per page when printing (optional; default: 20)`.
- **Document what the reader cannot infer,** not every parameter. In particular:
  - *Context:* cancellation interrupting the call is assumed. Document it when the call
    returns an error other than `ctx.Err()` on cancellation, when something else can
    interrupt it, or when it expects a deadline, a lineage, or an attached value.
  - *Concurrency:* a read-only operation is assumed safe for concurrent use and a mutating
    one is not. Document when that is unclear, when the API synchronises internally, or when
    a user-implemented interface has a concurrency requirement.
  - *Cleanup:* say what the caller must release and how, with an example when the sequence
    is not obvious. Undocumented cleanup is how resources leak.
  - *Errors:* name the sentinel values and error types a caller can handle
    programmatically, and say whether an error type uses a pointer receiver. Package-wide
    error conventions go in the package comment.
- **Prefer a runnable `Example` in a `_test.go` file** over usage shown in a comment; it
  appears in godoc and is compiled. Code in a comment is indented so godoc renders it
  verbatim.
- **Godoc syntax:** a blank line separates paragraphs, an indented line is verbatim, and a
  lone capitalised line followed by a paragraph is a heading. Preview with the doc server
  before review.
- **Name result parameters only when it aids the reader** of the signature: several results
  of one type, or a name that says what the caller must do (`cancel func()`). Never for a
  naked return.
- **TODO:** `// TODO: <link> - <explanation>`.
