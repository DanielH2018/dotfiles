---
paths:
  - "**/*.go"
---
- Use `go vet` and `gofmt`; follow standard Go project layout
- Errors are values — always handle them, never discard with `_`
- Use `context.Context` as first parameter for functions that do I/O
- Tests use `testing` stdlib + testify assertions where already in use
- Prefer table-driven tests
