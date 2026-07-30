#!/usr/bin/env python3
"""Standalone tests for docker-create-filter.py.

Run: python3 test_docker_create_filter.py

Two halves, because the filter has two ways to fail.

The checks decide what a create request is allowed to ask for. Those are tested
directly against HostConfig payloads.

The HTTP plumbing decides whether a request reaches the checks at all, and that is
where the dangerous bugs live: a proxy that splices a connection after the first
request lets a second one through unread, and one that disagrees with the daemon
about message framing can be smuggled past. Those are tested through a real socket
against a stub upstream, so a request that should never arrive can be shown not to.
"""

import http.client
import importlib.util
import json
import os
import shutil
import socketserver
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE = os.path.join(HERE, "docker-create-filter.py")
if not os.path.exists(MODULE):
    MODULE = os.path.join(HERE, "executable_docker-create-filter.py")

_spec = importlib.util.spec_from_file_location("docker_create_filter", MODULE)
flt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(flt)

WS = "/workspace/repo"


def denied(path, body):
    """Run one request through the checks; return the message, or None if allowed."""
    flt.WORKSPACE = WS
    payload = body if isinstance(body, bytes) else json.dumps(body).encode()
    try:
        flt.inspect(path, payload)
    except flt.Denied as exc:
        return str(exc)
    return None


def create(host_config):
    return {"Image": "alpine", "HostConfig": host_config}


# --- what a create request may ask for ----------------------------------------


def test_ordinary_compose_create_is_allowed():
    assert (
        denied(
            "/v1.43/containers/create",
            create(
                {
                    "Binds": [f"{WS}/src:/app:rw", "named_vol:/data"],
                    "PortBindings": {"80/tcp": [{"HostPort": "8080"}]},
                    "RestartPolicy": {"Name": "no"},
                }
            ),
        )
        is None
    )


def test_bind_of_host_root_is_refused():
    assert "outside the workspace" in denied(
        "/containers/create", create({"Binds": ["/:/host"]})
    )


def test_bind_of_the_docker_socket_is_refused():
    assert denied(
        "/containers/create",
        create({"Binds": ["/var/run/docker.sock:/var/run/docker.sock"]}),
    )


def test_traversal_out_of_the_workspace_is_refused():
    assert denied("/containers/create", create({"Binds": [f"{WS}/../../etc:/etc"]}))


def test_privileged_is_refused():
    assert "Privileged" in denied("/containers/create", create({"Privileged": True}))


def test_host_namespaces_are_refused():
    for key in ("PidMode", "IpcMode", "UsernsMode", "UTSMode", "CgroupnsMode"):
        assert denied("/containers/create", create({key: "host"})), key


def test_host_and_container_networking_are_refused():
    assert denied("/containers/create", create({"NetworkMode": "host"}))
    assert denied("/containers/create", create({"NetworkMode": "container:other"}))
    # A compose project's own bridge network is the normal case.
    assert denied("/containers/create", create({"NetworkMode": "proj_default"})) is None


def test_capabilities_and_devices_are_refused():
    assert denied("/containers/create", create({"CapAdd": ["SYS_ADMIN"]}))
    assert denied(
        "/containers/create", create({"Devices": [{"PathOnHost": "/dev/sda"}]})
    )
    assert denied("/containers/create", create({"DeviceCgroupRules": ["c 1:* rwm"]}))
    assert denied("/containers/create", create({"VolumesFrom": ["other"]}))


def test_a_non_default_runtime_is_refused():
    assert denied("/containers/create", create({"Runtime": "sysbox-runc"}))
    assert denied("/containers/create", create({"Runtime": "runc"})) is None


def test_confinement_may_be_tightened_but_not_loosened():
    assert (
        denied(
            "/containers/create", create({"SecurityOpt": ["no-new-privileges:true"]})
        )
        is None
    )
    assert denied("/containers/create", create({"SecurityOpt": ["seccomp=unconfined"]}))
    assert denied(
        "/containers/create", create({"SecurityOpt": ["apparmor=unconfined"]})
    )
    assert denied(
        "/containers/create", create({"SecurityOpt": ["systempaths=unconfined"]})
    )


def test_structured_mounts_get_the_same_treatment_as_binds():
    assert (
        denied(
            "/containers/create",
            create(
                {"Mounts": [{"Type": "bind", "Source": f"{WS}/src", "Target": "/app"}]}
            ),
        )
        is None
    )
    assert denied(
        "/containers/create",
        create({"Mounts": [{"Type": "bind", "Source": "/", "Target": "/host"}]}),
    )
    assert (
        denied(
            "/containers/create",
            create({"Mounts": [{"Type": "tmpfs", "Target": "/tmp"}]}),
        )
        is None
    )


def test_a_local_volume_may_not_be_a_bind_in_disguise():
    # `--opt device=/ --opt o=bind` makes a named volume mount the host root.
    assert denied(
        "/containers/create",
        create(
            {
                "Mounts": [
                    {
                        "Type": "volume",
                        "Target": "/host",
                        "VolumeOptions": {
                            "DriverConfig": {"Options": {"device": "/", "o": "bind"}}
                        },
                    }
                ]
            }
        ),
    )
    assert denied(
        "/volumes/create",
        {
            "Name": "escape",
            "Driver": "local",
            "DriverOpts": {"type": "none", "device": "/", "o": "bind"},
        },
    )
    assert denied("/volumes/create", {"Name": "plain"}) is None


def test_a_symlink_out_of_the_workspace_is_resolved_not_trusted():
    # The agent can write to the workspace, so it can drop a symlink to / and bind
    # that. Only realpath catches it — a prefix compare on the literal string does not.
    root = tempfile.mkdtemp()
    try:
        ws = os.path.join(root, "repo")
        os.makedirs(ws)
        os.symlink("/", os.path.join(ws, "escape"))
        flt.WORKSPACE = ws
        try:
            flt.inspect(
                "/containers/create",
                json.dumps(create({"Binds": [f"{ws}/escape:/host"]})).encode(),
            )
            raise AssertionError("symlink to / was accepted")
        except flt.Denied:
            pass
        # A real directory inside the workspace still works.
        os.makedirs(os.path.join(ws, "src"))
        flt.inspect(
            "/containers/create",
            json.dumps(create({"Binds": [f"{ws}/src:/app"]})).encode(),
        )
    finally:
        shutil.rmtree(root)
        flt.WORKSPACE = WS


def test_a_hostconfig_on_start_is_refused():
    # Pre-1.24 daemons honour a HostConfig on start, which would reinstate everything
    # rejected at create time. Nothing legitimate sends a body here.
    assert denied("/v1.20/containers/abc/start", {"Privileged": True})
    assert denied("/containers/abc/start", b"") is None
    assert denied("/containers/abc/start", b"{}") is None


def test_unrelated_endpoints_are_not_inspected():
    for path in (
        "/containers/json",
        "/v1.43/images/json",
        "/networks/create",
        "/_ping",
    ):
        assert denied(path, {"anything": True}) is None


def test_an_unparseable_create_body_is_refused_not_guessed():
    assert denied("/containers/create", b"{not json")
    assert denied("/containers/create", b"[]")


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


class Harness:
    def __init__(self):
        self.upstream = StubUpstream(("127.0.0.1", 0), StubHandler)
        self.upstream.seen = []
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        flt.UPSTREAM = f"127.0.0.1:{self.upstream.server_address[1]}"
        flt.WORKSPACE = WS
        self.proxy = flt.Server(("127.0.0.1", 0), flt.Handler)
        threading.Thread(target=self.proxy.serve_forever, daemon=True).start()
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
