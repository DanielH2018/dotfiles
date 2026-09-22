"""One decomposition of a Bash command, ported from cmdparse.sh's awk pass.

Contract, unchanged from the bash library:

    parse(command) -> Parsed
        .status      "ok" | "unreadable:unbalanced-quote" | "unreadable:substitution"
        .segments    top-level segments in order, each with the separator that TERMINATED it
                     (&& || ; | & newline eof), the heredoc bodies attached to it, and whether
                     each heredoc's delimiter was quoted (a quoted delimiter means the body
                     is not expanded, so it cannot carry a live substitution)
        .substitutions  the content of every $( ), `...`, <( ) and >( ), segmented the same
                     way and flattened across nesting depth; a nested substitution gets its
                     own entry beside its parent's

    A NON-OK STATUS IS A REFUSAL, NEVER A SKIP. The caller must defer (PermissionRequest)
    or ask (PreToolUse). It must never be read as "nothing to worry about here".

Why one pass: heredoc lifting and substitution scanning share the same frame stack, so a
heredoc textually inside a double-quoted substitution (`git commit -am "$(cat <<'EOF' … EOF)"`)
is still lifted once the scan crosses into the `$( )` and is back at a command position. A
two-pass version of this parser shipped that bug in bash.

Frames: squote, dquote, backtick, paren ($( )), dparen ($(( ))), brace (${ }), procsub.
Separators and `<<` are recognised only at a command position: stack empty, or the innermost
frame executing (paren, procsub, backtick). $(( )) and ${ } are tracked to their boundary but
are not executing, so `<<` inside $(( )) is a shift operator, and closing either records no
substitution.

Separators are `&&`, `||`, `;`, `|`, a lone `&` not preceded by `<`/`>` (fd dups) nor
followed by `>` (`&>` sends both streams to a file), and a
newline. A trailing separator terminates the last segment rather than opening an empty one
(`ls;` is one segment), because the compound gate keys on the segment count and a spurious
second segment would widen it.
"""

from dataclasses import dataclass

_EXECUTING = frozenset({"paren", "procsub", "backtick"})
_SUB_FRAMES = frozenset({"paren", "dparen", "procsub"})
_DELIM_END = frozenset(" \t\n;&|><(")


@dataclass(frozen=True, slots=True)
class Segment:
    text: str
    sep: str
    heredocs: tuple[str, ...]
    heredoc_quoted: tuple[bool, ...]


@dataclass(frozen=True, slots=True)
class Parsed:
    status: str
    segments: tuple[Segment, ...]
    substitutions: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def _unreadable(reason: str) -> Parsed:
    return Parsed(f"unreadable:{reason}", (), ())


def parse(command: str) -> Parsed:
    s = command
    n = len(s)

    kind: list[str] = []  # frame stack
    cnt: list[int] = []  # nesting counter per frame, aligned with `kind`
    seg_start: list[int] = [0]  # per depth; index 0 is the top level
    pend: list[tuple[str, bool, bool, int]] = []  # (delim, strip_tabs, quoted, offset)
    heredocs: list[tuple[int, str, bool]] = []  # (offset, body, quoted)
    segs: list[list] = []  # [text, sep, off0, off1]
    subs: list[str] = []

    def push(k: str, start: int) -> None:
        kind.append(k)
        cnt.append(0)
        seg_start.append(start)

    def pop() -> None:
        kind.pop()
        cnt.pop()
        seg_start.pop()

    def cut(i: int, sep: str) -> None:
        depth = len(kind)
        piece = s[seg_start[depth] : i]
        if depth == 0:
            segs.append([piece, sep, seg_start[0], i])
        else:
            subs.append(piece)

    i = 0
    while i < n:
        c = s[i]
        depth = len(kind)
        top = kind[-1] if kind else ""

        if top == "squote":
            if c == "'":
                pop()
            i += 1
            continue

        if c == "\\":
            i += 2
            continue

        if c == "'":
            if top == "dquote":
                i += 1
                continue
            push("squote", i + 1)
            i += 1
            continue

        if c == '"':
            if top == "dquote":
                pop()
                i += 1
                continue
            push("dquote", i + 1)
            i += 1
            continue

        if c == "`":
            if top == "backtick":
                subs.append(s[seg_start[depth] : i])
                pop()
                i += 1
                continue
            push("backtick", i + 1)
            i += 1
            continue

        next1 = s[i + 1] if i + 1 < n else ""

        if c == "$" and next1 == "(":
            next2 = s[i + 2] if i + 2 < n else ""
            push("dparen" if next2 == "(" else "paren", i + 2)
            i += 2
            continue

        if c == "$" and next1 == "{":
            push("brace", i + 2)
            i += 2
            continue

        if c in "<>" and next1 == "(" and top != "dquote":
            push("procsub", i + 2)
            i += 2
            continue

        if top in _SUB_FRAMES:
            if c == "(":
                cnt[-1] += 1
                i += 1
                continue
            if c == ")":
                if cnt[-1] > 0:
                    cnt[-1] -= 1
                    i += 1
                    continue
                if top != "dparen":
                    subs.append(s[seg_start[depth] : i])
                pop()
                i += 1
                continue

        if top == "brace":
            if c == "{":
                cnt[-1] += 1
                i += 1
                continue
            if c == "}":
                if cnt[-1] > 0:
                    cnt[-1] -= 1
                    i += 1
                    continue
                pop()
                i += 1
                continue

        at_cmd = depth == 0 or top in _EXECUTING

        if at_cmd and c == "<" and next1 == "<":
            next2 = s[i + 2] if i + 2 < n else ""
            if next2 != "<":  # `<<<` is a herestring, not a heredoc
                hoff = i
                j = i + 2
                strip = False
                if j < n and s[j] == "-":
                    strip = True
                    j += 1
                while j < n and s[j] in " \t":
                    j += 1
                quoted = False
                delim = ""
                if j < n and s[j] in "'\"":
                    q = s[j]
                    j += 1
                    k = s.find(q, j)
                    if k == -1:
                        return _unreadable("unbalanced-quote")
                    delim = s[j:k]
                    quoted = True
                    j = k + 1
                    # K1 (task-8-fix-4-brief.md): a quoted delimiter's word does not end
                    # at the closing quote — bash keeps reading the SAME word until it
                    # hits real IFS whitespace or a metacharacter, exactly like the
                    # unquoted branch below. Without this loop, `<<'EOF'` immediately
                    # followed by a non-boundary byte (`\r`, U+3000, or any other char
                    # `_DELIM_END` doesn't name) computed `delim = "EOF"` while bash's
                    # real delimiter was `EOF<that char>` — no line in the input ever
                    # equals the SHORTER python delim, so the heredoc body absorption
                    # below ran to end-of-input, swallowing every later segment
                    # (including a hidden command) into one unterminated heredoc body.
                    # Measured: `cat > note.txt <<'EOF'\r\nhi\nEOF\r\nmkdir pwned\n` —
                    # bash closes the heredoc at the literal `EOF\r` line and runs
                    # `mkdir pwned` as its own command; the unabsorbed python swallowed
                    # it whole. judge.py's `_HEREDOC_CAT_WRITE` tail tightening (K3)
                    # closes the same case at the regex layer; this closes it at the
                    # parser layer so the segmenter's own delimiter matches bash's
                    # independently of that regex — see the DECIDED marker at
                    # `unjudgeable:heredoc` in judge.py for why both are shipped.
                    while j < n and s[j] not in _DELIM_END:
                        delim += s[j]
                        j += 1
                else:
                    while j < n and s[j] not in _DELIM_END:
                        delim += s[j]
                        j += 1
                pend.append((delim, strip, quoted, hoff))
                i = j
                continue

        if at_cmd:
            if (c == "&" and next1 == "&") or (c == "|" and next1 == "|"):
                cut(i, c + next1)
                seg_start[depth] = i + 2
                i += 2
                continue
            if c == "&":
                prevc = s[i - 1] if i > seg_start[depth] else ""
                # `>&`/`<&` are fd dups and `&>`/`&>>` send both streams to a file;
                # none of them ends a command. Only a lone `&` backgrounds.
                if prevc != ">" and prevc != "<" and next1 != ">":
                    cut(i, "&")
                    seg_start[depth] = i + 1
                    i += 1
                    continue
            if c == ";" or c == "|":
                cut(i, c)
                seg_start[depth] = i + 1
                i += 1
                continue
            if c == "\n":
                cut(i, "newline")
                seg_start[depth] = i + 1
                i += 1
                if pend:
                    body_start = i
                    for delim, strip, quoted, hoff in pend:
                        body = ""
                        while True:
                            # Absolute find(), not s[body_start:] then a relative find(): slicing
                            # the remainder copies it on every line, making a large heredoc body
                            # quadratic in its own length.
                            line_end = s.find("\n", body_start)
                            has_nl = line_end != -1
                            line = s[body_start:line_end] if has_nl else s[body_start:]
                            cmp = line.lstrip("\t") if strip else line
                            if cmp == delim:
                                body_start = line_end + 1 if has_nl else n
                                break
                            body += line + "\n"
                            if not has_nl:
                                body_start = n
                                break
                            body_start = line_end + 1
                        heredocs.append((hoff, body, quoted))
                    pend.clear()
                    seg_start[depth] = body_start
                    i = body_start
                continue

        i += 1

    if kind:
        reason = "substitution"
        if any(k in ("squote", "dquote") for k in kind):
            reason = "unbalanced-quote"
        return _unreadable(reason)

    # n, not n + 1: this offset is 0-indexed one-past-end, unlike the awk oracle's 1-indexed n+1.
    segs.append([s[seg_start[0] :], "eof", seg_start[0], n])

    # A trailing separator terminates the last command; it does not start an empty new one.
    # A loop, because `ls &&\n` ends in two separators back to back.
    while len(segs) > 1:
        text, _sep, off0, off1 = segs[-1]
        if any(off0 <= hoff < off1 for hoff, _b, _q in heredocs):
            break
        if text.strip(" \t\r\n"):
            break
        segs.pop()
        segs[-1][1] = "eof"

    out: list[Segment] = []
    for text, sep, off0, off1 in segs:
        mine = [(body, quoted) for hoff, body, quoted in heredocs if off0 <= hoff < off1]
        out.append(Segment(text, sep, tuple(b for b, _q in mine), tuple(q for _b, q in mine)))
    return Parsed("ok", tuple(out), tuple(subs))


def visible(parsed: Parsed) -> list[str]:
    """The split as every consumer sees it: stripped, with empty segments dropped.

    Strips Unicode whitespace (`str.strip()`) to match the node suite's `.trim()` oracle,
    whereas the segment-boundary collapse above strips only `" \\t\\r\\n"` to match bash.
    """
    return [t for t in (seg.text.strip() for seg in parsed.segments) if t]
