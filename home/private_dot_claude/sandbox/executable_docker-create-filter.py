#!/usr/bin/env python3
"""Body-inspecting Docker API filter.

Sits between the sandbox and linuxserver/socket-proxy. The socket proxy filters by
API PATH and never looks at a request BODY, so `POST /containers/create` reaches the
daemon with whatever HostConfig the caller asked for -- `Binds: ["/:/host"]`,
`Privileged: true`, `PidMode: "host"`. Creating such a container and starting it is
host-equivalent privilege, and it needs no `docker` binary, so none of the Bash guards
on the sandbox side ever see it.

This process reads those bodies and rejects the fields that cross the boundary, while
letting an ordinary compose workload through. It is deliberately a NARROWING filter in
front of the existing socket proxy, not a replacement for it: the path-level rules
(EXEC=0, BUILD=0, COMMIT=0) still apply behind this, so a bug here degrades to the
old behaviour rather than to something worse.

Stdlib only, matching the rest of the sandbox helpers.

Env:
  FILTER_LISTEN_PORT  port to listen on               (default 2375)
  FILTER_UPSTREAM     host:port of the socket proxy   (required)
  FILTER_WORKSPACE    host path binds may live under  (required; "" disables all binds)
"""

import contextlib
import importlib.util
import json
import os
import re
import socket
import socketserver
import sys
import threading


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

LISTEN_PORT = int(os.environ.get("FILTER_LISTEN_PORT", "2375"))
UPSTREAM = os.environ.get("FILTER_UPSTREAM", "")
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


# --- HTTP plumbing -------------------------------------------------------------
# Every request on a connection is parsed, never spliced: keep-alive means a benign
# GET and a create can share one connection, and splicing after the first would let
# the second past unread.


def read_head(sock_file):
    """Return (request_line, [header_lines]) or (None, None) at clean EOF."""
    line = sock_file.readline(65536)
    if not line:
        return None, None
    headers = []
    while True:
        header = sock_file.readline(65536)
        if not header:
            raise Denied("connection closed mid-header")
        headers.append(header)
        if header in (b"\r\n", b"\n"):
            return line, headers


def header_values(headers, name):
    key = name.lower().encode()
    out = []
    for raw in headers:
        if b":" not in raw:
            continue
        field, _, value = raw.partition(b":")
        if field.strip().lower() == key:
            out.append(value.strip())
    return out


def read_body(sock_file, headers):
    """Read exactly one message body. Ambiguous framing is refused, not guessed."""
    lengths = header_values(headers, "content-length")
    chunked = [v.lower() for v in header_values(headers, "transfer-encoding")]
    if lengths and chunked:
        raise Denied("both Content-Length and Transfer-Encoding present")
    if len(lengths) > 1 and len(set(lengths)) > 1:
        raise Denied("conflicting Content-Length headers")
    if chunked:
        if not any(v.endswith(b"chunked") for v in chunked):
            raise Denied("unsupported Transfer-Encoding")
        body = b""
        while True:
            size_line = sock_file.readline(65536)
            if not size_line:
                raise Denied("connection closed mid-chunk")
            try:
                size = int(size_line.split(b";")[0].strip() or b"0", 16)
            except ValueError as exc:
                raise Denied("malformed chunk size") from exc
            if size == 0:
                while True:  # trailers, then the final CRLF
                    trailer = sock_file.readline(65536)
                    if not trailer or trailer in (b"\r\n", b"\n"):
                        break
                return body
            body += sock_file.read(size)
            sock_file.read(2)  # CRLF after each chunk
    if not lengths:
        return b""
    try:
        length = int(lengths[0])
    except ValueError as exc:
        raise Denied("malformed Content-Length") from exc
    if length < 0:
        raise Denied("negative Content-Length")
    return sock_file.read(length)


def rebuild_head(request_line, headers, body):
    """Re-emit the head with a single, correct Content-Length for the body we read."""
    kept = [
        raw
        for raw in headers
        if raw not in (b"\r\n", b"\n")
        and raw.partition(b":")[0].strip().lower()
        not in (b"content-length", b"transfer-encoding")
    ]
    kept.append(b"Content-Length: %d\r\n" % len(body))
    return request_line + b"".join(kept) + b"\r\n"


def deny_response(message):
    payload = json.dumps(
        {"message": f"blocked by claude-sandbox docker filter: {message}"}
    )
    body = payload.encode()
    return (
        b"HTTP/1.1 403 Forbidden\r\n"
        b"Content-Type: application/json\r\n"
        b"Content-Length: %d\r\n"
        b"Connection: close\r\n\r\n%s" % (len(body), body)
    )


def pump(src, dst):
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            with contextlib.suppress(OSError):
                s.shutdown(socket.SHUT_RDWR)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        host, _, port = UPSTREAM.rpartition(":")
        try:
            upstream = socket.create_connection((host, int(port)), timeout=60)
        except OSError as exc:
            self.request.sendall(deny_response(f"upstream unreachable: {exc}"))
            return
        try:
            self.proxy(upstream)
        finally:
            for s in (upstream, self.request):
                with contextlib.suppress(OSError):
                    s.close()

    def proxy(self, upstream):
        client_file = self.request.makefile("rb")
        up_file = upstream.makefile("rb")
        while True:
            try:
                request_line, headers = read_head(client_file)
            except Denied as exc:
                self.request.sendall(deny_response(str(exc)))
                return
            if request_line is None:
                return

            parts = request_line.split()
            path = parts[1].decode("latin1") if len(parts) > 1 else "/"

            try:
                body = read_body(client_file, headers)
                inspect(path, body)
            except Denied as exc:
                log(f"DENY {path}: {exc}")
                self.request.sendall(deny_response(str(exc)))
                return

            upstream.sendall(rebuild_head(request_line, headers, body) + body)

            try:
                status_line, resp_headers = read_head(up_file)
            except Denied:
                return
            if status_line is None:
                return
            self.request.sendall(status_line + b"".join(resp_headers))

            if b" 101 " in status_line:
                # Protocol upgrade (attach/hijack): the connection stops being HTTP,
                # so it is now dedicated and raw relaying is safe.
                threading.Thread(
                    target=pump, args=(upstream, self.request), daemon=True
                ).start()
                pump(self.request, upstream)
                return

            if not self.relay_response(up_file, resp_headers, status_line):
                return

    def relay_response(self, up_file, resp_headers, status_line):
        """Forward one response body. Returns False when the connection must close."""
        code = status_line.split()[1] if len(status_line.split()) > 1 else b"200"
        chunked = any(
            v.lower().endswith(b"chunked")
            for v in header_values(resp_headers, "transfer-encoding")
        )
        lengths = header_values(resp_headers, "content-length")
        if code in (b"204", b"304"):
            return True
        if chunked:
            while True:
                size_line = up_file.readline(65536)
                if not size_line:
                    return False
                self.request.sendall(size_line)
                try:
                    size = int(size_line.split(b";")[0].strip() or b"0", 16)
                except ValueError:
                    return False
                if size == 0:
                    while True:
                        trailer = up_file.readline(65536)
                        if not trailer:
                            return False
                        self.request.sendall(trailer)
                        if trailer in (b"\r\n", b"\n"):
                            return True
                remaining = size + 2
                while remaining > 0:
                    chunk = up_file.read(min(65536, remaining))
                    if not chunk:
                        return False
                    self.request.sendall(chunk)
                    remaining -= len(chunk)
        if lengths:
            try:
                remaining = int(lengths[0])
            except ValueError:
                return False
            while remaining > 0:
                chunk = up_file.read(min(65536, remaining))
                if not chunk:
                    return False
                self.request.sendall(chunk)
                remaining -= len(chunk)
            return True
        # Neither framing header: the body runs to EOF, so this connection is over.
        while True:
            chunk = up_file.read(65536)
            if not chunk:
                return False
            self.request.sendall(chunk)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def log(message):
    sys.stderr.write(f"docker-create-filter: {message}\n")
    sys.stderr.flush()


def main():
    if not UPSTREAM:
        log("FILTER_UPSTREAM is required")
        return 1
    if not WORKSPACE:
        log("FILTER_WORKSPACE is empty — every bind mount will be refused")
    log(f"listening on :{LISTEN_PORT}, upstream {UPSTREAM}, workspace {WORKSPACE!r}")
    with Server(("0.0.0.0", LISTEN_PORT), Handler) as server:
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
