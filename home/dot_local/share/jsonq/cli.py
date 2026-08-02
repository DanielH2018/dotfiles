"""Argument parsing, and the parse/walk/render sequence."""

import argparse
import ast
import signal
import sys

from _jsonq.documents import _install_timeout, _load, _render
from _jsonq.errors import JsonqError, _Break, _Continue
from _jsonq.functions import _SECTIONS, FUNCTIONS
from _jsonq.interp import _EXPR_HANDLERS, _INERT, _STMT_HANDLERS, _Interp
from _jsonq.limits import DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES, MAX_SOURCE_BYTES, PROG
from _jsonq.validate import _bindings, _validate


def run(source, files, mode, raw=False, indent=None, timeout=DEFAULT_TIMEOUT,
        jsonl=False):
    """Parse, walk, render. Split out from main() so tests can call it."""
    if len(source) > MAX_SOURCE_BYTES:
        raise JsonqError("expression is too long")

    docs = [_load(f, jsonl) for f in files] if files else [_load("-", jsonl)]

    env = dict(FUNCTIONS)
    env["d"] = docs[0]
    env["ds"] = docs
    for i, doc in enumerate(docs, 1):
        env[f"d{i}"] = doc

    try:
        tree = ast.parse(source, mode=mode)
    except SyntaxError as exc:
        raise JsonqError(f"syntax error: {exc.msg}") from None
    except (RecursionError, MemoryError):
        raise JsonqError("expression is nested too deeply to parse") from None

    allowed = set(_EXPR_HANDLERS) | _INERT
    if mode == "exec":
        allowed |= set(_STMT_HANDLERS)
    _validate(tree, allowed, set(env) | _bindings(tree))

    interp = _Interp(env)
    _install_timeout(timeout)
    try:
        if mode == "eval":
            result = interp.visit(tree, env)
        else:
            interp.execute(tree, env)
            if "out" not in env:
                raise JsonqError("--script must assign its result to `out`")
            result = env["out"]
    except (_Break, _Continue):
        raise JsonqError("break outside a loop") from None
    except RecursionError:
        raise JsonqError("expression recursed too deeply") from None
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)

    text = _render(result, raw, indent)
    if len(text.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise JsonqError("output exceeds the 10 MB cap; narrow the expression")
    return text


def _function_table():
    lines = [
        "jsonq has no attribute access, so methods are spelled as functions.",
        "Everything callable is listed here; nothing else is reachable.",
        "",
    ]
    for title, group in _SECTIONS:
        lines.append(f"{title}:")
        names = sorted(group)
        for start in range(0, len(names), 6):
            lines.append("  " + "  ".join(names[start:start + 6]))
        lines.append("")
    lines.append("Bound names: d (first document), d1..dN (per input), ds (all).")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog=PROG,
        description="Query JSON with a closed subset of Python syntax.",
        epilog="Bound names: d (first document), d1..dN (per input), ds (all). "
               "There is no attribute access — see --functions for what is callable.",
    )
    parser.add_argument("-r", "--raw", action="store_true",
                        help="print string results unquoted, one per line for a list")
    parser.add_argument("--indent", type=int, default=None,
                        help="pretty-print with N spaces (default: compact)")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help=f"wall-clock cap in seconds (default: {DEFAULT_TIMEOUT})")
    parser.add_argument("-s", "--script", metavar="SRC",
                        help="multi-statement mode; assign the result to `out`")
    parser.add_argument("--jsonl", action="store_true",
                        help="parse each input as JSON Lines; `d` is the record list")
    parser.add_argument("--functions", action="store_true",
                        help="print every callable name and exit")
    parser.add_argument("args", nargs="*", metavar="EXPR [FILE...]",
                        help="expression, then input files (stdin if none)")
    ns = parser.parse_args(argv)

    if ns.functions:
        print(_function_table())
        return 0

    if ns.script is not None:
        source, files, mode = ns.script, list(ns.args), "exec"
    else:
        if not ns.args:
            parser.error("an expression is required")
        source, files, mode = ns.args[0], list(ns.args[1:]), "eval"

    try:
        print(run(source, files, mode, ns.raw, ns.indent, ns.timeout, ns.jsonl))
    except JsonqError as exc:
        print(f"{PROG}: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0
    except Exception as exc:  # the query itself blew up (KeyError, TypeError, ...)
        print(f"{PROG}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0
