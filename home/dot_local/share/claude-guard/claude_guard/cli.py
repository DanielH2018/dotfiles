"""claude-guard command line.

    claude-guard segment --json            # decomposition of the command on stdin,
                                            # cmdparse.sh's shape
    claude-guard explain "<command>"       # the segments and, from slice 2, the rule
                                            # that decided each
    claude-guard replay <jsonl> --compare-bash <cmdparse.sh>
                                            # parity of every {command, cwd} record
                                            # against the bash segmenter

`segment --json` exists for tests and the parity gate, never for the hook path. The hook
entry points (`permission-request`, `pre-tool-use`) arrive in slice 2.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from claude_guard.segment import Parsed, parse


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
    for i, seg in enumerate(p.segments):
        print(f"[{i}] sep={seg.sep} heredocs={len(seg.heredocs)}: {seg.text.strip()}")
    for i, sub in enumerate(p.substitutions):
        print(f"sub[{i}]: {sub.strip()}")
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


def cmd_replay(args: argparse.Namespace) -> int:
    records = [
        json.loads(line) for line in Path(args.corpus).read_text().splitlines() if line.strip()
    ]
    agree = 0
    for rec in records:
        command = rec["command"]
        mine = to_json_shape(parse(command))
        theirs = bash_parse(Path(args.compare_bash), command)
        mine_c = _comparable(mine)
        theirs_c = _comparable(theirs)
        if mine_c == theirs_c:
            agree += 1
            continue
        head = command.replace("\n", "⏎")[:90]
        print(f"MISMATCH: {head}")
        for key in ("status", "seg", "sep", "heredoc", "subseg"):
            if mine_c[key] != theirs_c[key]:
                print(f"  {key}: python={mine_c[key]!r} bash={theirs_c[key]!r}")
    print(f"PARITY {agree}/{len(records)}")
    return 0 if agree == len(records) else 1


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="claude-guard", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

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
        required=True,
        metavar="CMDPARSE_SH",
        help="path to cmdparse.sh; report segmentation parity",
    )
    r.set_defaults(fn=cmd_replay)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
