"""claude-guard command line.

    claude-guard permission-request        # hook entry: hook JSON on stdin, allow line or
                                            # nothing on stdout; shadow when CLAUDE_GUARD_SHADOW=1
    claude-guard shadow-report [--log P]   # agree / python-only / bash-only counts from the log
    claude-guard segment --json            # decomposition of the command on stdin,
                                            # cmdparse.sh's shape
    claude-guard explain "<command>"       # the segments, and the decision with its rule
    claude-guard replay <jsonl> --compare-bash <cmdparse.sh>
                                            # parity of every {command, cwd} record
                                            # against the bash segmenter
    claude-guard replay <jsonl> --judge [--compare-hooks DIR]
                                            # allow count and the allowed commands; with
                                            # --compare-hooks, agreement with the bash chain

`segment --json` exists for tests and the parity gate, never for the hook path. The
`pre-tool-use` entry point arrives with deny.py in slice 4.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from claude_guard.hook import LOG_NAME, bash_chain_allows, permission_request, summarize
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
    d = judge(args.command, rules, roots)
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


def bash_parse(cmdparse: Path, command: str) -> dict:
    out = subprocess.run(
        ["bash", str(cmdparse), "--json"], input=command, capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)


def _comparable(shape: dict) -> dict:
    """Normalise a `to_json_shape`-style dict for parity comparison.

    Drops `nseg` (it is `len(seg)`, redundant with `seg`). Replaces `heredoc` with a
    list-of-lists of its non-empty bodies: the bash side's `\x1f`-joined heredoc field
    loses EMPTY heredoc bodies (the awk join absorbs a leading empty one, and its
    `read -d` drops a trailing one), so comparing raw joined strings would report a
    mismatch the bash segmenter itself cannot represent. Applying the same drop to both
    sides makes the comparison exact on everything bash can actually express.
    """
    return {
        "status": shape["status"],
        "seg": shape["seg"],
        "sep": shape["sep"],
        "heredoc": [[h for h in field.split("\x1f") if h] for field in shape["heredoc"]],
        "subseg": shape["subseg"],
    }


def _records(path: str) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def _head(command: str) -> str:
    return command.replace("\n", "⏎")[:90]


def cmd_replay(args: argparse.Namespace) -> int:
    if args.judge == bool(args.compare_bash):
        print("replay: pass exactly one of --judge or --compare-bash", file=sys.stderr)
        return 2
    records = _records(args.corpus)
    if args.compare_bash:
        return _replay_compare_bash(records, Path(args.compare_bash))
    return _replay_judge(records, Path(args.compare_hooks) if args.compare_hooks else None)


def _replay_compare_bash(records: list[dict], cmdparse: Path) -> int:
    agree = 0
    for rec in records:
        command = rec["command"]
        mine_c = _comparable(to_json_shape(parse(command)))
        theirs_c = _comparable(bash_parse(cmdparse, command))
        if mine_c == theirs_c:
            agree += 1
            continue
        print(f"MISMATCH: {_head(command)}")
        for key in ("status", "seg", "sep", "heredoc", "subseg"):
            if mine_c[key] != theirs_c[key]:
                print(f"  {key}: python={mine_c[key]!r} bash={theirs_c[key]!r}")
    print(f"PARITY {agree}/{len(records)}")
    return 0 if agree == len(records) else 1


def _replay_judge(records: list[dict], hooks_dir: Path | None) -> int:
    home = os.environ.get("HOME", "")
    roots = scratch_roots(home, os.environ.get("TMPDIR"))
    allowed = 0
    agree = 0
    for rec in records:
        command = rec["command"]
        cwd = rec.get("cwd", "")
        env = {**os.environ, "CLAUDE_PROJECT_DIR": cwd}
        d = judge(command, load_rules(home=home, project_dir=cwd), roots)
        if d.allow:
            allowed += 1
            print(f"ALLOW: {_head(command)}")
        if hooks_dir is None:
            continue
        stdin_text = json.dumps({"tool_input": {"command": command}})
        bash_hook = bash_chain_allows(hooks_dir, stdin_text, env)
        if d.allow == bool(bash_hook):
            agree += 1
        else:
            py = "allow" if d.allow else "none"
            sh = "allow" if bash_hook else "none"
            print(f"MISMATCH: {_head(command)} python={py} bash={sh} rule={d.rule}")
    print(f"ALLOW {allowed}/{len(records)}")
    if hooks_dir is None:
        return 0
    print(f"AGREE {agree}/{len(records)}")
    return 0 if agree == len(records) else 1


def cmd_permission_request(args: argparse.Namespace) -> int:
    # The allow-path failure contract: nothing on stdout, exit 0, whatever happens.
    try:
        out = permission_request(sys.stdin.read(), os.environ)
    except Exception:
        return 0
    if out:
        print(out)
    return 0


def cmd_shadow_report(args: argparse.Namespace) -> int:
    default_dir = Path(os.environ.get("CLAUDE_SHADOW_LOG_DIR") or Path.home() / ".claude" / "logs")
    log = Path(args.log) if args.log else (default_dir / LOG_NAME)
    if not log.exists():
        print(f"no shadow log at {log}")
        return 1
    s = summarize(log.read_text().splitlines())
    print(f"records {s['records']} (unparseable {s['unparseable']})")
    print(f"agree {s['agree']} (allow {s['agree_allow']}, none {s['agree_none']})")
    print(f"python-only {s['python_only']}")
    for rule, n in sorted(s["python_only_rules"].items(), key=lambda kv: -kv[1]):
        print(f"  {rule}: {n}")
    print(f"bash-only {s['bash_only']}")
    for rule, n in sorted(s["bash_only_rules"].items(), key=lambda kv: -kv[1]):
        print(f"  {rule}: {n}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="claude-guard", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("permission-request", help="PermissionRequest hook entry (stdin JSON)")
    p.set_defaults(fn=cmd_permission_request)

    sr = sub.add_parser("shadow-report", help="summarise the shadow log; counts, never commands")
    sr.add_argument(
        "--log", default=None, help=f"path to the log (default: $CLAUDE_SHADOW_LOG_DIR/{LOG_NAME})"
    )
    sr.set_defaults(fn=cmd_shadow_report)

    s = sub.add_parser("segment", help="decompose the command on stdin")
    s.add_argument(
        "--json", action="store_true", required=True, help="print cmdparse.sh's JSON shape"
    )
    s.set_defaults(fn=cmd_segment)

    e = sub.add_parser("explain", help="show how a command segments")
    e.add_argument("command")
    e.set_defaults(fn=cmd_explain)

    r = sub.add_parser("replay", help="run a JSONL of {command, cwd} records")
    r.add_argument("corpus")
    r.add_argument(
        "--compare-bash",
        default=None,
        metavar="CMDPARSE_SH",
        help="path to cmdparse.sh; report segmentation parity",
    )
    r.add_argument(
        "--judge",
        action="store_true",
        help="judge every record against the deployed settings; print the allowed ones",
    )
    r.add_argument(
        "--compare-hooks",
        default=None,
        metavar="DIR",
        help="with --judge: run the bash chain in DIR per record and report agreement",
    )
    r.set_defaults(fn=cmd_replay)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
