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
import socket
import socketserver
import sys
import threading


def _load_policy():
    """Load the rules module from an explicit path.

    Same reason as canon.py: this file and filter_policy.py are bind-mounted into
    /opt individually, so there is no package to import from. POLICY_LIB lets the
    tests point at the source tree.
    """
    path = os.environ.get("POLICY_LIB") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "filter_policy.py"
    )
    spec = importlib.util.spec_from_file_location("filter_policy", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load policy library from {path!r}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy = _load_policy()

# Denied is the refusal type for the whole filter, not just the rules: the framing
# checks below raise it for a malformed request the rules never see. Bound locally
# so both halves spell it the same way.
Denied = policy.Denied
inspect = policy.inspect

LISTEN_PORT = int(os.environ.get("FILTER_LISTEN_PORT", "2375"))
UPSTREAM = os.environ.get("FILTER_UPSTREAM", "")


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
    if not policy.WORKSPACE:
        log("FILTER_WORKSPACE is empty — every bind mount will be refused")
    log(
        f"listening on :{LISTEN_PORT}, upstream {UPSTREAM}, "
        f"workspace {policy.WORKSPACE!r}"
    )
    with Server(("0.0.0.0", LISTEN_PORT), Handler) as server:
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
