---
paths:
  - "**/*.rs"
---
- Use `cargo fmt` and `cargo clippy`
- Prefer `?` operator over explicit match on Result/Option
- Use `thiserror` for library errors, `anyhow` for application errors (match existing crate usage)
- Tests go in a `#[cfg(test)] mod tests` block at the bottom of each file
