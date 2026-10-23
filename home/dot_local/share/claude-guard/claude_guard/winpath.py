"""Windows path spellings, shared by the checks that must tell an absolute path from a relative one.

Nothing here is consulted off win32: every caller gates on `sys.platform` first, or ORs the
helper behind a platform test, so POSIX behaviour is unchanged.
"""

import os
import re

# A drive-letter absolute path: `C:\x` or `C:/x`. The drive-relative `C:x` does not match.
DRIVE_ABS = re.compile(r"^[A-Za-z]:[\\/]")
# A drive with nothing below it: what `C:\` and `C:/` leave after the trailing slash is stripped.
DRIVE_ROOT = re.compile(r"^[A-Za-z]:$")


def is_drive_abs(path: str) -> bool:
    return DRIVE_ABS.match(path) is not None


_FILE_ATTRIBUTE_SYSTEM = 0x4
# The reparse tags realpath already follows: a symlink and a junction (mount point).
_REPARSE_FOLLOWED = (0xA000000C, 0xA0000003)


def opaque_component(prefix: str, real: str) -> bool:
    """True when a component of `real` below `prefix` is one `os.path.realpath` cannot see through.

    Cygwin and MSYS store a symlink as `name.lnk` (or a SYSTEM-attributed file) and bash
    follows it as `name`, so Python's resolution leaves it in place. A component is opaque
    when it is named `*.lnk`, when `<component>.lnk` exists beside it, when it is marked
    SYSTEM, or when it is a reparse point whose tag is neither a symlink nor a junction
    (cloud placeholders, app-execution aliases). Anything that cannot be statted counts as
    opaque, and a component that does not exist ends the walk. Either separator is accepted.
    Callers gate on win32.
    """
    prefix = prefix.replace("\\", "/").rstrip("/")
    rest = real.replace("\\", "/")
    if not rest.startswith(prefix + "/"):
        return True
    here = prefix
    for part in rest[len(prefix) :].strip("/").split("/"):
        here = f"{here}/{part}"
        if part.lower().endswith(".lnk") or os.path.lexists(here + ".lnk"):
            return True
        try:
            st = os.lstat(here)
        except FileNotFoundError:
            return False
        except OSError:
            return True
        tag = getattr(st, "st_reparse_tag", 0)
        if tag and tag not in _REPARSE_FOLLOWED:
            return True
        if getattr(st, "st_file_attributes", 0) & _FILE_ATTRIBUTE_SYSTEM:
            return True
    return False
