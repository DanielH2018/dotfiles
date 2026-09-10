"""Per-check modules: one pure function from a segment to a verdict.

Deliberately non-empty. chezmoi skips a zero-byte source file unless its name
carries the `empty_` prefix, so an empty `__init__.py` here deployed nothing and
`claude_guard.checks` resolved as a PEP 420 namespace package in production while
the tests, run from this source tree, imported a regular package. A namespace
package is also the shadowable one: it merges every matching directory on
sys.path, where a regular package binds to the first. The shim passes `-P` and
`-S` so nothing caller-controlled reaches sys.path, but the deployed tree must
match the tested tree for the shadow census to mean what it claims.
"""
