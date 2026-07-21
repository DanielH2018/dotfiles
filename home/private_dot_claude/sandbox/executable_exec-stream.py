#!/usr/bin/env python3
"""Filter `claude -p --output-format stream-json` output for `claude-sandbox --exec`.

Reads stream-json events on stdin (one JSON object per line). Emits human-readable
progress to stderr as it goes (so a watching human sees the implementer work live),
and writes the final result to stdout between delimiters so an orchestrator can
extract it without scraping the whole stream. Exit code reflects the implementer's
success (non-zero if the run reported an error).
"""
import json
import sys

RESULT_BEGIN = "<<<EXEC_RESULT>>>"
RESULT_END = "<<<END_EXEC_RESULT>>>"


def eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def summarize_tool(name, inp):
    inp = inp or {}
    if name == "Bash":
        return f"Bash: {str(inp.get('command', ''))[:140]}"
    for key in ("file_path", "path", "pattern", "prompt", "url", "query", "command"):
        if key in inp:
            return f"{name}: {str(inp[key])[:140]}"
    return name


def main():
    final = None
    is_error = False
    saw_result = False
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            eprint(f"  · {line[:180]}")
            continue
        etype = ev.get("type")
        if etype == "system" and ev.get("subtype") == "init":
            eprint(f"▸ session {str(ev.get('session_id', '?'))[:8]} — model {ev.get('model', '?')}")
        elif etype == "assistant":
            for block in ev.get("message", {}).get("content", []):
                btype = block.get("type")
                if btype == "text" and block.get("text", "").strip():
                    eprint(block["text"].rstrip())
                elif btype == "tool_use":
                    eprint(f"  → {summarize_tool(block.get('name'), block.get('input'))}")
        elif etype == "result":
            saw_result = True
            is_error = bool(ev.get("is_error"))
            final = ev.get("result")
            bits = []
            if ev.get("num_turns") is not None:
                bits.append(f"{ev['num_turns']} turns")
            if isinstance(ev.get("total_cost_usd"), (int, float)):
                bits.append(f"${ev['total_cost_usd']:.4f}")
            eprint(f"▪ done ({', '.join(bits)})" if bits else "▪ done")

    if not saw_result:
        eprint("▪ stream ended with no result event")
        is_error = True
    print(RESULT_BEGIN, flush=True)
    if final is not None:
        print(final, flush=True)
    print(RESULT_END, flush=True)
    sys.exit(1 if is_error else 0)


if __name__ == "__main__":
    main()
