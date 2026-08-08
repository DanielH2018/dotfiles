"""Argument parsing, and the parse/walk/render sequence."""

import argparse
import ast
import json
import os
import signal
import sys
import time

from _jsonq.documents import _install_timeout, _load, _render
from _jsonq.errors import JsonqError, _Break, _Continue
from _jsonq.functions import _SECTIONS, FUNCTIONS
from _jsonq.interp import _EXPR_HANDLERS, _INERT, _STMT_HANDLERS, _Interp
from _jsonq.limits import DEFAULT_TIMEOUT, MAX_OUTPUT_BYTES, MAX_SOURCE_BYTES, PROG
from _jsonq.validate import _bindings, _validate

# Where the reduction counter appends. Fixed, and no flag sets it — the same
# reason otelq hardcodes its hosts. A settable path would turn a tool that
# carries a blanket allow rule into a write-anywhere primitive.
METRICS_DIR = os.path.join(
    os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"),
    "claude-metrics")
METRICS_PATH = os.path.join(METRICS_DIR, "filters.jsonl")
MAX_METRICS_BYTES = 5 * 1024 * 1024


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


def _record_reduction(files, source, text):
    """Append one line: bytes read in, bytes printed out.

    This is the only honest reduction figure available anywhere. Claude Code's
    telemetry records what jsonq *printed* but never what it *read*, so the
    ratio cannot be reconstructed after the fact — and counting invocations
    instead would measure how often the tool is used, not what it filtered out.

    The expression is recorded only by length. A filter literal can carry values
    lifted out of whatever is being queried, and a metrics file is a poor place
    to learn that.

    Nothing here is reachable from a query: the interpreter has no attribute
    access and no open(), so this runs in the CLI layer or not at all. Every
    failure is swallowed, because a counter that breaks a query is worse than no
    counter.
    """
    if os.environ.get("JSONQ_METRICS") == "0":
        return
    try:
        # `in` is None for stdin: the bytes are consumed before they could be
        # sized, and recording zero would understate every ratio that follows.
        read = (sum(os.path.getsize(os.path.expanduser(f)) for f in files)
                if files else None)
        record = {
            "t": int(time.time()),
            "tool": PROG,
            "in": read,
            "out": len(text.encode("utf-8")),
            "expr_len": len(source),
            "files": len(files),
        }
        os.makedirs(METRICS_DIR, exist_ok=True)
        if (os.path.exists(METRICS_PATH)
                and os.path.getsize(METRICS_PATH) >= MAX_METRICS_BYTES):
            # One generation back, then start fresh. Unbounded growth on a path
            # nothing prunes is how a counter becomes a disk problem.
            os.replace(METRICS_PATH, METRICS_PATH + ".1")
        with open(METRICS_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except (OSError, ValueError):
        return


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
        add_help=False,
        description="Query JSON with a closed subset of Python syntax.",
        epilog="Bound names: d (first document), d1..dN (per input), ds (all). "
               "There is no attribute access — see --functions for what is callable.",
    )
    # Arguments go on groups, and -h is added by hand rather than by add_help,
    # because `_ActionsContainer.add_argument` guards its metavar validation with
    # `hasattr(self, "_get_validation_formatter")` — a method ArgumentParser has
    # and a group does not. Registering on the parser therefore builds a
    # HelpFormatter here, which imports shutil and _colorize and, behind them,
    # dataclasses and inspect: 16ms of a 37ms parse, to lay out help that is
    # almost never printed. A group skips it and parses identically.
    #
    # The two groups are named for argparse's own defaults and created in its own
    # order, so --help renders byte-for-byte what add_help=True produced.
    #
    # Not a bug waiting on upstream. CPython gh-142267 cured the *repeated* build
    # by caching the formatter (that cache is already here) but left the first one
    # eager, having weighed and rejected a lazy _set_color as unbackportable.
    positionals = parser.add_argument_group("positional arguments")
    opts = parser.add_argument_group("options")
    opts.add_argument("-h", "--help", action="help", default=argparse.SUPPRESS,
                      help="show this help message and exit")
    opts.add_argument("-r", "--raw", action="store_true",
                      help="print string results unquoted, one per line for a list")
    opts.add_argument("--indent", type=int, default=None,
                      help="pretty-print with N spaces (default: compact)")
    opts.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                      help=f"wall-clock cap in seconds (default: {DEFAULT_TIMEOUT})")
    opts.add_argument("-s", "--script", metavar="SRC",
                      help="multi-statement mode; assign the result to `out`")
    opts.add_argument("--jsonl", action="store_true",
                      help="parse each input as JSON Lines; `d` is the record list")
    opts.add_argument("--functions", action="store_true",
                      help="print every callable name and exit")
    positionals.add_argument("args", nargs="*", metavar="EXPR [FILE...]",
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
        text = run(source, files, mode, ns.raw, ns.indent, ns.timeout, ns.jsonl)
        print(text)
        # After the print, so a query that failed records nothing — it
        # filtered nothing, and counting it would dilute the ratio.
        _record_reduction(files, source, text)
    except JsonqError as exc:
        print(f"{PROG}: {exc}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        return 0
    except Exception as exc:  # the query itself blew up (KeyError, TypeError, ...)
        print(f"{PROG}: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0
