"""Refusals — the exception types, and the messages for constructs that have
no handler. Kept free of every other module so both the interpreter and the
pre-flight pass can import it without a cycle."""

import ast


class JsonqError(Exception):
    """A refusal we raise ourselves — always reported without a traceback."""


class _Break(Exception):
    """Internal control flow for --script. Never escapes run()."""


class _Continue(Exception):
    """Internal control flow for --script. Never escapes run()."""


def _nodes(*names):
    """Resolve AST class names, skipping any this Python doesn't define.

    Node types come and go across versions (ast.Index died in 3.9), so building
    the set by name keeps a missing type from being an import-time crash.
    Skipping an absent name cannot widen anything: absent means unusable.
    """
    return {getattr(ast, n) for n in names if getattr(ast, n, None) is not None}


# Full replacement messages for the constructs people actually reach for. Every
# other unsupported node falls back to naming itself, which is enough to look up.
_MESSAGES = {
    "Attribute": (
        "attribute access (`x.y`) is not part of jsonq's grammar — there are no "
        "methods and no modules. Use the function table instead: keys(d) for "
        "d.keys(), startswith(s, p) for s.startswith(p), re_findall(p, s) for "
        "re.findall(p, s). Run `jsonq --functions` for the full list"
    ),
    "Import": "jsonq cannot import anything",
    "ImportFrom": "jsonq cannot import anything",
    "FunctionDef": "jsonq has no `def`; use a lambda",
    "AsyncFunctionDef": "jsonq has no `def`; use a lambda",
    "ClassDef": "jsonq has no classes",
    "NamedExpr": "jsonq has no `:=`; assign in a --script statement instead",
    "Await": "jsonq has nothing asynchronous to await",
    "Yield": "jsonq has no generators",
    "Delete": "jsonq has no `del`; build the value you want instead",
    "Try": "jsonq has no exception handling",
    "Raise": "jsonq has no `raise`",
    "With": "jsonq has no `with`, and nothing to open",
    "Global": "jsonq has one scope; `global` would mean nothing",
    "Nonlocal": "jsonq has one scope; `nonlocal` would mean nothing",
}


def _unsupported(node):
    name = type(node).__name__
    return _MESSAGES.get(name, f"{name} is not part of jsonq's grammar")
