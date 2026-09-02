---
paths:
  - "**/*.rs"
---
- Use `cargo fmt` and `cargo clippy`
- Prefer `?` operator over explicit match on Result/Option
- Use `thiserror` for library errors, `anyhow` for application errors (match existing crate usage)
- Tests go in a `#[cfg(test)] mod tests` block at the bottom of each file

## Comments and doc comments

Google publishes no Rust style guide. These rules apply `comments.md` through rustdoc's
conventions (<https://doc.rust-lang.org/rustdoc/how-to-write-documentation.html>) and the
Rust API guidelines' documentation checklist
(<https://rust-lang.github.io/api-guidelines/documentation.html>).

- **`///` documents the item below it; `//!` documents the enclosing crate or module** from
  its first line. `//` is for implementation notes. Never put a contract in a `//`.
- **Every public item has a doc comment:** a one-line summary, a blank line, then detail.
  Document a private item when its behaviour is not obvious, in the same form.
- **Sections are `#`-headed, in this order and only when they apply:** `# Examples`
  (nearly always; a doc example is compiled and run by `cargo test`), `# Errors` for a
  function returning `Result`, saying which conditions yield which error, `# Panics` for any
  panic reachable from a caller, `# Safety` on every `unsafe fn` and `unsafe trait`, stating
  the invariants the caller upholds.
- **Doc comments are Markdown.** Link an item with `[`Name`]` intra-doc syntax, not a URL.
- **Do not repeat the type system.** A function's signature already states its arguments and
  return type; the doc comment states semantics, ownership expectations that a signature
  cannot express, and thread-safety when `Send`/`Sync` alone does not settle it.
- **Attributes before the doc comment are a mistake:** `#[derive(...)]` and `#[must_use]`
  go directly above the item, below the `///` block.
- **TODO:** `// TODO: <link> - <explanation>`.
