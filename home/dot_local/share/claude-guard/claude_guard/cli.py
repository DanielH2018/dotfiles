"""claude-guard command line.

    claude-guard permission-request        # hook entry: hook JSON on stdin, allow line or
                                            # nothing on stdout
    claude-guard segment --json            # decomposition of the command on stdin,
                                            # cmdparse.sh's shape
    claude-guard explain "<command>"       # the segments, and the decision with its rule
    claude-guard replay <jsonl> --judge    # allow count and the allowed commands, judged
                                            # against the deployed settings
    claude-guard pre-tool-use              # hook entry: hook JSON on stdin, deny/ask JSON
                                            # or nothing on stdout
    claude-guard replay <jsonl> --deny     # deny/ask/allow verdict per record

Both hook entries are live-only: slice 6 retired the allow side's shadow mode (2026-09-17)
and the deny side's (2026-09-18, with the bash hook it shadowed) -- see claude_guard.hook.
`segment --json` exists for tests and to inspect the segmenter's shape, never for the hook path.
"""

import argparse
import json
import os
import sys
from pathlib import Path

from claude_guard.deny import deny
from claude_guard.hook import ASK_JSON, permission_request, pre_tool_use
from claude_guard.judge import judge
from claude_guard.rules import load_rules
from claude_guard.segment import Parsed, parse
from claude_guard.tables import scratch_roots


def to_json_shape(p: Parsed) -> dict:
    """The dict `cmdparse.sh --json` prints, so the two can be compared field for field."""
    return {
        "status": p.status,
        "nseg": len(p.segments),
        "seg": [s.text for s in p.segments],
        "sep": [s.sep for s in p.segments],
        "heredoc": ["\x1f".join(s.heredocs) for s in p.segments],
        "subseg": list(p.substitutions),
    }


def cmd_segment(args: argparse.Namespace) -> int:
    command = sys.stdin.read()
    print(json.dumps(to_json_shape(parse(command))))
    return 0


def cmd_explain(args: argparse.Namespace) -> int:
    p = parse(args.command)
    print(f"status: {p.status}")
    rules = load_rules()
    roots = scratch_roots(os.environ.get("HOME", ""), os.environ.get("TMPDIR"))
    cwd = args.cwd if args.cwd is not None else os.getcwd()
    d = judge(args.command, rules, roots, cwd)
    reasons = iter(d.reasons)
    for i, seg in enumerate(p.segments):
        text = seg.text.strip()
        # judge() records one reason per non-empty segment, up to and including the one
        # that refused; segments after that carry none.
        reason = next(reasons, None) if text else None
        suffix = f" -> {reason}" if reason else ""
        print(f"[{i}] sep={seg.sep} heredocs={len(seg.heredocs)}: {text}{suffix}")
    for i, sub in enumerate(p.substitutions):
        print(f"sub[{i}]: {sub.strip()}")
    print(f"decision: {'allow' if d.allow else 'defer'} rule={d.rule}")
    return 0 if p.ok else 1


def _records(path: str) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def _head(command: str) -> str:
    return command.replace("\n", "⏎")[:90]


def cmd_replay(args: argparse.Namespace) -> int:
    chosen = sum((args.judge, args.deny))
    if chosen != 1:
        print("replay: pass exactly one of --judge or --deny", file=sys.stderr)
        return 2
    records = _records(args.corpus)
    if args.deny:
        return _replay_deny(records)
    return _replay_judge(records)


def _replay_judge(records: list[dict]) -> int:
    """Judge every record against the deployed settings; print the allowed ones and the
    tally. This is the slice-3 cutover gate (spec row 3, `ALLOW 84/1058` on the prompted
    corpus) with its bash-chain comparison removed in slice 6 -- every BASH_CHAIN member it
    compared against was already deleted from disk in slice 3, so `--compare-hooks` was
    computing an AGREE tally against hooks that could not run. The ALLOW tally alone is
    still the load-bearing gate; see claude_guard.hook's module docstring."""
    home = os.environ.get("HOME", "")
    roots = scratch_roots(home, os.environ.get("TMPDIR"))
    allowed = 0
    for i, rec in enumerate(records):
        # Fix round 1, F1: the corpus's own record shape is {command, cwd} (module
        # docstring above) -- a record missing `command` or `cwd` is malformed, and a
        # silent "" default used to get `cwd` wrong twice: it read as the hook PROCESS's
        # own cwd before clean_reset_safe refused a falsy cwd outright, and even now it
        # would just silently under-count ALLOW for every cwd-sensitive shape in a
        # malformed corpus rather than surfacing the bad record. Indexing raises loudly
        # instead of defaulting to "" -- fail-closed, same posture as clean_reset_safe's
        # own refusal. Item 5 (fix round 2): an uncaught KeyError here used to escape
        # main() as a bare traceback, silently dropping the partial ALLOW tally a gate
        # reading this command's output needs even on a malformed record. Catch it, name
        # the record and the missing key, and still print what was tallied so far.
        try:
            command = rec["command"]
            cwd = rec["cwd"]
        except KeyError as exc:
            print(f"MALFORMED RECORD {i}: missing key {exc.args[0]!r}", file=sys.stderr)
            print(f"ALLOW {allowed}/{len(records)}")
            return 1
        d = judge(command, load_rules(home=home, project_dir=cwd), roots, cwd)
        if d.allow:
            allowed += 1
            print(f"ALLOW: {_head(command)}")
    print(f"ALLOW {allowed}/{len(records)}")
    return 0


def _replay_deny(records: list[dict]) -> int:
    """Run the deny rules over the corpus and print each non-none verdict. The slice-4
    cutover gate ran this with `--compare-hook` against block-dangerous-bash.sh (`AGREE
    1058/1058` on the prompted corpus, `AGREE 281/281` on the vectors); slice 6 deleted that
    hook, so the agreement half is gone and the vector file (`tests/test_deny.py`) is the
    rules' oracle."""
    for rec in records:
        command = rec["command"]
        cwd = rec.get("cwd", "")
        v = deny(command, cwd, {**os.environ})
        if v.kind != "none":
            print(f"{v.kind.upper()} {v.rule}: {_head(command)}")
    return 0


def cmd_permission_request(args: argparse.Namespace) -> int:
    # The allow-path failure contract: nothing on stdout, exit 0, whatever happens.
    try:
        out = permission_request(sys.stdin.read(), os.environ)
    except Exception:
        return 0
    if out:
        print(out)
    return 0


def cmd_pre_tool_use(args: argparse.Namespace) -> int:
    # The deny-path failure contract: an exception reaching here prints ask, exit 0.
    try:
        out = pre_tool_use(sys.stdin.read(), os.environ)
    except Exception:
        out = ASK_JSON
    if out:
        print(out)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="claude-guard", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("permission-request", help="PermissionRequest hook entry (stdin JSON)")
    p.set_defaults(fn=cmd_permission_request)

    pt = sub.add_parser("pre-tool-use", help="PreToolUse hook entry (stdin JSON): deny rules")
    pt.set_defaults(fn=cmd_pre_tool_use)

    s = sub.add_parser("segment", help="decompose the command on stdin")
    s.add_argument(
        "--json", action="store_true", required=True, help="print cmdparse.sh's JSON shape"
    )
    s.set_defaults(fn=cmd_segment)

    e = sub.add_parser("explain", help="show how a command segments")
    e.add_argument("command")
    e.add_argument(
        "--cwd",
        default=None,
        help="session cwd for git-reset/heredoc-write confinement (default: this process's cwd)",
    )
    e.set_defaults(fn=cmd_explain)

    r = sub.add_parser("replay", help="run a JSONL of {command, cwd} records")
    r.add_argument("corpus")
    r.add_argument(
        "--judge",
        action="store_true",
        help="judge every record against the deployed settings; print the allowed ones",
    )
    r.add_argument(
        "--deny",
        action="store_true",
        help="run the deny rules on every record; print each non-none verdict",
    )
    r.set_defaults(fn=cmd_replay)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
