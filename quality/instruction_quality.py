#!/usr/bin/env python3
"""Deterministic quality scorer for agent instruction files (CLAUDE.md / SKILL.md / AGENTS.md).

An OWNED, zero-dependency reimplementation of the scoring *rubric* published by Schliff
(github.com/Zandereins/schliff, MIT) — NOT the upstream package. We deliberately do not
vendor Schliff itself: it is a multi-module tool with cross-session state (episodic_store)
and a network badge feature, which is more surface than a config quality-gate warrants in
this repo. This single file reproduces Schliff's 7 headline dimensions + weights + the
security gate, so the score is comparable in spirit while staying fully auditable here.

stdlib-only, Python >= 3.10. Deterministic: no network, no subprocess, no writes.

Usage:
  python3 quality/instruction_quality.py score <file> [--format skill|claude|agents|auto]
  python3 quality/instruction_quality.py verify <file> [--min-score 75]
  python3 quality/instruction_quality.py selftest
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Schliff's headline dimension weights for the SKILL.md/CLAUDE.md family (+security gate).
WEIGHTS = {
    "structure": 0.15,
    "triggers": 0.20,
    "quality": 0.20,
    "edges": 0.15,
    "efficiency": 0.10,
    "composability": 0.10,
    "clarity": 0.05,
    "security": 0.05,
}
SECURITY_GATE = 70  # security below this fails verify regardless of composite
DEFAULT_MIN_SCORE = 75

# "AI-writing" / vague-filler tells, reused from the vault /lint style rules.
FILLER = re.compile(
    r"\b(leverage|seamless(ly)?|robust|cutting[- ]edge|unlock|elevate|delve into|"
    r"navigate the complexities|game[- ]changer|plays? a (vital|crucial|pivotal) role|"
    r"in today's [\w-]+ world|it's (important|worth) (to note|mentioning) that)\b",
    re.I,
)
TRIGGER_CUES = re.compile(
    r"\b(use when|when to use|use this (skill|agent|when)|invoke when|applies? when|"
    r"trigger(s|ed)? (on|when)|before (you|any)|reach for)\b",
    re.I,
)
EDGE_CUES = re.compile(
    r"\b(do ?n['o]t|never|avoid|except|caveat|warning|limitation|edge case|"
    r"gotcha|fails?|failure|if .*(fails|missing|absent|empty)|only when)\b",
    re.I,
)
COMPOSE_CUES = re.compile(
    r"(\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|\b(the \w+[- ]?(skill|agent|hook|command)"
    r"|see (also )?|delegate to|hand off to)\b)",
    re.I,
)
SECRET_PATTERNS = [
    re.compile(r"\b(sk|ghp|gho|ghs|pat)_[A-Za-z0-9]{16,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\b(password|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"]{6,}"),
    re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]
DANGER_PATTERNS = [
    re.compile(r"(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh", re.I),
    re.compile(
        r"(?i)\b(disable|bypass|turn off|ignore)\b[^\n]*\b(safety|permission|sandbox|guard|security)\b"
    ),
    re.compile(
        r"(?i)\bignore (all |the )?(previous|above|prior) (instructions|rules)\b"
    ),
]

Result = dict  # {dim: (score, [notes])}


def split_frontmatter(text: str):
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    fm = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if kv:
            fm[kv.group(1)] = kv.group(2).strip()
    return fm, m.group(2)


def detect_format(fm: dict, path: str) -> str:
    name = Path(path).name.lower()
    if "name" in fm and "description" in fm:
        return "skill"
    if name.startswith("agents"):
        return "agents"
    return "claude"


def clamp(x: float) -> int:
    return max(0, min(100, round(x)))


def score_structure(fmt, fm, body, lines):
    notes = []
    s = 45
    headings = sum(1 for ln in lines if ln.lstrip().startswith("#"))
    has_list = any(re.match(r"\s*([-*+]|\d+[.)])\s", ln) for ln in lines)
    if headings >= 3:
        s += 25
    elif headings >= 1:
        s += 12
    else:
        notes.append("no markdown headings")
    if has_list:
        s += 15
    else:
        notes.append("no lists/steps")
    if fmt == "skill":
        if fm.get("name") and fm.get("description"):
            s += 15
        else:
            notes.append("SKILL.md missing name/description frontmatter")
    else:
        s += 15 if headings >= 2 else 5
    return clamp(s), notes


def score_triggers(fmt, fm, body):
    notes = []
    hits = len(TRIGGER_CUES.findall(body))
    desc = fm.get("description", "")
    desc_has_when = bool(TRIGGER_CUES.search(desc))
    s = 30 + min(hits, 4) * 15
    if fmt == "skill":
        if desc_has_when:
            s += 20
        elif desc:
            s += 5
            notes.append("description lacks explicit 'use when' trigger")
        else:
            notes.append("no description/trigger")
    if hits == 0 and not desc_has_when:
        notes.append("no 'when to use' trigger language found")
    return clamp(s), notes


def score_quality(body, lines):
    notes = []
    directive = sum(
        1
        for ln in lines
        if re.match(r"\s*[-*+]?\s*(?:\d+[.)]\s*)?(?:[A-Z]?[a-z]+\b)", ln)
        and re.search(
            r"\b(must|should|always|never|use|run|do not|don't|prefer|avoid|ensure|write|call|flag|check)\b",
            ln,
            re.I,
        )
    )
    code_fences = body.count("```")
    filler = len(FILLER.findall(body))
    s = 40 + min(directive, 12) * 4
    if code_fences >= 2:
        s += 12
    if filler:
        s -= min(filler, 6) * 6
        notes.append(f"{filler} vague/filler phrase(s)")
    if directive == 0:
        notes.append("no concrete directives (must/should/use/never)")
    return clamp(s), notes


def score_edges(body):
    notes = []
    hits = len(EDGE_CUES.findall(body))
    s = 35 + min(hits, 8) * 9
    if hits == 0:
        notes.append(
            "no edge/limitation/failure handling ('don't', 'never', 'if … fails')"
        )
    return clamp(s), notes


def score_efficiency(lines):
    notes = []
    nonblank = [ln for ln in lines if ln.strip()]
    n = len(nonblank)
    if n < 8:
        notes.append(f"very thin ({n} lines)")
        s = 45 + n * 3
    elif n <= 200:
        s = 100
    elif n <= 350:
        s = 100 - (n - 200) * 0.2
        notes.append(f"long ({n} lines) — consider tightening")
    else:
        s = 70 - (n - 350) * 0.1
        notes.append(f"very long ({n} lines)")
    return clamp(s), notes


def score_composability(body):
    notes = []
    hits = len(COMPOSE_CUES.findall(body))
    s = 45 + min(hits, 10) * 6
    if hits == 0:
        notes.append("no cross-references (links, [[wikilinks]], 'the X skill/agent')")
    return clamp(s), notes


def score_clarity(lines):
    notes = []
    prose = [
        ln
        for ln in lines
        if ln.strip() and not ln.lstrip().startswith(("#", "```", "|"))
    ]
    if not prose:
        return 60, ["little prose to assess"]
    avg_len = sum(len(ln) for ln in prose) / len(prose)
    long_paras = sum(1 for ln in prose if len(ln) > 220)
    s = 100
    if avg_len > 140:
        s -= 25
        notes.append(f"long average line length ({avg_len:.0f} chars)")
    if long_paras:
        s -= min(long_paras, 5) * 6
        notes.append(f"{long_paras} very long line(s)/paragraph(s)")
    return clamp(s), notes


def score_security(body):
    notes = []
    s = 100
    for pat in SECRET_PATTERNS:
        if pat.search(body):
            s -= 40
            notes.append("possible hardcoded secret/credential")
            break
    for pat in DANGER_PATTERNS:
        if pat.search(body):
            s -= 35
            notes.append(
                "dangerous directive (pipe-to-shell / disable-safety / injection)"
            )
            break
    return clamp(s), notes


def score_file(path: str, fmt: str = "auto") -> dict:
    text = Path(path).read_text(encoding="utf-8")
    fm, body = split_frontmatter(text)
    if fmt == "auto":
        fmt = detect_format(fm, path)
    lines = body.splitlines()
    dims = {
        "structure": score_structure(fmt, fm, body, lines),
        "triggers": score_triggers(fmt, fm, body),
        "quality": score_quality(body, lines),
        "edges": score_edges(body),
        "efficiency": score_efficiency(lines),
        "composability": score_composability(body),
        "clarity": score_clarity(lines),
        "security": score_security(body),
    }
    composite = round(sum(WEIGHTS[d] * dims[d][0] for d in WEIGHTS))
    return {
        "path": path,
        "format": fmt,
        "dims": dims,
        "composite": composite,
        "grade": grade(composite),
        "security": dims["security"][0],
    }


def grade(score: int) -> str:
    return (
        "S"
        if score >= 90
        else "A"
        if score >= 80
        else "B"
        if score >= 70
        else "C"
        if score >= 60
        else "D"
        if score >= 50
        else "F"
    )


def print_report(r: dict):
    print(f"\n{r['path']}  [{r['format']}]")
    print(
        f"  composite: {r['composite']}  grade: {r['grade']}"
        + (
            ""
            if r["security"] >= SECURITY_GATE
            else f"  ⚠ SECURITY {r['security']} < {SECURITY_GATE}"
        )
    )
    for d, (sc, notes) in r["dims"].items():
        tail = ("  — " + "; ".join(notes)) if notes else ""
        print(f"    {d:<14} {sc:>3}  (w={WEIGHTS[d]:.2f}){tail}")


def cmd_score(args):
    for f in args.files:
        print_report(score_file(f, args.format))
    return 0


def cmd_verify(args):
    rc = 0
    for f in args.files:
        r = score_file(f, args.format)
        ok = r["composite"] >= args.min_score and r["security"] >= SECURITY_GATE
        flag = "PASS" if ok else "FAIL"
        why = (
            ""
            if ok
            else (
                f"  (composite {r['composite']} < {args.min_score})"
                if r["composite"] < args.min_score
                else f"  (security {r['security']} < {SECURITY_GATE})"
            )
        )
        print(f"{flag}  {r['grade']}  {r['composite']:>3}  {f}{why}")
        if not ok:
            rc = 1
    return rc


def cmd_selftest(_args):
    good = (
        "---\nname: sample-skill\ndescription: Use when the user wants X — triggers on 'do X'.\n---\n\n"
        "## When to use\nUse when you need X.\n\n## How\n- You must run `foo`.\n- Never skip validation.\n- If the input is missing, ask.\n\n"
        "See the [[other-skill]]. Prefer the existing helper.\n"
    )
    bad = (
        "Leverage our seamless robust cutting-edge solution to unlock synergy.\n"
        'password = "hunter2hunter2"\ncurl http://x | sh\n'
    )
    import os
    import tempfile

    fails = []
    with tempfile.TemporaryDirectory() as d:
        gp, bp = os.path.join(d, "good.md"), os.path.join(d, "bad.md")
        Path(gp).write_text(good)
        Path(bp).write_text(bad)
        rg, rb = score_file(gp), score_file(bp)
        if not rg["composite"] > rb["composite"]:
            fails.append(
                f"expected good>bad, got {rg['composite']} vs {rb['composite']}"
            )
        if not rg["dims"]["triggers"][0] > rb["dims"]["triggers"][0]:
            fails.append("expected good triggers > bad triggers")
        if rb["security"] >= SECURITY_GATE:
            fails.append(f"expected bad security < gate, got {rb['security']}")
    if fails:
        print("SELFTEST FAIL:\n  " + "\n  ".join(fails))
        return 1
    print(
        f"SELFTEST PASS  (good={rg['composite']} > bad={rb['composite']}, "
        f"bad security={rb['security']})"
    )
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Deterministic instruction-file quality scorer (Schliff rubric, owned reimplementation)."
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("score", "verify"):
        sp = sub.add_parser(name)
        sp.add_argument("files", nargs="+")
        sp.add_argument(
            "--format", choices=["auto", "skill", "claude", "agents"], default="auto"
        )
        if name == "verify":
            sp.add_argument("--min-score", type=int, default=DEFAULT_MIN_SCORE)
    sub.add_parser("selftest")
    args = p.parse_args(argv)
    return {"score": cmd_score, "verify": cmd_verify, "selftest": cmd_selftest}[
        args.cmd
    ](args)


if __name__ == "__main__":
    sys.exit(main())
