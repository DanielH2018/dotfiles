#!/usr/bin/env python3
"""Whether a request reaches the filter's rules at all.

Run: python3 test_docker_create_filter.py

This is where the dangerous bugs live. A proxy that splices a connection after
the first request lets a second one through unread, and one that disagrees with
the daemon about message framing can be smuggled past. So these run through a
real socket against a stub upstream, and a request that should never arrive is
shown not to.

The rules those requests are judged by are tested separately, without sockets,
in test_filter_policy.py.
"""

import http.client
import importlib.util
import json
import os
import socketserver
import threading

HERE = os.path.dirname(os.path.abspath(__file__))


def _canon_lib():
    """canon.py sits somewhere different in each tree this suite runs from.

    Deployed it is under ~/.local/share; in the chezmoi source it is two levels
    up under dot_local; in the filter container both files are bind-mounted flat
    into /opt. Resolving all three is why the deployed copy of this suite used to
    die on import with a path that only ever existed in the source tree.
    """
    for candidate in (
        os.path.join(HERE, "canon.py"),
        os.path.join(HERE, "..", "..", "dot_local", "share", "canon", "canon.py"),
        os.path.expanduser("~/.local/share/canon/canon.py"),
    ):
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    raise SystemExit(f"{os.path.basename(__file__)}: cannot find canon.py")


os.environ.setdefault("CANON_LIB", _canon_lib())


def _load(filename, modname):
    """Load a sandbox module by path, under its source or deployed name."""
    path = os.path.join(HERE, filename)
    if not os.path.exists(path):
        path = os.path.join(HERE, "executable_" + filename)
    spec = importlib.util.spec_from_file_location(modname, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


flt = _load("docker-create-filter.py", "docker_create_filter")

WS = "/workspace/repo"


def create(host_config):
    return {"Image": "alpine", "HostConfig": host_config}


# --- whether a request reaches the checks at all -------------------------------


class StubUpstream(socketserver.ThreadingTCPServer):
    """Records every request line it is sent and answers 200 with a JSON body."""

    allow_reuse_address = True
    daemon_threads = True
    seen = None


class StubHandler(socketserver.BaseRequestHandler):
    def handle(self):
        f = self.request.makefile("rb")
        while True:
            line = f.readline(65536)
            if not line:
                return
            length = 0
            while True:
                header = f.readline(65536)
                if not header or header in (b"\r\n", b"\n"):
                    break
                if header.lower().startswith(b"content-length:"):
                    length = int(header.split(b":")[1].strip())
            if length:
                f.read(length)
            self.server.seen.append(line.split()[1].decode())
            body = b'{"Id":"stub"}'
            self.request.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                b"Content-Length: %d\r\n\r\n%s" % (len(body), body)
            )


# shutdown() cannot return until serve_forever's next poll, and that defaults to 0.5s.
# Two servers per harness across five harnesses made it ~4s of this file's 4.1s.
POLL_INTERVAL = 0.01


class Harness:
    def __init__(self):
        self.upstream = StubUpstream(("127.0.0.1", 0), StubHandler)
        self.upstream.seen = []
        threading.Thread(
            target=self.upstream.serve_forever,
            args=(POLL_INTERVAL,),
            daemon=True,
        ).start()
        flt.UPSTREAM = f"127.0.0.1:{self.upstream.server_address[1]}"
        flt.policy.WORKSPACE = WS
        self.proxy = flt.Server(("127.0.0.1", 0), flt.Handler)
        threading.Thread(
            target=self.proxy.serve_forever,
            args=(POLL_INTERVAL,),
            daemon=True,
        ).start()
        self.port = self.proxy.server_address[1]

    def close(self):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()


def test_a_benign_create_reaches_the_daemon():
    h = Harness()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=5)
        conn.request(
            "POST",
            "/v1.43/containers/create",
            json.dumps(create({"Binds": [f"{WS}/src:/app"]})),
            {"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        assert resp.status == 200, resp.status
        assert json.loads(resp.read())["Id"] == "stub"
        assert h.upstream.seen == ["/v1.43/containers/create"]
        conn.close()
    finally:
        h.close()


def test_a_rejected_create_never_reaches_the_daemon():
    h = Harness()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=5)
        conn.request(
            "POST",
            "/v1.43/containers/create",
            json.dumps(create({"Binds": ["/:/host"]})),
            {"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        assert resp.status == 403, resp.status
        assert "outside the workspace" in json.loads(resp.read())["message"]
        assert h.upstream.seen == [], h.upstream.seen
        conn.close()
    finally:
        h.close()


def test_a_second_request_on_one_connection_is_still_inspected():
    # The bug this exists to prevent: a proxy that relays raw bytes after the first
    # request never sees the second. Keep-alive makes that a one-line escape.
    h = Harness()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=5)
        conn.request("GET", "/v1.43/containers/json")
        assert conn.getresponse().read() is not None
        conn.request(
            "POST",
            "/v1.43/containers/create",
            json.dumps(create({"Privileged": True})),
            {"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        assert resp.status == 403, resp.status
        assert h.upstream.seen == ["/v1.43/containers/json"], h.upstream.seen
        conn.close()
    finally:
        h.close()


def test_a_chunked_create_body_is_still_parsed():
    h = Harness()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", h.port, timeout=5)
        payload = json.dumps(create({"Privileged": True})).encode()
        conn.putrequest("POST", "/v1.43/containers/create")
        conn.putheader("Transfer-Encoding", "chunked")
        conn.putheader("Content-Type", "application/json")
        conn.endheaders()
        conn.send(b"%x\r\n%s\r\n0\r\n\r\n" % (len(payload), payload))
        resp = conn.getresponse()
        assert resp.status == 403, resp.status
        assert h.upstream.seen == [], h.upstream.seen
        conn.close()
    finally:
        h.close()


def test_ambiguous_framing_is_refused():
    # Content-Length and Transfer-Encoding together is the classic smuggling setup:
    # if the filter and the daemon disagree on where the body ends, a second request
    # hides inside the first.
    h = Harness()
    try:
        import socket as _socket

        sock = _socket.create_connection(("127.0.0.1", h.port), timeout=5)
        body = json.dumps(create({"Privileged": True})).encode()
        sock.sendall(
            b"POST /v1.43/containers/create HTTP/1.1\r\nHost: x\r\n"
            b"Content-Length: %d\r\nTransfer-Encoding: chunked\r\n\r\n%s"
            % (len(body), body)
        )
        assert b"403" in sock.recv(4096)
        assert h.upstream.seen == [], h.upstream.seen
        sock.close()
    finally:
        h.close()

if __name__ == "__main__":
    ran = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            ran += 1
    print(f"OK {ran}")
