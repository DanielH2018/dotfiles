#!/usr/bin/env python3
"""Detect and repair Claude Code transcripts poisoned by the advisor/rename race.

A session's auto-title system-reminder (an ``isMeta`` user entry) can be appended
to the transcript while an ``advisor`` server-tool call is still in flight. That
splits one assistant API message in two, leaving ``advisor_tool_result`` as
``content[0]`` of a message with no preceding ``server_tool_use``. Every later
request then fails with::

    400 invalid_request_error: messages.N.content.0: unexpected `tool_use_id`
    found in `advisor_tool_result` blocks: srvtoolu_...

The damage is latent -- the running turn finishes fine and the session only dies
on the next user prompt or on ``--resume``.

Repair moves the interloping entries to *after* the ``advisor_tool_result`` line
so the assistant entries stay contiguous, and re-stitches ``parentUuid`` so the
chain still threads every entry in its new order.

Usage:
    repair-advisor-transcript.py                  # scan every project transcript
    repair-advisor-transcript.py FILE...          # scan specific transcripts
    repair-advisor-transcript.py --apply [FILE...]  # write repairs (.bak kept)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

PROJECTS = os.path.expanduser("~/.claude/projects")


def blocks_of(entry: dict) -> list:
    content = entry.get("message", {}).get("content")
    return content if isinstance(content, list) else []


def first_type(entry: dict) -> str | None:
    b = blocks_of(entry)
    return b[0].get("type") if b else None


def find_breaks(entries: list[dict]) -> list[tuple[int, int, str]]:
    """Return (start, end, srvtoolu_id) spans of entries wedged into a message.

    ``start`` is the index of the first interloping entry, ``end`` the index of
    the orphaned ``advisor_tool_result`` entry.
    """
    breaks = []
    for i, entry in enumerate(entries):
        if (
            entry.get("type") != "assistant"
            or first_type(entry) != "advisor_tool_result"
        ):
            continue
        tool_id = blocks_of(entry)[0].get("tool_use_id")
        msg_id = entry.get("message", {}).get("id")

        # Walk back to the matching server_tool_use in the same API message.
        j = i - 1
        while j >= 0:
            prev = entries[j]
            if (
                prev.get("type") == "assistant"
                and prev.get("message", {}).get("id") == msg_id
            ):
                if any(
                    b.get("type") == "server_tool_use" and b.get("id") == tool_id
                    for b in blocks_of(prev)
                ):
                    break
                j -= 1
                continue
            j -= 1
        else:
            continue

        # Anything between j and i that is not part of the same assistant
        # message split the API message in two.
        intruders = [
            k
            for k in range(j + 1, i)
            if not (
                entries[k].get("type") == "assistant"
                and entries[k].get("message", {}).get("id") == msg_id
            )
        ]
        if intruders:
            breaks.append((intruders[0], i, tool_id))
    return breaks


def repair(entries: list[dict], start: int, end: int) -> list[dict]:
    moved = entries[start:end]
    advisor = entries[end]
    out = entries[:start] + [advisor] + moved + entries[end + 1 :]

    prev_uuid = out[start - 1].get("uuid") if start else None
    for k in range(start, end + 1):
        if prev_uuid is not None:
            out[k]["parentUuid"] = prev_uuid
        prev_uuid = out[k].get("uuid")
    if end + 1 < len(out) and prev_uuid is not None and "parentUuid" in out[end + 1]:
        out[end + 1]["parentUuid"] = prev_uuid
    return out


def process(path: str, apply: bool) -> bool:
    try:
        with open(path, errors="replace") as fh:
            raw = fh.readlines()
    except OSError as exc:
        print(f"  ! cannot read {path}: {exc}", file=sys.stderr)
        return False

    entries = []
    for line in raw:
        try:
            entries.append(json.loads(line))
        except ValueError:
            return False  # not a transcript we understand; leave it alone

    breaks = find_breaks(entries)
    if not breaks:
        return False

    print(f"POISONED {path}")
    for start, end, tool_id in breaks:
        kinds = {e.get("type") for e in entries[start:end]}
        print(
            f"  lines {start + 1}-{end + 1}: {end - start} entr(ies) {sorted(kinds)} "
            f"split the message holding {tool_id}"
        )

    if not apply:
        return True

    for start, end, _ in reversed(breaks):
        entries = repair(entries, start, end)

    shutil.copy2(path, path + ".bak")
    with open(path, "w") as fh:
        fh.writelines(json.dumps(entry) + "\n" for entry in entries)
    print(
        f"  repaired (backup at {path}.bak) -- resume with: claude --resume "
        f"{os.path.basename(path)[:-6]}"
    )
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "files", nargs="*", help="transcripts to check (default: all projects)"
    )
    ap.add_argument("--apply", action="store_true", help="write repairs in place")
    args = ap.parse_args()

    targets = args.files
    if not targets:
        targets = [
            os.path.join(dp, fn)
            for dp, _, fns in os.walk(PROJECTS)
            for fn in fns
            if fn.endswith(".jsonl")
        ]

    hits = sum(process(p, args.apply) for p in sorted(targets))
    print(f"\n{hits} poisoned transcript(s) out of {len(targets)} scanned.")
    if hits and not args.apply:
        print("Re-run with --apply to repair them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
