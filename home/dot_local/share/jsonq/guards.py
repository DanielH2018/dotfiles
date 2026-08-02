"""Arithmetic that can turn a short expression into unbounded work."""

from _jsonq.errors import JsonqError
from _jsonq.limits import MAX_INT_BITS, MAX_INT_DIGITS, MAX_SEQUENCE


def _pow(base, exp, mod=None):
    """`**`. Modular exponentiation is bounded by the modulus, so only the
    plain form needs a width check."""
    if mod is not None:
        return pow(base, exp, mod)
    if (isinstance(base, int) and isinstance(exp, int) and exp > 0
            and exp * max(base.bit_length(), 1) > MAX_INT_BITS):
        raise JsonqError("refusing to compute an integer that large")
    return base**exp


def _lshift(left, right):
    if isinstance(left, int) and isinstance(right, int) and right > MAX_INT_BITS:
        raise JsonqError("refusing to compute an integer that large")
    return left << right


def _mul(left, right):
    """`*`. Sequence repetition is the cheap way to ask for 40 GB of string."""
    for seq, count in ((left, right), (right, left)):
        if (isinstance(seq, (str, bytes, list, tuple)) and isinstance(count, int)
                and count > 0 and len(seq) * count > MAX_SEQUENCE):
            raise JsonqError("refusing to build a sequence that large")
    return left * right


def _range(*args):
    span = range(*args)
    if len(span) > MAX_SEQUENCE:
        raise JsonqError(f"range() of {len(span)} exceeds the {MAX_SEQUENCE} cap")
    return list(span)


def _int(value, *args, **kwargs):
    """int(). Parsing a very long digit string is quadratic and happens in C,
    where SIGALRM cannot reach it. 3.11+ refuses this itself; do it on 3.9 too."""
    if isinstance(value, str) and len(value.strip()) > MAX_INT_DIGITS:
        raise JsonqError("refusing to parse an integer that long")
    return int(value, *args, **kwargs)
