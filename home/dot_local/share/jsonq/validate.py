"""The pre-flight pass. Not the boundary; see the docstring
on _validate."""

import ast

from _jsonq.errors import JsonqError, _unsupported


def _bindings(tree):
    """Names the source itself introduces — assignment targets, loop and
    comprehension variables, lambda parameters. Collected up front so a later
    read of one isn't mistaken for a reach at an undeclared global."""
    bound = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            bound.add(node.id)
        elif isinstance(node, ast.arg):
            bound.add(node.arg)
    return bound


def _validate(tree, allowed_nodes, allowed_names):
    """A courtesy pass. It is NOT the boundary.

    The boundary is _Interp: a node type with no handler cannot run, and the
    only names in scope are the ones run() puts there. This pass exists so an
    unsupported construct or a typo is reported up front, with a hint, rather
    than surfacing part-way through a query. Its node set is *derived from* the
    dispatch tables rather than written out again, so the two cannot drift.

    Do not add a rule here and assume it protects anything. The way to refuse a
    construct is to not give it a handler.
    """
    for node in ast.walk(tree):
        if type(node) not in allowed_nodes:
            raise JsonqError(_unsupported(node))

        if isinstance(node, ast.Name):
            # Redundant now that there is no attribute access and nothing
            # dunder-bearing is in scope, but it costs one comparison and keeps
            # the error for `__builtins__` legible.
            if node.id.startswith("_"):
                raise JsonqError(
                    f"name {node.id!r} is not allowed (leading underscore)"
                )
            if isinstance(node.ctx, ast.Load) and node.id not in allowed_names:
                raise JsonqError(f"name {node.id!r} is not allowed")
        elif isinstance(node, ast.arg) and node.arg.startswith("_"):
            raise JsonqError(
                f"parameter {node.arg!r} is not allowed (leading underscore)"
            )
