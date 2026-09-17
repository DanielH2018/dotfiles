"""The single-segment/compound decision, ported from allow-compound-bash.sh as it decides
TODAY, plus D2 (docs/specs/2026-09-06-claude-guard-design.md, Decisions — "a single segment
is judged like a chain").

A command is allowed when every segment is allow-listed or passes a check, and no segment
matches deny or ask. Everything that makes the bash defer makes this defer, in the same
order, with the bash line cited beside it. This is a PORT: PR #477's three rules — a
newline judged like `;`, a quoted-delimiter `cat > path` heredoc write (both the
scratch-root AND the session-cwd confinement arms), and `set -` stripping — are ported
here, plus D2's removal of the not-compound early return (see the marker at its old site).
`VAR=` stripping is the one #477 rule deliberately NOT ported — see the DECIDED marker at
its refusal site in `judge()` below.

Fix round 1 (finding 3/6/7), F0: `remote.readonly_remote_safe`, `remote.trusted_host_safe`,
`ansible.ansible_readonly_safe` and `git_reset.clean_reset_safe` are STANDALONE
PermissionRequest hooks in the deployed chain (allow-readonly-remote.sh,
allow-daniel-server.sh, allow-ansible-readonly.sh, allow-clean-reset.sh) — they are never
delegated to from inside allow-compound-bash.sh's own segment loop, which only ever calls
out to curl and rm (:117-122, :130-135). So they are wired in `judge()` below as
whole-command arms tried against the untouched `command`, not inside `judge_segment` — the
faithful port is a union: the bash chain allows C when allow-compound-bash.sh allows C OR
any one of these standalone hooks allows C, regardless of what the segment loop on its own
concludes. curl and rm stay exactly where they were: they ARE delegated to from inside
allow-compound-bash.sh's own loop, so they stay a `judge_segment` arm alongside `scratch`.
"""

import os
import re
from dataclasses import dataclass

from claude_guard.checks.ansible import ansible_readonly_safe
from claude_guard.checks.curl import curl_safe
from claude_guard.checks.git_reset import clean_reset_safe
from claude_guard.checks.remote import readonly_remote_safe, trusted_host_safe
from claude_guard.checks.scratch import rm_confined, tokenize
from claude_guard.rules import Rules
from claude_guard.segment import parse

# :191. Wrapper commands take another command as an ARGUMENT and exec it.
WRAPPERS = frozenset({"timeout", "env", "nice", "nohup", "setsid", "stdbuf", "xargs"})

# H1 (task-8-fix-2-brief.md). A segment whose command word is one of these can move the
# shell's own working directory for every segment after it in the chain. Tracked only to
# gate the heredoc-write carve-out below — never resolved, see the DECIDED marker there.
_CD_LIKE = frozenset({"cd", "pushd", "popd"})

# K3 (task-8-fix-4-brief.md), the class fix. Bash's own word boundary — after a redirect
# target, a flag, a heredoc delimiter, an fd-dup operand, anywhere IFS field-splits two
# tokens apart — is space and tab. A literal newline is handled by the segmenter before
# any regex below ever runs: a `Segment.text` never carries one. Python's `\s` is wider:
# it also matches `\r`, `\f`, `\v`, and a run of Unicode whitespace, none of which is a
# bash word boundary in this position. `WS` is the one place that gets encoded, so every
# regex below that means "bash word boundary" reads off it instead of typing its own
# `\s`/`[ \t]`/`\S` — the alternative is N independently-typed character classes that can
# drift apart, which is the exact hazard the J1/J2 marker in `judge_segment` below names
# for a different pair of regexes. Round 3 (J5) found the drift once, in the two DEVNULL
# lookaheads' tails; round 4 (K1/K2) found it live twice more — a heredoc delimiter
# (segment.py's own copy of this fix sits beside the quoted-delimiter branch) and an
# fd-dup redirect target. `_first_word` below is the one deliberate exception: it ports a
# POSIX `[[:space:]]` bash construct, not IFS splitting, so it keeps `\s`, not `WS`.
WS = " \t"

# H4 (task-8-fix-2-brief.md): both DEVNULL patterns were unanchored at the tail, so a
# target that only STARTS WITH /dev/null (/dev/nullx, /dev/nullish) matched and was
# stripped as if it were the real sink. The tail lookahead (built from `WS`) requires
# the match end at a word boundary — the next char is whitespace or nothing — without
# consuming it, so a trailing character defeats the match instead of being silently
# absorbed into it.
# Segments are already split on `;`/`&&`/`|`/newline before either pattern runs, so
# nothing legitimate ever follows a real `/dev/null` target except whitespace or the end
# of the segment.
#
# J5 (task-8-fix-3-brief.md): the tail lookahead used to be Python's broad `\s`, which
# admits `\r`/`\f`/`\v` where bash's real word boundary after a redirect target is space
# or tab. `ls > /dev/null\r` measured ALLOW: the lookahead treated the trailing `\r` as a
# boundary and stripped "> /dev/null" as the harmless sink, while bash's actual filename
# is `/dev/nullCR` — a different, non-harmless target in principle. Not exploitable as
# measured: the path always sits directly under root-owned `/dev/`, so the sandbox write
# gets `Permission denied` as ubuntu regardless. Both patterns now read off `WS`
# throughout (K3), not only at the tail this round tightened.
_DEVNULL_REDIRECT = re.compile(rf"[0-9]*>>?[{WS}]*/dev/null(?=[{WS}]|$)")
# K2 (task-8-fix-4-brief.md): unanchored, so the fd-dup operand consumed only the digit
# after `>&`, leaving anything glued onto it (no separating whitespace) in the residue
# handed back to the caller. Bash reads `>&` followed by the WHOLE word: `>&1/../../x`
# is not purely digits, so bash treats it as `> 1/../../x 2>&1` — a real write target one
# level above cwd. The un-anchored regex stripped only `>&1`, leaving `/../../x` with no
# `>` in it, so `"> " in redir` never fired and the segment fell through to the plain
# allow list. Measured ALLOW, `ls >&1/../../canary.txt` from a cwd holding a directory
# named `1`; `mkdir 1 && ls >&1/../../canary.txt` supplies that directory in the same
# command. The `WS`-built lookahead closes it the same way H4 closed the DEVNULL case.
_FD_DUP = re.compile(rf"[0-9]*>&[0-9-](?=[{WS}]|$)")
_OPTION_WORD = re.compile(rf"[{WS}]+-[^{WS}]+")
# H4-adjacent (found while fixing H4, not named in the brief): unanchored the identical
# way, and live — `tee:*` IS allow-listed in settings.permissions.json:136. `tee
# /dev/nullx` stripped to `tee` (basename match) and fell through to the plain allow-list
# check, auto-approving an arbitrary write target. Measured end to end through the real
# entry point before this fix: `tee /dev/nullx` ALLOW, `tee /dev/null` ALLOW (unaffected,
# confirms the anchor doesn't touch the real case).
#
# J5's tail tightening is applied here too for parity, but — checked by mutation while
# writing the J5 fix above, see tests/test_judge.py's note beside the redirect-side
# red-proof — it has no independently observable effect on THIS pattern: the lookahead
# never consumes what follows the match, so any trailing character (`\r` included)
# survives into `judge_segment`'s `teed`, and the `teed != teecmd` comparison downstream
# refuses on that leftover regardless of which class the lookahead accepts. K3
# (task-8-fix-4-brief.md) tightens the LEADING `\s+` too, for the same reason it tightens
# every other boundary here — it only ever narrows what gets stripped, so it can only
# make `teed != teecmd` MORE likely to fire, never less.
_DEVNULL_WORD = re.compile(rf"[{WS}]+/dev/null(?=[{WS}]|$)")

# PR #477 (:150-158). A `cat > path`/`cat >> path` write whose heredoc delimiter is QUOTED
# has no expansion possible: a quoted delimiter suppresses parameter and command
# substitution in the body, and this line carries no expansion of its own either. The
# delimiter itself is confined to a bare identifier so a stray quote in the path can't be
# mistaken for the closing one.
#
# DECIDED (G3, task-8-fix-1-brief.md; amended H1, task-8-fix-2-brief.md): verified "no"
# for the same question G1 asks of VAR=/timeout — can what is not judged here change what
# IS judged? The regex is anchored `^...$` over the WHOLE segment, so nothing is discarded
# the way a wrapper's prefix tokens are: the one piece this carve-out never inspects, the
# heredoc BODY, is never executed either — `cat` writes it to `path` byte for byte, it
# does not `eval` it, and the quoted delimiter already rules out substitution inside it.
# `path` itself is read straight out of the match, not derived from anything stripped
# away. So the part THIS REGEX does not scrutinize (the body) has no path to changing the
# part it does (the write target) or to executing on its own.
#
# Scope of that "no", stated so the next reviewer does not stop here the way this sweep
# did: it covers the heredoc BODY only, never the chain PREFIX. This regex is matched
# against one already-segmented `part` in isolation — it has no visibility into, and
# makes no claim about, any segment that ran before it in the same chain. Whether an
# earlier segment can change what `path` resolves to (H1: a `cd`/`pushd`/`popd` moves the
# cwd the confinement arms measure against) is answered at the carve-out's CALL site in
# `judge_segment`/`judge`, by the `cwd_changed` gate, not by this regex.
#
# K1 (task-8-fix-4-brief.md): every boundary here now reads off `WS`, in both directions.
# The tail (`[{WS}]*$`) is the live half: with broad `\s`, `cat > note.txt <<'EOF'\r`
# (the segment text left behind once a `\r`-terminated delimiter line is in play) still
# matched — the `\r` read as a trailing boundary — so `heredoc_write_target()` returned
# `"note.txt"` for a segment whose REAL bash delimiter is `EOF\r`, not `EOF`, bypassing
# the `unjudgeable:heredoc` refusal below entirely. Tightening the tail alone closes it
# (both payloads then fail this match and fall through to `unjudgeable:heredoc`); the
# `path` capture (`[^{WS}"']+` in place of `[^\s"']+`) is the other half of the same
# widening — it now admits `\r`/`\f`/`\v`/Unicode whitespace INTO the captured path,
# matching bash's real word instead of truncating it at the first such character. That
# capture then goes to `scratch.tokenize()` (the `heredoc-write:special-char` gate a
# few hundred lines below), whose own `_SPECIAL` set already refuses a bare `\r`/`\n`
# outright — so a path that now correctly captures a literal CR reads as a refusal there
# instead of silently vetting a shorter, wrong path the way J1/J2 did for `>`/`$`.
_HEREDOC_CAT_WRITE = re.compile(
    rf"""^cat[{WS}]+>{{1,2}}[{WS}]*(?P<path>[^{WS}"']+)[{WS}]+<<-?[{WS}]*"""
    rf"""(?:'[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*")[{WS}]*$"""
)

# PR #477 (:392-405) read a leading `VAR=value` assignment word with this shape and
# STRIPPED it before judging the rest of the segment. Fix round (G1, task-8-fix-1-brief.md):
# that arm is not ported. `_ASSIGNMENT_WORD` is kept only to DETECT the shape, at the
# refusal site in `judge()` below — see the DECIDED marker there for why.
_ASSIGNMENT_WORD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# PR #477 (:415-421). `set -e`, `set -euo pipefail`, `set -o pipefail`: options to the
# CURRENT shell, not a command of their own. K3 (task-8-fix-4-brief.md): `WS`, not `\s` —
# narrowing this can only make MORE segments miss the "is this a bare `set -...`" test,
# which sends them to be judged as an ordinary command word instead of skipped; `set` is
# not itself allow-listed, so the worst case is an extra refusal, never a new approval.
_SET_OPTIONS = re.compile(rf"^set[{WS}]+-[A-Za-z]")


def heredoc_write_target(text: str) -> str | None:
    """:150-158. The write path of a quoted-delimiter `cat > path`/`cat >> path`, or None."""
    m = _HEREDOC_CAT_WRITE.match(text)
    return m.group("path") if m else None


def _under_session_cwd(path: str, cwd: str) -> bool:
    """PR #477's heredoc_write_ok, the cwd arm (:169-194, cwd branch :183-191): the path a
    quoted-delimiter heredoc write targets is ALSO safe when it resolves under the
    session's own `cwd`, not only under a scratch root. `..`, a leading `~`, or a leading
    `$` refuse outright, before either confinement arm is tried in the bash — mirrored here
    even though rm_confined's own tokenizer already refuses `~` and `$` for the
    scratch-root arm, since this arm can be reached on its own when the scratch check fails.

    J1/J2 (task-8-fix-3-brief.md): the sole caller (`judge_segment`'s heredoc-write
    carve-out) now runs `scratch.tokenize(hw_target) is None` ahead of BOTH confinement
    arms, and `tokenize` refuses `$` and `~` unconditionally, not just as a leading
    character. So the `path.startswith("~")`/`path.startswith("$")` checks just below are
    now unreachable from that call site — `hw_target` can never carry either by the time
    it gets here — same idiom as the `cwd_changed` DECIDED marker above this function's
    call site: kept anyway, not resting on that fact, because this function's own contract
    ("`..`, a leading `~`, or a leading `$` refuse outright") should hold on its own if a
    future caller ever reaches it without that gate. `".." in path` is NOT covered by
    `tokenize` (`.` is not a shell metacharacter) and stays the one check still doing
    independent work against the current caller.

    Fix round 1, F2: unlike `under_scratch` (scratch.py), which judges purely lexically,
    this function resolves the TARGET with `os.path.realpath` (default `strict=False`,
    same as bash's `realpath -m --`) and compares it against the RAW `cwd` string,
    unresolved. That asymmetry is the bash's own (:183-191: `real=$(realpath -m -- "$p")`
    compared against the literal `"$CWD"`/`"$CWD"/*`), and it is deliberate, not an
    oversight to "fix" by resolving both sides: resolving `cwd` too would allow strictly
    MORE than the bash whenever the session cwd itself has a symlink component. Lexical
    comparison on the target alone is a fail-open — with cwd `/tmp/proj` holding a symlink
    `escape -> /home/ubuntu`, the lexical form of `escape/.bashrc` starts with
    `/tmp/proj/escape`, so it read as confined, while bash resolves it to
    `/home/ubuntu/.bashrc`, which matches neither `"$CWD"` nor `"$CWD"/*`, and refuses. A
    quoted-delimiter heredoc write to `escape/.bashrc` auto-approved a write outside the
    session under the old lexical check; it does not under this one.

    Finding 7 (no live defect, stated for the record): `os.path.realpath` always returns
    an absolute path, so it can never equal or start with a relative `base` — a relative
    `cwd` already measures False here without this guard. But that refusal was incidental
    rather than stated, and a future edit that made the comparison lexical again (as
    `under_scratch` already is) would silently reopen it. DECIDED: require an absolute
    `cwd` explicitly, the same contract `git_reset.py:88` states for its own cwd consumer,
    so the two cwd consumers in this package agree on what a valid cwd is.
    """
    if (
        not cwd
        or not cwd.startswith("/")
        or ".." in path
        or path.startswith("~")
        or path.startswith("$")
    ):
        return False
    candidate = path if path.startswith("/") else f"{cwd.rstrip('/')}/{path}"
    real = os.path.realpath(candidate)
    base = cwd.rstrip("/") or "/"
    return real == base or real.startswith(base + "/")


def _is_set_options(part: str) -> bool:
    """:415-421. True for `set -e`/`set -euo pipefail`/`set -o pipefail`."""
    return bool(_SET_OPTIONS.match(part))


def _changes_cwd(part: str) -> bool:
    """H1 (task-8-fix-2-brief.md). True when the segment's OWN command word, OR the word
    it resolves to once a leading wrapper is stripped, is `cd`, `pushd` or `popd` — the
    three builtins that can move the shell's working directory for every segment after
    this one in the chain. No attempt at tracking WHERE it moves to: the brief's own
    instruction is not to, since resolving a `cd` target means resolving variables,
    `cd -`, and a directory-stack, and every gap in that resolution is its own fail-open.
    This is a pure detector, consulted by `judge()` to gate the heredoc-write carve-out
    (see the `cwd_changed` DECIDED marker in `judge_segment`).

    The wrapper re-check (found via review after the brief's own text, not named in it):
    `timeout 5 cd /tmp && cat > note.txt <<'EOF'` measured ALLOW end to end through the
    real entry point before this re-check existed — `judge_segment` resolves `timeout 5
    cd /tmp` through `unwrap_wrapper` to the allow-listed `cd /tmp` and judges it "ok" on
    that path, but this function was checking only the RAW segment's first word
    (`timeout`), so the flag never set and the write behind it rode through exactly the
    way a bare `cd` used to before the rest of this fix. `unwrap_wrapper` already peels
    every wrapper layer in one call (its own internal loop), so one re-resolution here
    closes it without re-implementing that loop.

    Still out of scope, deliberately: a `cd` buried inside a pipeline stage that
    subshells (`ls | (cd /x && cat)`) — the shape H1 measured and fixed is a `cd` in an
    earlier CHAIN segment, not one hidden inside a parenthesised subshell, and `(` is not
    among the wrappers `unwrap_wrapper` understands. A `cd` inside `$(...)` or `` `...` ``
    never reaches here at all — `judge()` refuses the whole command at
    `unjudgeable:substitution` before the segment loop runs."""
    if _basename(_first_word(part)) in _CD_LIKE:
        return True
    target = unwrap_wrapper(part)
    return target is not None and target != part and _basename(_first_word(target)) in _CD_LIKE


@dataclass(frozen=True, slots=True)
class Decision:
    allow: bool
    rule: str
    reasons: tuple[str, ...]


def _trim(s: str) -> str:
    """:137-142. Spaces and tabs only."""
    return s.strip(" \t")


def _first_word(s: str) -> str:
    """`${s%%[[:space:]]*}`: everything before the first whitespace character.

    K3 (task-8-fix-4-brief.md) swept every other `\\s` on the judging path to `WS`
    (space/tab, bash's IFS word boundary) and considered this one too. Decided KEEP: this
    is not IFS field-splitting, it is a literal port of a bash `%%` pattern match against
    the POSIX `[[:space:]]` GLOB CLASS — a different bash construct with a different,
    WIDER definition (POSIX `[[:space:]]` already includes `\\r`/`\\f`/`\\v`/`\\n`, not
    only space/tab). Swapping in `WS` here would make the port narrower than the bash
    line it ports, not just differently-scoped — the opposite of every other change in
    this sweep, all of which narrow an over-wide `\\s` toward bash's real (narrower) IFS
    boundary. Nothing downstream of `_first_word` depends on catching every POSIX-space
    character either: its two callers (`_changes_cwd`'s cd/pushd/popd detection and the
    `tee` check's command-word extraction) only need the command word up to the FIRST
    boundary of any kind, and stopping early on a narrower class would just leave trailing
    whitespace-class bytes glued onto the word instead of splitting them off — a fail
    OPEN in the same shape `_HEREDOC_CAT_WRITE`'s old `[^\\s"']` capture was (K1): the
    word compared against `_CD_LIKE`/`"tee"` would come out wrong-but-different rather
    than correctly split. So this one stays wide on purpose. Next sweep: this docstring
    is the second write-up of the same conclusion (first: the J5-era comment beside `WS`
    above) — a third independent review reaching it again is confirmation, not news.
    """
    return re.split(r"\s", s, maxsplit=1)[0]


def _basename(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def unwrap_wrapper(segment: str) -> str | None:
    """:181-270. Resolve a segment to the command that will actually execute.

    A segment that is not a wrapper comes back unchanged. None means the argument shape
    could not be read with confidence; the caller MUST defer, never fall back to the
    wrapper's own allow entry. The flag tables are closed: an unknown option is a refusal.
    """
    s = segment
    depth = 0
    while depth < 4:  # `timeout 5 nohup nice cmd` nests; a bound stops a cycle
        depth += 1
        # split() also splits on an embedded newline and Unicode whitespace, where bash
        # `read -a` (the wrapper's tokenizer) reads only the first line. On such a segment
        # the port may unwrap where the bash defers (e.g. `timeout\n5 ls`: bash `read -a`
        # sees one token and defers, split() sees three and can unwrap to `ls`). The
        # segment executes as separate commands either way; slice 3 decides whether the
        # port must match the bash exactly on inputs like this.
        t = s.split()
        n = len(t)
        if n == 0:
            return None
        w = _basename(t[0])
        if w not in WRAPPERS:
            return s
        i = 1
        if w in ("nohup", "setsid"):
            pass
        elif w == "nice":
            while i < n:
                tok = t[i]
                if tok == "-n":
                    i += 2
                    continue
                numeric = len(tok) > 1 and tok[0] == "-" and tok[1].isdigit()
                if numeric or tok.startswith("--adjustment="):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None
                break
        elif w == "timeout":
            # DECIDED (G3, task-8-fix-1-brief.md): verified "no" for can-the-stripped-part-
            # change-what-the-surviving-part-executes, the G1 question applied to this
            # wrapper. `--preserve-status`/`--foreground`/`-v`/`--verbose` take no value at
            # all; `-s`/`--signal=` name a signal to send TIMEOUT's own kill, never a
            # command to exec; `-k`/`--kill-after=` is a duration for the same kill timer.
            # None of timeout(1)'s own flags take a command as an argument or can cause one
            # to execute — only the duration and the command word that follow do, and both
            # stay in the unstripped remainder `unwrap_wrapper` returns for the caller to
            # judge. Unlike VAR=, nothing stripped here can change the surviving command.
            while i < n:
                tok = t[i]
                if tok in ("--preserve-status", "--foreground", "-v", "--verbose"):
                    i += 1
                    continue
                if tok in ("-s", "-k"):
                    i += 2
                    continue
                if tok.startswith("--signal=") or tok.startswith("--kill-after="):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None
                break
            # :218-224. The duration is positional and mandatory.
            if i >= n or not t[i][:1].isdigit():
                return None
            i += 1
        elif w == "env":
            # :225-235 let `env VAR=VALUE... cmd` consume its assignment tokens and hand
            # the bare `cmd` on to be judged alone — origin/main:225-235 (the hook THIS
            # commit retires) has this exact shape TODAY, so it is not a #477-prototype
            # regression the way G1's bare `VAR=value cmd` stripping was.
            #
            # DECIDED (G1's own reasoning, extended — found by testing this fix round,
            # not named in task-8-fix-1-brief.md's text): it is the identical hazard G1
            # exists to close, reached through `env` instead of bare assignment syntax.
            # `env PATH=/tmp ls -la` consumed `PATH=/tmp` and handed `ls -la` to the allow
            # list exactly the way bare `PATH=/tmp ls -la` used to — confirmed against the
            # real pre-cutover snapshot, which also allows `echo hi && env PATH=/tmp ls
            # -la` today. G1's own rationale ("`env` is deliberately absent from the allow
            # list for exactly this reason... this rule reintroduced the same capability
            # through the shell's own assignment syntax") describes this branch word for
            # word. Refusing to unwrap when env carries ANY assignment is a strict
            # NARROWING relative to the bash (python refuses where bash would have
            # allowed), never a widening, so it cannot move G2's ALLOW floor the wrong way
            # — the opposite of G1's own direction, which is why it is safe to fix here
            # rather than file as a separate finding. A bare `env cmd` (no VAR=) carries no
            # assignment and still unwraps normally below. (The loop this replaced could
            # consume several VAR= tokens in a row; refusing on the first means it can
            # never loop more than once, so there is nothing left here to iterate.)
            if i < n and (t[i].startswith("-") or "=" in t[i]):
                return None
        elif w == "stdbuf":
            while i < n:
                tok = t[i]
                if (len(tok) > 2 and tok[0] == "-" and tok[1] in "ioe") or tok.startswith(
                    ("--input=", "--output=", "--error=")
                ):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None  # includes the separated `-o L` form
                break
        elif w == "xargs":
            while i < n:
                tok = t[i]
                if tok in (
                    "-0",
                    "-r",
                    "-t",
                    "-x",
                    "-p",
                    "--null",
                    "--no-run-if-empty",
                    "--verbose",
                    "--interactive",
                ):
                    i += 1
                    continue
                if tok in ("-n", "-I", "-P", "-d", "-a", "-L", "-s", "-E"):
                    i += 2
                    continue
                if len(tok) > 2 and tok[0] == "-" and tok[1] in "nIPdaLsE":
                    i += 1
                    continue
                if tok.startswith(
                    (
                        "--max-args=",
                        "--replace=",
                        "--max-procs=",
                        "--delimiter=",
                        "--arg-file=",
                        "--max-lines=",
                        "--max-chars=",
                        "--eof=",
                    )
                ):
                    i += 1
                    continue
                if tok == "--":
                    i += 1
                    break
                if tok.startswith("-"):
                    return None  # -e and -l carry OPTIONAL arguments; arity is unknowable
                break
            if i >= n:
                return None  # bare xargs runs echo; there is no command word to judge
        if i >= n:
            return None
        # :262-266. Word splitting above is naive, so a quote among the consumed tokens
        # means the real boundaries are not where they appear. Refuse rather than guess.
        if any("'" in tok or '"' in tok for tok in t[:i]):
            return None
        s = " ".join(t[i:])
    return None


def judge_segment(
    part: str, rules: Rules, roots: tuple[str, ...], cwd: str, cwd_changed: bool
) -> tuple[bool, str]:
    """:286-395, one iteration of the loop. (ok, reason).

    `cwd_changed` is H1's gate (task-8-fix-2-brief.md): True when an EARLIER segment in
    the same chain was `cd`/`pushd`/`popd` (`judge()`'s own loop sets it, via
    `_changes_cwd`, after judging each segment in turn). It has exactly one consumer
    below — the heredoc-write carve-out — and is otherwise unused by design: every other
    check in this function judges the segment's own text and is unaffected by where the
    shell happens to be.
    """
    # H2 (task-8-fix-2-brief.md): deny hoisted to the top of this function, ahead of the
    # heredoc-write carve-out below. The carve-out used to return an early `True` before
    # this ran at all, silently bypassing a deny rule that matched the very segment it
    # was vouching for — exactly the exception ":315-319"'s own comment ("no exception
    # below reaches past this") said could not happen. This hoist is allow-set-neutral
    # for every OTHER segment shape: deny already ran ahead of ff-only/curl-rm/ask
    # (:393-430 below), so moving it here only changes its position relative to the
    # redirect and tee checks, and both of those return False unconditionally — so the
    # only possible effect of the hoist is relabelling a `False, "redirect"` or `False,
    # "tee"` as `False, "deny"` when a segment happens to match both; the ALLOW/DEFER
    # boundary itself cannot move. `rules.asks(part)` is deliberately NOT hoisted here:
    # curl_safe/rm_confined are placed "after deny, before ask" on purpose (see the
    # comment at that check below), and hoisting ask would run it ahead of curl/rm too,
    # inverting that documented precedence. The reviewer confirmed no ask rule matches a
    # `cat > path <<'EOF'` segment today, so the heredoc carve-out bypassing ask remains
    # exactly as unreachable as it was before this fix — unlike the deny bypass, it is
    # not being newly closed, only left where it already was.
    if rules.denies(part):
        return False, "deny"

    # PR #477 (:432-436). A quoted-delimiter heredoc write vetted by heredoc_write_target:
    # allow it here rather than letting it fall into the blanket redirect refusal just
    # below. Confined to a scratch root (delegated to rm_confined on a synthetic
    # `rm <path>`, same reasoning as the curl and rm delegation further down — one
    # scratch-confinement list, one place it can drift) OR to the session's own cwd
    # (_under_session_cwd, PR #477's heredoc_write_ok cwd arm). Any OTHER segment in the
    # chain still has to clear every check on its own; this vouches for the write, not for
    # the rest of the command.
    hw_target = heredoc_write_target(part)
    if hw_target is not None:
        # DECIDED (H1, task-8-fix-2-brief.md): refuse the carve-out outright — for BOTH
        # confinement arms, not only `_under_session_cwd` — once an earlier segment in
        # this chain could have moved the shell's cwd. `_under_session_cwd` compares the
        # write target against the `cwd` the PermissionRequest hook was invoked with,
        # which goes stale the moment an earlier segment runs `cd`; `cd /home/ubuntu/.config
        # && cat > note.txt <<'EOF'` vetted `note.txt` against the SESSION cwd while the
        # shell wrote it relative to `/home/ubuntu/.config` — the guard vetted a path the
        # shell never wrote to. `rm_confined`'s scratch arm has the same shape in kind: it
        # is handed a synthetic `rm <hw_target>`, and a relative target there resolves
        # against a cwd this guard never measured either. (`under_scratch`,
        # checks/scratch.py:79, already refuses a relative path outright today, so that
        # arm is not independently exploitable right now — this gate is not resting on
        # that fact: the two arms are tied to ONE flag on purpose, so a later change that
        # made `under_scratch` lexical-relative-aware, the way F2's docstring warns
        # `_under_session_cwd` itself not to become, would not silently reopen this.)
        #
        # Not resolving `cd` itself — no variable expansion, no `cd -`, no directory
        # stack for `pushd`/`popd` — is deliberate, per the brief: every one of those
        # resolutions is its own fail-open surface, so the whole carve-out fails closed
        # instead once ANY `cd`-like segment has run, full stop. Cost: a prompt on a
        # confined heredoc write that happens to follow an unrelated `cd` in the same
        # chain, even a `cd` back to the original directory — overbroad by construction,
        # never narrowed to "did the net effect move it".
        #
        # An ABSOLUTE target does not depend on cwd at all, so exempting one from this
        # gate would be sound in principle — considered and declined: one more branch on
        # this path is one more place a future edit can get the condition backwards, for
        # a carve-out whose failure mode is a silent arbitrary-write allow. The brief's
        # own instruction is not to get clever here.
        #
        # Shape recorded for whoever needs the rows next (task-8-fix-3-brief.md, "Not in
        # scope this round"): `hw_target.startswith("/") and rm_confined(f"rm {hw_target}",
        # roots)` — SCRATCH arm only, gated on an absolute target, tried before this
        # `cwd_changed` refusal rather than after it. `rm_confined`/`under_scratch`
        # already refuse a relative operand outright, so this exemption is cwd-independent
        # by construction: it cannot be reached by a target this `cwd_changed` gate exists
        # to protect. It recovers the four lost H1 rows (a worktree PR/commit-body write
        # pattern: `cd <worktree> && cat > /tmp/<body> <<'EOF' ... rm -f /tmp/<body>`), all
        # under an absolute /tmp path. Not added this round: the gate is at zero headroom
        # (floor 84, no margin), and this round's J1/J2 fix is floor-neutral on its own —
        # headroom is not needed yet.
        #
        # A `cd` that runs inside a PIPELINE stage (`ls | (cd /x; cat) `) executes in a
        # subshell and never relocates the parent shell `cat` runs in — this flag cannot
        # tell the two apart and refuses both, which is the fail-closed direction and is
        # intentional, not a bug to later "fix" by trying to tell them apart.
        if cwd_changed:
            return False, "heredoc-write:cwd-changed"

        # DECIDED (J1/J2, task-8-fix-3-brief.md): refuse the carve-out for BOTH
        # confinement arms when the write target itself carries a shell metacharacter,
        # via the exact tokenizer the scratch arm already runs on it (`scratch.tokenize`)
        # rather than a second, independently-typed character class — so the two arms
        # are provably testing the same "plain path" contract, not two copies that
        # could drift apart later. Measured ALLOW before this gate existed, cwd
        # `/home/ubuntu/server`: `cat > a>/etc/x <<'EOF'` (J1 — the capture
        # `[^\s"']+` in `_HEREDOC_CAT_WRITE` admits `>`; bash tokenizes `a>/etc/x` as
        # `>a` then `>/etc/x`, and the LAST redirect wins, so the guard vets `a>/etc/x`
        # while the shell writes `/etc/x`) and `cat > .${X:-.}/x <<'EOF'` (J2 —
        # `_under_session_cwd` refused a leading `$` only; bash expands `${X:-.}`
        # wherever it sits in the word, turning the target into `../x`). `tokenize`
        # refuses `$` unconditionally, at any position, plus every other shell
        # metacharacter (`;&|<>(){}` backtick `\*?[]`), so both measured inputs now
        # refuse here, before either arm runs. `rm_confined`'s own tokenization of
        # `f"rm {hw_target}"` already refused both on the scratch arm (the same
        # characters are in its `_SPECIAL` set); this closes the identical gap in
        # `_under_session_cwd`, which had no metacharacter check of its own. Floor-
        # neutral, on two different kinds of evidence for two different claims: the brief
        # verified all 17 corpus rows riding this carve-out are free of `>`, `<`, `$`, `\`
        # and backtick specifically (task-8-fix-3-brief.md); `tokenize` refuses a larger
        # set than that (also `;&|(){}*?[]~` and bare CR/LF), which the brief's own
        # evidence does not cover — that wider claim rests instead on re-running the
        # replay gate after this change and reading ALLOW 84/1058 unchanged, not on an
        # inspection of the 17 targets against the full `_SPECIAL` set.
        if tokenize(hw_target) is None:
            return False, "heredoc-write:special-char"

        if rm_confined(f"rm {hw_target}", roots) or _under_session_cwd(hw_target, cwd):
            return True, "heredoc-write"
        return False, "heredoc-write:unconfined"

    # :293-300. Redirection turns an allow-listed reader into a writer. /dev/null and fd
    # dups are the harmless cases and are everywhere in diagnostics.
    redir = _FD_DUP.sub("", _DEVNULL_REDIRECT.sub("", part))
    if ">" in redir:
        return False, "redirect"

    # :302-313. tee writes every path it is handed. Judge the command WORD, not a glob
    # over the segment: `tee /usr/bin/tee` must not look harmless.
    teed = _DEVNULL_WORD.sub("", _OPTION_WORD.sub("", part))
    teecmd = _first_word(teed)
    if _basename(teecmd) == "tee" and teed != teecmd:
        return False, "tee"

    # :321-341. The one ask-listed segment named as safe here: `git merge --ff-only <ref>`
    # with exactly one ref that does not look like an option, read off the
    # redirect-stripped form because nearly every real call carries `2>&1`.
    #
    # K3 (task-8-fix-4-brief.md): considered for the `WS` sweep and decided KEEP `\s`
    # here — this is a PRESENCE check gating a REFUSAL ("approve only if NO whitespace
    # character is found anywhere in ffref"), not a boundary a match gets stripped
    # across. Every regex `WS` replaces elsewhere on this path is the opposite shape: a
    # boundary that gets CONSUMED so the matched span is treated as harmless and
    # approved — broadening `\s` there widens what gets silently stripped, which is the
    # K1/K2 fail-open. Here broadening `\s` only WIDENS the set of characters that
    # trigger a refusal, which is strictly the safe direction; narrowing it to `WS` would
    # do the opposite — a ref carrying a literal `\r`/`\f`/`\v`/Unicode space no longer
    # trips `re.search`, so it would newly qualify as "no whitespace" and get approved.
    # That ref cannot smuggle a second command the way K1's heredoc delimiter did (this
    # segment is already fully isolated by `segment.py` before `judge_segment` ever sees
    # it, and `git`'s own ref-name validation forbids the ASCII control characters this
    # would admit), so the failure mode if it slipped through would be git refusing an
    # unresolvable ref name, not a hidden command — but there is no correctness reason to
    # take even that on, so this one keeps the wider, more-conservative `\s`.
    if part.startswith("git merge --ff-only "):
        ffref = _trim(redir.removeprefix("git merge --ff-only "))
        if ffref and not ffref.startswith("-") and not re.search(r"\s", ffref):
            return True, "ff-only"

    # :343-348,:353. A provably-safe curl or a confined rm each resolve their own ask
    # rule. These two, and only these two, are delegated to from inside
    # allow-compound-bash.sh's own per-segment loop (safe_curl_ok/safe_rm_ok), so they stay
    # a judge_segment arm. The other three standalone-hook ports (remote/ansible/git-reset)
    # moved to whole-command arms in judge() (fix round 1, F0) — they were never delegated
    # to from inside this loop in the bash either, so wiring them here let a segment inside
    # a chain (e.g. `cd /tmp && git reset --hard origin/master`) earn a grace the bash
    # standalone hook only ever gives a command that is its own entire, single-segment
    # local invocation. After deny, before ask: where allow-safe-curl.sh/allow-safe-rm.sh
    # sit relative to this hook.
    word = _basename(_first_word(part))
    if word == "curl" and curl_safe(part):
        return True, "curl-check"
    if word == "rm" and rm_confined(part, roots):
        return True, "rm-check"

    # :359-363.
    if rules.asks(part):
        return False, "ask"

    # :365-372. Honour the allow list as written before unwrapping, or a narrowed rule
    # such as `/usr/bin/env bash --version` becomes unreachable.
    if rules.allows(part):
        return True, "allow-list"

    # :374-378.
    target = unwrap_wrapper(part)
    if target is None:
        return False, "wrapper-unreadable"
    if target == part:
        return False, "unlisted"

    # :380-387. The unwrapped command earns the same deny/ask scrutiny.
    if rules.denies(target) or rules.asks(target):
        return False, "wrapper-target-deny-or-ask"
    if not rules.allows(target):
        return False, "wrapper-target-unlisted"
    return True, f"wrapper:{target}"


def judge(command: str, rules: Rules, roots: tuple[str, ...], cwd: str) -> Decision:
    # DECIDED: D2 (docs/specs/2026-09-06-claude-guard-design.md, Decisions — "a single
    # segment is judged like a chain"). This used to be a literal-substring eligibility
    # gate — `if "&&" not in command and ";" not in command and "|" not in command: return
    # Decision(False, "not-compound", ())` — a faithful port of
    # allow-compound-bash.sh:51-59. Removed: a bare `rm -f /tmp/x` now reaches the same
    # checks a chained one does, and the segmenter already treats a bare newline as a
    # separator on its own, so this one deletion also admits a newline-only chain — both
    # were the standing `not-compound` bash_only row in the slice's shadow census (PR
    # #487). A command matching no check and no allow/deny/ask entry still returns "no
    # opinion" (segment:N:unlisted, below) — nothing here ever returns "deny".
    #
    # The reviewer enumerated what D2 newly allows that no bash hook allows, all measured
    # (fix round 1, finding 7) — an expected widening, not a regression, for the
    # post-cutover census to tell apart. The last entry is NOT a D2 widening — it has
    # nothing to do with single-segment judging — but an absent bash oracle; it is
    # recorded in the same place because it produces the same symptom, a python_only row
    # the census must not chase as a disagreement:
    #   git merge --ff-only origin/main   the compound hook's ask-list carve-out (:324-328
    #                                      below), now reachable bare
    #   timeout 5 ls                      bare wrapper unwrapping (unwrap_wrapper)
    #   git status / ls -la               a bare allow-list match
    #   a quoted-delimiter heredoc write   PR #477's own eligibility widening admits it too
    #   a clean `git reset --hard <ref>`   clean_reset_safe has NO deployed bash oracle at
    #                                      all — allow-clean-reset.sh is absent from the
    #                                      hooks dir because PR #474 is unmerged, so every
    #                                      `rule=git-reset-check` row in the post-cutover
    #                                      census reads `python_only` by construction, not
    #                                      as a disagreement to chase
    # The dangerous populations stay closed: deny, ask, the whole-glob deny/ask check
    # below, substitution, and the bare `&` separator all still run for a single segment,
    # and a bare unlisted command still returns Decision(False, "segment:0:unlisted", …) —
    # nothing here ever returns "deny".

    # F0 (fix round 1, findings 3/6/7). readonly_remote_safe, trusted_host_safe,
    # ansible_readonly_safe and clean_reset_safe port FOUR STANDALONE PermissionRequest
    # hooks (allow-readonly-remote.sh, allow-daniel-server.sh, allow-ansible-readonly.sh,
    # allow-clean-reset.sh) — none of them is delegated to from inside
    # allow-compound-bash.sh's own segment loop (only curl and rm are, :117-122,
    # :130-135), so they belong here, tried against the WHOLE, unsegmented `command` —
    # the harness invokes each of the real standalone hooks against the full raw command
    # the same way, independent of what allow-compound-bash.sh's own loop concludes. No
    # `word == …` prefilter guards these calls: each check parses the whole command
    # itself and is the one place that gets to decide whether it applies — a prefilter
    # keyed on the chain's first segment (a segment-loop optimisation that does not
    # transfer here) would skip e.g. clean_reset_safe on a command carrying an unrelated
    # prefix. Each of the four already self-refuses a compound shape on its own terms —
    # readonly_remote_safe and clean_reset_safe via segment.parse's own segment count,
    # trusted_host_safe via its own local-split-risk character scan, ansible_readonly_safe
    # via scratch.tokenize's special-character refusal — so e.g. `ssh daniel-server uptime
    # && rm -rf /` cannot ride in on the first segment being provably read-only. curl and
    # rm need no equivalent arm here: confirmed directly against the bash oracles, not
    # just their Python ports — allow-safe-curl.sh:107/allow-safe-rm.sh:88 each refuse an
    # unquoted `;`/`&`/`|`/`(`/`$`/backtick/etc. inside their own tokenizer's unquoted-
    # state case, before any curl/rm-specific logic runs, so neither bash hook can ever
    # say "allow" for a chained command in the first place — curl_safe/rm_confined carry
    # the identical refusal (checks/curl.py, checks/scratch.py's tokenize). So for a bare,
    # one-segment command the existing per-segment delegation in judge_segment below
    # reaches the identical verdict a whole-command arm would — adding one would be a
    # no-op.
    # Fix round 1, finding 6: two distinct rule labels, not one shared `remote-check`.
    # D1 ruled readonly_remote_safe/trusted_host_safe are two separate checks (no host
    # filter in allow-readonly-remote.sh, no verb table in allow-daniel-server.sh,
    # different outer parsers); summarize() buckets python_only_rules by `rule` while the
    # bash side records `bash_hook` distinctly, so a shared label re-collapses exactly the
    # pair the census needs apart — a disagreement could not be attributed to either check
    # without re-running the command.
    if readonly_remote_safe(command):
        return Decision(True, "remote-readonly-check", ())
    if trusted_host_safe(command):
        return Decision(True, "trusted-host-check", ())
    if ansible_readonly_safe(command):
        return Decision(True, "ansible-check", ())
    if clean_reset_safe(command, cwd):
        return Decision(True, "git-reset-check", ())

    # DECIDED: the four whole-command arms above run BEFORE whole_glob_defer, deliberately
    # — a real PermissionRequest hook is a separate, independent registration from
    # allow-compound-bash.sh and never consults its deny/ask glob list at all, so a
    # command one of the four would allow is not filtered through that list in the
    # deployed chain either. Placing them after whole_glob_defer would be stricter than
    # the bash, not a faithful port.

    # :277-281.
    if rules.whole_glob_defer(command):
        return Decision(False, "whole-glob", ())

    # :402-403. The segmenter's refusal is a refusal, never a skip.
    parsed = parse(command)
    if not parsed.ok:
        return Decision(False, parsed.status, ())

    # :404-428. Three things stay conservative on purpose: a substitution's content is an
    # opaque atom this judge cannot vet; a heredoc body is never scanned for one, so any
    # heredoc stays unjudgeable UNLESS it is the one carve-out PR #477 vets on its own
    # terms — a quoted-delimiter `cat > path`/`cat >> path` write (heredoc_write_target,
    # judged for real in judge_segment below); and a bare `&` still never reached judge()
    # under the old splitter, backgrounding glued the next command onto the previous
    # one's approval and judge() cannot tell whether it finishes first. A newline is no
    # longer in that population (PR #477): outside a heredoc body it is exactly `;` to the
    # shell.
    if parsed.substitutions:
        return Decision(False, "unjudgeable:substitution", ())
    last = len(parsed.segments) - 1
    for i, seg in enumerate(parsed.segments):
        # DECIDED (K1, task-8-fix-4-brief.md): this refusal's soundness rests on
        # `parse()`'s heredoc delimiter and `heredoc_write_target()`'s regex AGREEING on
        # where a quoted delimiter's word ends — if the segmenter computes a SHORTER
        # delimiter than the one `_HEREDOC_CAT_WRITE` (and bash) would read off the same
        # text, the segmenter absorbs everything up to end-of-input (including a later,
        # unjudged segment) into `seg.heredocs` and never surfaces it as a segment of its
        # own, while the regex below still matches the now-truncated `seg.text` and
        # returns a `path`, so this `is None` check never fires and the hidden segment
        # rides through unjudged. Measured: `cat > note.txt <<'EOF'\r\nhi\nEOF\r\nmkdir
        # pwned\n` — bash closes the heredoc at the literal `EOF\r` line; before this
        # round, `parse()` computed delim `"EOF"` (no line matches it, so it swallowed
        # `mkdir pwned` into the body) while `_HEREDOC_CAT_WRITE`'s `\s*$` matched the
        # trailing `\r` and returned `path="note.txt"` anyway. Fixed on BOTH sides this
        # round precisely so this check does not depend on a single regex being strict
        # enough — see the K1 comment beside `_HEREDOC_CAT_WRITE` and the one beside the
        # quoted-delimiter branch in `segment.py` for the two independent fixes this
        # relies on now, per the two-copies-drift hazard the J1/J2 marker above names.
        if seg.heredocs and (
            not all(seg.heredoc_quoted) or heredoc_write_target(_trim(seg.text)) is None
        ):
            return Decision(False, "unjudgeable:heredoc", ())
        if i < last and seg.sep == "&":
            return Decision(False, "unjudgeable:separator", ())

    reasons: list[str] = []
    # H1 (task-8-fix-2-brief.md). True once a `cd`/`pushd`/`popd` segment has been judged
    # `ok` earlier in THIS chain — set after judging each segment, never before, so a
    # `cd` segment itself is still judged against its own cwd. Threaded into
    # `judge_segment` to gate the heredoc-write carve-out; see the DECIDED marker there.
    cwd_changed = False
    for i, seg in enumerate(parsed.segments):
        part = _trim(seg.text)
        if not part:
            continue
        # PR #477. A `set -...`/`set -o ...` segment is an option to the CURRENT shell, not
        # a command of its own — it takes no action and earns no allow entry, so it is
        # skipped rather than judged.
        if _is_set_options(part):
            continue
        # DECIDED (G1, task-8-fix-1-brief.md, fix round 1 on 96da9d4): #477's own leading
        # `VAR=value` STRIP is not ported, full stop — not narrowed to an allowlist or
        # denylist of variable names. Three reasons. (1) The deployed
        # allow-compound-bash.sh being replaced never stripped assignments at all — this
        # arm came only from the unmerged #477 prototype, so removing it restores exact
        # parity with the chain this commit retires. (2) An assignment can change what the
        # REST of the segment executes (`PATH=/tmp ls -la` resolves `ls` from the attacker
        # path; `LD_PRELOAD=/tmp/x.so git status` loads an arbitrary `.so`;
        # `GIT_SSH_COMMAND=/tmp/x git fetch origin` execs `/tmp/x` directly) — stripping the
        # prefix and judging only `ls -la` / `git status` / `git fetch origin` judges a
        # command the shell never actually runs. `env` is deliberately absent from the
        # allow list for exactly this reason (SPAWNERS in
        # tests/settings/settings-permissions-no-spawners.test.js); this rule reintroduced
        # the identical capability through assignment syntax instead of `env`. (3) No
        # allowlist of "inert" variable names is enumerable — PATH, LD_PRELOAD,
        # GIT_SSH_COMMAND, BASH_ENV, GIT_DIR, GIT_CONFIG_GLOBAL, NODE_OPTIONS and
        # PYTHONPATH all arrived as one evidence list; a denylist only ever protects the
        # names already measured. A segment carrying a leading assignment therefore gets
        # its OWN rule label — never silently falls through to `unlisted` — so the census
        # can tell "declined for an assignment prefix" apart from "declined because
        # nothing matched," which is what would let a narrow, evidence-based allowlist be
        # designed later instead of guessed at now.
        if _ASSIGNMENT_WORD.match(_first_word(part)):
            reasons.append("assignment")
            return Decision(False, f"segment:{i}:assignment", tuple(reasons))
        ok, reason = judge_segment(part, rules, roots, cwd, cwd_changed)
        reasons.append(reason)
        if not ok:
            return Decision(False, f"segment:{i}:{reason}", tuple(reasons))
        if _changes_cwd(part):
            cwd_changed = True
    return Decision(True, "allow", tuple(reasons))
