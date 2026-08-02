"""The function table. Every entry maps JSON values to JSON values.

_CALLABLE_IDS is built here, beside FUNCTIONS, and must stay here: the
identity check it backs is sound only because FUNCTIONS holds a strong
reference to every entry for the life of the process."""

import json
import math
import re
import statistics

from _jsonq.errors import JsonqError
from _jsonq.guards import _int, _pow, _range
from _jsonq.lambdas import _Lambda

# ---------------------------------------------------------------------------
# Rendering helpers, defined before the table that binds them.
# ---------------------------------------------------------------------------


def _default(obj):
    """Coerce the few non-JSON types a valid query can plausibly return."""
    if isinstance(obj, (set, frozenset)):
        try:
            return sorted(obj)
        except TypeError:  # mixed types have no total order
            return sorted(obj, key=repr)
    if isinstance(obj, tuple):
        return list(obj)
    if isinstance(obj, (bytes, bytearray)):
        return obj.decode("utf-8", "replace")
    if isinstance(obj, _Lambda):
        raise TypeError("a lambda is not a result; call it or return its output")
    raise TypeError(f"result of type {type(obj).__name__} is not JSON-serialisable")


def _dumps(value, indent=None):
    separators = None if indent else (",", ":")
    return json.dumps(
        value, default=_default, indent=indent,
        separators=separators, ensure_ascii=False,
    )


def _text(value):
    """String form used by f-strings and -r. JSON spelling, not Python's, so
    `f"{x}"` on a bool gives `true` and on a dict gives `{"a":1}`."""
    return value if isinstance(value, str) else _dumps(value)


def _key(value):
    """A hashable stand-in for an arbitrary JSON value."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return _dumps(value)


# ---------------------------------------------------------------------------
# The function table. Every entry maps JSON values to JSON values.
#
# Real builtins and unbound method descriptors (str.lower and friends) are
# bound directly where the signature already reads well. That is safe for the
# same reason everything else here is: with no attribute access a function
# object is a thing you can call and nothing else — there is no `.__globals__`
# to reach through, because there is no `.`.
#
# `type`, `getattr`, `vars`, `globals`, `dir`, `eval`, `exec`, `open`,
# `compile`, `input` and `format` are deliberately absent. `kind()` is the
# type-name function; `type` stays unbound so the escape suite keeps testing
# for its absence rather than for a lookalike.
# ---------------------------------------------------------------------------


def _kind(value):
    if value is None:
        return "null"
    for cls, name in (
        (bool, "bool"), (int, "int"), (float, "float"), (str, "str"),
        (dict, "dict"), ((list, tuple), "list"), ((set, frozenset), "set"),
    ):
        if isinstance(value, cls):
            return name
    return "unknown"


def _get(container, key, default=None):
    try:
        return container[key]
    except (KeyError, IndexError, TypeError):
        return default


def _merge(*mappings):
    merged = {}
    for mapping in mappings:
        merged.update(mapping)
    return merged


def _join(sep, values):
    return sep.join(_text(v) for v in values)


def _unique(values):
    """Order-preserving dedupe that also works on dicts and lists."""
    seen, out = set(), []
    for value in values:
        marker = _key(value)
        if marker in seen:
            continue
        seen.add(marker)
        out.append(value)
    return out


def _flatten(values):
    out = []
    for value in values:
        if isinstance(value, (list, tuple)):
            out.extend(value)
        else:
            out.append(value)
    return out


def _counter(values):
    counts = {}
    for value in values:
        marker = _key(value)
        counts[marker] = counts.get(marker, 0) + 1
    return counts


def _groupby(values, keyfn):
    groups = {}
    for value in values:
        groups.setdefault(keyfn(value), []).append(value)
    return groups


# Known residual: a catastrophically backtracking pattern runs inside `re`'s C
# loop, where the SIGALRM handler never gets a turn, so --timeout cannot stop it.
# The caps above cover the arithmetic routes to the same problem; this one has no
# cheap fix short of a different regex engine. It costs a hung CLI you can Ctrl-C,
# not an escape, so it is documented rather than mitigated.


def _re_test(pattern, text):
    return re.search(pattern, text) is not None


def _re_search(pattern, text):
    """The matched substring, or null. Returning a match object would be
    useless here — with no attribute access there is no way to ask it anything."""
    found = re.search(pattern, text)
    return found.group(0) if found else None


def _re_groups(pattern, text):
    found = re.search(pattern, text)
    return list(found.groups()) if found else None


def _re_sub(pattern, repl, text, count=0):
    """re.sub, minus its callable-replacement form.

    `re.sub(p, fn, s)` calls fn with a *match object* — a live Python object
    that is not a JSON value, which would put a hole in the claim that the
    reachable graph contains nothing else. Nothing could be done with it today
    (no attribute access, and a lambda cannot assign), but the invariant is
    worth more than the feature.
    """
    if not isinstance(repl, str):
        raise JsonqError("re_sub's replacement must be a string")
    return re.sub(pattern, repl, text, count=count)


_SECTIONS = (
    ("core", {
        "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
        "divmod": divmod, "float": float, "int": _int, "len": len, "list": list,
        "max": max, "min": min, "pow": _pow, "range": _range, "repr": repr,
        "round": round, "set": set, "frozenset": frozenset, "sorted": sorted,
        "str": str, "sum": sum, "tuple": tuple, "kind": _kind,
        "enumerate": lambda *a: [list(p) for p in enumerate(*a)],
        "filter": lambda f, xs: list(filter(f, xs)),
        "map": lambda f, *xs: list(map(f, *xs)),
        "reversed": lambda xs: list(reversed(xs)),
        "zip": lambda *xs: [list(p) for p in zip(*xs)],
    }),
    ("dicts", {
        "keys": lambda d: list(d.keys()),
        "values": lambda d: list(d.values()),
        "items": lambda d: [[k, v] for k, v in d.items()],
        "get": _get, "merge": _merge,
    }),
    ("strings", {
        "lower": str.lower, "upper": str.upper, "strip": str.strip,
        "lstrip": str.lstrip, "rstrip": str.rstrip, "replace": str.replace,
        "startswith": str.startswith, "endswith": str.endswith,
        "split": str.split, "rsplit": str.rsplit, "splitlines": str.splitlines,
        "find": str.find, "join": _join,
    }),
    ("regex", {
        "re_test": _re_test, "re_search": _re_search, "re_groups": _re_groups,
        "re_findall": re.findall, "re_sub": _re_sub, "re_split": re.split,
    }),
    ("numbers", {
        "floor": math.floor, "ceil": math.ceil, "sqrt": math.sqrt,
        "log": math.log, "log10": math.log10, "exp": math.exp,
        "mean": statistics.mean, "median": statistics.median,
    }),
    ("collections", {
        "unique": _unique, "flatten": _flatten, "counter": _counter,
        "groupby": _groupby,
    }),
    ("json", {
        "dumps": _dumps, "loads": json.loads,
    }),
)

FUNCTIONS = {name: fn for _, group in _SECTIONS for name, fn in group.items()}

# Identity, not equality: a JSON value can reach the callee position, and
# `{...} in some_set` would raise TypeError before we could say so. Comparing
# ids is sound here only because FUNCTIONS holds a strong reference to every
# entry for the life of the process, so none of these ids is ever freed and
# handed to a different object. Do not build this set from a temporary.
_CALLABLE_IDS = frozenset(id(fn) for fn in FUNCTIONS.values())
