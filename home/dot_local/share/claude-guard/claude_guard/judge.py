"""The single-segment/compound decision, ported from allow-compound-bash.sh as it decides
TODAY, plus D2 (docs/specs/2026-09-06-claude-guard-design.md, Decisions — "a single segment
is judged like a chain").

A command is allowed when every segment is allow-listed or passes a check, and no segment
matches deny or ask. Everything that makes the bash defer makes this defer, in the same
order, with the bash line cited beside it. This is a PORT: PR #477's three rules — a
newline judged like `;`, a quoted-delimiter `cat > path` heredoc write (both the
scratch-root AND the session-cwd confinement arms), and `VAR=`/`set -` stripping — are
ported here, plus D2's removal of the not-compound early return (see the marker at its old
site).

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
from claude_guard.checks.scratch import rm_confined
from claude_guard.rules import Rules
from claude_guard.segment import parse

# :191. Wrapper commands take another command as an ARGUMENT and exec it.
WRAPPERS = frozenset({"timeout", "env", "nice", "nohup", "setsid", "stdbuf", "xargs"})

_DEVNULL_REDIRECT = re.compile(r"[0-9]*>>?\s*/dev/null")
_FD_DUP = re.compile(r"[0-9]*>&[0-9-]")
_OPTION_WORD = re.compile(r"\s+-\S+")
_DEVNULL_WORD = re.compile(r"\s+/dev/null")

# PR #477 (:150-158). A `cat > path`/`cat >> path` write whose heredoc delimiter is QUOTED
# has no expansion possible: a quoted delimiter suppresses parameter and command
# substitution in the body, and this line carries no expansion of its own either. The
# delimiter itself is confined to a bare identifier so a stray quote in the path can't be
# mistaken for the closing one.
_HEREDOC_CAT_WRITE = re.compile(
    r"""^cat\s+>{1,2}\s*(?P<path>[^\s"']+)\s+<<-?\s*"""
    r"""(?:'[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*")\s*$"""
)

# PR #477 (:392-405). A leading `VAR=value` assignment word: identifier, `=`, anything.
_ASSIGNMENT_WORD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# PR #477 (:415-421). `set -e`, `set -euo pipefail`, `set -o pipefail`: options to the
# CURRENT shell, not a command of their own.
_SET_OPTIONS = re.compile(r"^set\s+-[A-Za-z]")


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


def _strip_assignments(part: str) -> str:
    """:392-405. Strip a leading `VAR=value` assignment (or several) — it takes no action
    of its own, the same way a human reads `FOO=bar somecmd` as "run somecmd". Left alone
    when the value carries a live `$`, backtick or `(`: any of those can still expand or
    execute, so the segment is judged as itself, assignment word and all, and fails every
    check below exactly as an unlisted command would. This does NOT resolve $VAR for a
    later segment that uses it as an operand.
    """
    while True:
        first = _first_word(part)
        if not _ASSIGNMENT_WORD.match(first):
            return part
        if "$" in first or "`" in first or "(" in first:
            return part
        rest = re.split(r"\s", part, maxsplit=1)
        if len(rest) == 1:
            return ""
        part = _trim(rest[1])


def _is_set_options(part: str) -> bool:
    """:415-421. True for `set -e`/`set -euo pipefail`/`set -o pipefail`."""
    return bool(_SET_OPTIONS.match(part))


@dataclass(frozen=True, slots=True)
class Decision:
    allow: bool
    rule: str
    reasons: tuple[str, ...]


def _trim(s: str) -> str:
    """:137-142. Spaces and tabs only."""
    return s.strip(" \t")


def _first_word(s: str) -> str:
    """`${s%%[[:space:]]*}`: everything before the first whitespace character."""
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
            # :225-235. Only the plain `env VAR=VALUE... cmd` shape; every option refused.
            while i < n:
                tok = t[i]
                if tok.startswith("-"):
                    return None
                if "=" in tok:
                    i += 1
                    continue
                break
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


def judge_segment(part: str, rules: Rules, roots: tuple[str, ...], cwd: str) -> tuple[bool, str]:
    """:286-395, one iteration of the loop. (ok, reason)."""
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

    # :315-319. Deny → defer. No exception below reaches past this.
    if rules.denies(part):
        return False, "deny"

    # :321-341. The one ask-listed segment named as safe here: `git merge --ff-only <ref>`
    # with exactly one ref that does not look like an option, read off the
    # redirect-stripped form because nearly every real call carries `2>&1`.
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
    #   FOO=bar git status                bare assignment stripping (_strip_assignments)
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
        if seg.heredocs and (
            not all(seg.heredoc_quoted) or heredoc_write_target(_trim(seg.text)) is None
        ):
            return Decision(False, "unjudgeable:heredoc", ())
        if i < last and seg.sep == "&":
            return Decision(False, "unjudgeable:separator", ())

    reasons: list[str] = []
    for i, seg in enumerate(parsed.segments):
        part = _trim(seg.text)
        if not part:
            continue
        # PR #477. Benign prefixes are skipped before the program is judged: a leading
        # VAR=value assignment (or several) and a `set -...`/`set -o ...` segment take no
        # action of their own and earn no allow entry of their own either.
        part = _strip_assignments(part)
        if not part or _is_set_options(part):
            continue
        ok, reason = judge_segment(part, rules, roots, cwd)
        reasons.append(reason)
        if not ok:
            return Decision(False, f"segment:{i}:{reason}", tuple(reasons))
    return Decision(True, "allow", tuple(reasons))
