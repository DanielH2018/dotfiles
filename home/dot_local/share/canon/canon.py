"""Canonicalize an input before deciding on it.

A guard that inspects one form of an input while its consumer acts on another is not
a guard. This module owns "what form will the consumer see?" and nothing else — no
policy, no patterns, no tokenizing.

Two families live here so far:

  keys    Go's encoding/json matches struct fields case-insensitively, so a filter
          reading Python dict keys exactly is vacuous against `{"hostconfig": ...}`.
  target  An HTTP router decodes percent-escapes before routing, so a filter matching
          the raw request-target never sees `/containers/%63reate`.
"""

import os
import re

__all__ = ["CanonRejected", "cfget", "cfkeys", "canon_target", "has_symlink_component"]

_PERCENT = re.compile(r"%[0-9A-Fa-f]{2}")


class CanonRejected(ValueError):
    """The input has no single canonical form, so no decision may rest on it."""


def cfkeys(obj):
    """The case-folded key set of a mapping, for membership tests."""
    if not isinstance(obj, dict):
        return set()
    return {str(k).lower() for k in obj}


def cfget(obj, key, default=None):
    """Case-insensitive field lookup, matching Go's encoding/json.

    The unique case-insensitive match is used. Two sibling keys that fold together
    raise rather than resolve, and an exact match does not short-circuit that: Go
    decodes both into the same struct field, so the one appearing later in the
    document wins. Document order is not something a decision should rest on, so a
    body carrying both `HostConfig` and `hostconfig` has no single meaning and is
    refused.

    This is a lookup, deliberately not a recursive rebuild of the object. `Labels`,
    `Env` and `DriverOpts` are maps whose keys are user data — folding those would
    corrupt a legitimate request.
    """
    if not isinstance(obj, dict):
        return default
    folded = key.lower()
    hits = [k for k in obj if str(k).lower() == folded]
    if not hits:
        return default
    if len(hits) > 1:
        raise CanonRejected(f"ambiguous key {key!r}: {sorted(map(str, hits))!r}")
    return obj[hits[0]]


def canon_target(raw):
    """The path an HTTP router will route on, given a raw request-target.

    Percent-decoded exactly once — not to a fixpoint. Decoding repeatedly is its own
    bypass class (`%2570` -> `%70` -> `p`), and a router that decodes once would never
    see the doubly-decoded form. A target still holding an escape after one pass is
    therefore rejected rather than decoded again.
    """
    if not isinstance(raw, str):
        raise CanonRejected("request target is not a string")

    path = raw.split("#", 1)[0].split("?", 1)[0]
    try:
        decoded = _unquote_once(path)
    except ValueError as exc:
        raise CanonRejected(f"undecodable request target {raw!r}") from exc

    if _PERCENT.search(decoded):
        raise CanonRejected(f"doubly-encoded request target {raw!r}")
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in decoded):
        raise CanonRejected(f"control character in request target {raw!r}")

    segments = []
    for segment in decoded.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if segments:
                segments.pop()
            continue
        segments.append(segment)
    return "/" + "/".join(segments)


def has_symlink_component(path):
    """True if any component of `path` is a symlink, or cannot be proven not to be.

    Resolving a path and judging the RESULT is only sound when nothing can
    re-point it afterwards. A container bind is checked by the filter at create
    time and resolved AGAIN by dockerd at start time, and the agent can write to
    the workspace in between — so a symlink that resolved somewhere harmless at
    create can point anywhere by start (A11-04).

    Judging the components instead removes the window rather than narrowing it:
    a source with no symlink anywhere in it has nothing left to swap. That is why
    this returns a property of the path rather than a resolved location, and why
    the caller denies on true rather than re-resolving later.

    Deliberately NOT normpath'd first. normpath collapses `a/b/..` to `a`
    lexically, which would skip checking whether `a/b` is a symlink — precisely
    the component an attacker would plant. Each prefix is tested as written, so
    `..` is resolved by the filesystem against the real parent, which is what
    dockerd will do too.

    Fails closed: an OSError on any prefix (an unreadable parent, a loop) means
    the path cannot be proven safe, which is not the same as being safe.
    """
    text = os.path.expanduser(str(path))
    if not text.startswith("/"):
        # Join rather than abspath: abspath normpaths, and that is the collapse
        # this function exists to avoid.
        text = os.getcwd() + "/" + text
    prefix = "/"
    for part in text.split("/"):
        if not part or part == ".":
            continue
        prefix = prefix.rstrip("/") + "/" + part
        try:
            if os.path.islink(prefix):
                return True
        except OSError:
            return True
    return False


def _unquote_once(text):
    """Percent-decode one pass. A malformed escape is an error, not a literal."""
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch != "%":
            out.append(ch)
            i += 1
            continue
        escape = text[i + 1 : i + 3]
        if len(escape) < 2 or not all(c in "0123456789abcdefABCDEF" for c in escape):
            raise ValueError(f"malformed escape at offset {i}")
        out.append(chr(int(escape, 16)))
        i += 3
    return "".join(out)
