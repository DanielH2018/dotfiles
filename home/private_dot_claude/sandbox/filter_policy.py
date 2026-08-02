"""What a Docker API request may ask for.

The filter's rules, with no sockets.

Loaded by docker-create-filter.py, which owns the HTTP side and calls inspect()
once per request. The two are separate because they fail in different ways and are
tested differently: everything here is a pure function over a decoded body, so a
rule can be exercised by handing it a dict, while the transport half needs a real
socket and a stub upstream to say anything meaningful.

Bind-mounted into the filter container beside docker-create-filter.py and canon.py,
which is why canon is loaded from an explicit path rather than imported — there is
no package in /opt and no sibling directory on sys.path.

WORKSPACE is read from the environment here rather than passed in, so the rules and
the process agree on one value. Tests set the module attribute directly.
"""

import importlib.util
import json
import os
import re


def _load_canon():
    """Load the canonicalize module from an explicit path.

    Both this file and canon.py are bind-mounted individually into the filter
    container, so there is no package to import from and no sibling directory on
    sys.path. CANON_LIB lets the tests point at the source tree.
    """
    path = os.environ.get("CANON_LIB") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "canon.py"
    )
    spec = importlib.util.spec_from_file_location("canon", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load canon library from {path!r}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


canon = _load_canon()

WORKSPACE = os.environ.get("FILTER_WORKSPACE", "")

# Docker clients prefix a negotiated API version: /v1.43/containers/create.
_V = r"(?:/v\d+(?:\.\d+)?)?"
CREATE_RE = re.compile(rf"^{_V}/containers/create(?:\?.*)?$")
START_RE = re.compile(rf"^{_V}/containers/[^/]+/start(?:\?.*)?$")
UPDATE_RE = re.compile(rf"^{_V}/containers/[^/]+/update(?:\?.*)?$")
VOLUME_CREATE_RE = re.compile(rf"^{_V}/volumes/create(?:\?.*)?$")

# HostConfig keys that hand out the host. Rejected whenever they carry a value.
FORBIDDEN_TRUE = ("Privileged",)
FORBIDDEN_NONEMPTY = (
    "CapAdd",
    "Devices",
    "DeviceCgroupRules",
    "DeviceRequests",
    "VolumesFrom",
    "Sysctls",
    "VolumeDriver",
)
# Namespace modes: only the daemon default (empty) or an explicitly private value.
HOST_MODES = ("PidMode", "IpcMode", "UsernsMode", "CgroupnsMode", "Cgroup", "UTSMode")


class Denied(Exception):
    """Raised with a message that is returned to the client as a 403 body."""


def _norm(path):
    """Absolute, symlink-resolved host path.

    realpath matters: the agent can write to the workspace, so it can drop a symlink
    pointing at / and bind THAT. The link resolves to a path outside the workspace
    prefix whichever filesystem resolves it, which is why the workspace is mounted
    into this container at its own host path.
    """
    return os.path.realpath(os.path.normpath(path))


def _under_workspace(path):
    if not WORKSPACE:
        return False
    root = _norm(WORKSPACE)
    target = _norm(path)
    return target == root or target.startswith(root.rstrip("/") + "/")


def _refuse_symlinked(source, what):
    """Deny a bind whose source has a symlink anywhere in it (A11-04).

    _under_workspace resolves the source and judges where it POINTS. That is only sound
    if nothing can re-point it afterwards, and something can: this filter decides at
    container-create, dockerd resolves again at container-start, and the agent can write
    to the workspace in between. A link that resolved inside the workspace at create can
    name / by the time it is mounted.

    Re-checking at start would only narrow the window. Refusing a source with any
    symlink component removes it — nothing is left to swap. The cost is that a
    legitimate symlinked path inside the workspace is refused too; that is the intended
    trade, and the message says so rather than leaving the caller to guess.
    """
    if canon.has_symlink_component(source):
        raise Denied(
            f"{what} {source!r} contains a symlink component; the target could be "
            "re-pointed between create and start. Bind the real path instead."
        )


def check_bind(spec):
    """A `Binds` entry: "source:target[:opts]". Source may be a named volume."""
    parts = spec.split(":")
    if len(parts) < 2:
        raise Denied(f"unparseable bind {spec!r}")
    source = parts[0]
    # No leading slash and no ./ prefix means a named volume, which lives in the
    # daemon's own storage rather than on the host filesystem.
    if not source.startswith(("/", "./", "../", "~")):
        return
    if not _under_workspace(source):
        raise Denied(f"bind source {source!r} is outside the workspace ({WORKSPACE!r})")
    _refuse_symlinked(source, "bind source")


def check_mount(mount):
    """A `Mounts` entry, the structured form of the same thing."""
    if not isinstance(mount, dict):
        raise Denied("Mounts entry is not an object")
    # Defaulting an unreadable Type to "volume" is how a bind used to pass as a volume:
    # `{"type":"bind"}` missed the exact-case lookup, fell through to the default, and
    # was checked as if it were a named volume.
    mtype = str(canon.cfget(mount, "Type") or "volume").lower()
    if mtype == "bind":
        source = canon.cfget(mount, "Source") or ""
        if not _under_workspace(source):
            raise Denied(
                f"bind mount {source!r} is outside the workspace ({WORKSPACE!r})"
            )
        _refuse_symlinked(source, "bind mount")
    elif mtype == "volume":
        # A `local` volume can be a bind in disguise: DriverConfig opts o=bind,device=/
        volume_options = canon.cfget(mount, "VolumeOptions") or {}
        driver_config = canon.cfget(volume_options, "DriverConfig") or {}
        opts = canon.cfget(driver_config, "Options") or {}
        if any(str(k).lower() in ("device", "o", "type") for k in opts):
            raise Denied(
                "volume DriverConfig options may not name a device or bind type"
            )
    elif mtype not in ("tmpfs", "npipe", "cluster"):
        raise Denied(f"unsupported mount type {mtype!r}")


def check_security_opt(values):
    for opt in values or []:
        text = str(opt)
        if text.startswith("no-new-privileges"):
            continue  # tightening, not loosening
        if (
            "unconfined" in text
            or text.startswith("seccomp=")
            or text.startswith("apparmor=")
        ):
            raise Denied(f"SecurityOpt {text!r} weakens confinement")
        if text.startswith("systempaths="):
            raise Denied(f"SecurityOpt {text!r} exposes masked system paths")


def check_create(body):
    # Every structural lookup goes through cfget: dockerd decodes this body with Go's
    # encoding/json, which matches field names case-insensitively, so reading exact
    # keys made every check below vacuous against `{"hostconfig":{"privileged":true}}`.
    cfg = canon.cfget(body, "HostConfig") or {}
    if not isinstance(cfg, dict):
        raise Denied("HostConfig is not an object")

    for key in FORBIDDEN_TRUE:
        if canon.cfget(cfg, key):
            raise Denied(f"HostConfig.{key} is not permitted in the sandbox")
    for key in FORBIDDEN_NONEMPTY:
        if canon.cfget(cfg, key):
            raise Denied(f"HostConfig.{key} is not permitted in the sandbox")

    for key in HOST_MODES:
        value = str(canon.cfget(cfg, key) or "")
        if value and value != "private":
            raise Denied(f"HostConfig.{key}={value!r} is not permitted in the sandbox")

    net = str(canon.cfget(cfg, "NetworkMode") or "")
    if net in ("host", "none:host") or net.startswith("container:"):
        raise Denied(f"HostConfig.NetworkMode={net!r} is not permitted in the sandbox")

    runtime = str(canon.cfget(cfg, "Runtime") or "")
    if runtime and runtime != "runc":
        raise Denied(f"HostConfig.Runtime={runtime!r} is not permitted in the sandbox")

    check_security_opt(canon.cfget(cfg, "SecurityOpt"))

    for bind in canon.cfget(cfg, "Binds") or []:
        check_bind(str(bind))
    for mount in canon.cfget(cfg, "Mounts") or []:
        check_mount(mount)


def check_volume_create(body):
    if str(body.get("Driver") or "local") != "local":
        raise Denied("only the local volume driver is permitted")
    opts = body.get("DriverOpts") or body.get("Options") or {}
    if any(str(k).lower() in ("device", "o", "type") for k in opts):
        raise Denied("volume options may not name a device or bind type")


def inspect(path, body_bytes):
    """Raise Denied if this request may not proceed. Unknown paths are not inspected."""
    # Match on the path the daemon's router will resolve, not the bytes on the wire:
    # `/v1.43/containers/%63reate` reaches the create handler but never matched
    # CREATE_RE. A target with no single decoding is refused rather than guessed at.
    try:
        path = canon.canon_target(path)
    except canon.CanonRejected as exc:
        raise Denied(str(exc)) from exc

    if CREATE_RE.match(path):
        checker = check_create
    elif VOLUME_CREATE_RE.match(path):
        checker = check_volume_create
    elif START_RE.match(path) or UPDATE_RE.match(path):
        # Pre-1.24 daemons accept a HostConfig on start, which would reintroduce
        # everything checked above after a clean create. Nothing legitimate sends one.
        if body_bytes.strip() not in (b"", b"{}", b"null"):
            raise Denied("a body on container start/update is not permitted")
        return
    else:
        return

    try:
        body = json.loads(body_bytes.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError) as exc:
        raise Denied(f"unparseable JSON body: {exc}") from exc
    if body is None:
        return
    if not isinstance(body, dict):
        raise Denied("request body is not an object")
    # A body with no single canonical reading is refused, not resolved: whichever way
    # this filter broke the tie, the daemon is free to break it the other way.
    try:
        checker(body)
    except canon.CanonRejected as exc:
        raise Denied(str(exc)) from exc
