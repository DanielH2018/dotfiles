#!/usr/bin/env python3
"""Standalone tests for the local changes to artifact-server/artifact_server.py.

Run: python3 test_artifact_server.py

Upstream (DanielH2018/Server) tests the index, metadata and /a/<host>/ routing.
This covers only what the local copy adds: the bare /<relpath> route that keeps
link-artifact.sh's URLs working, a root laid out the way serve-artifacts.sh lays
it out (one symlink per host), and the loopback default bind.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request

from _testkit import check, finish

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = "testhost"


def get(base, path):
    """Return (status, body) for a GET, without raising on an HTTP error status."""
    try:
        with urllib.request.urlopen(base + path) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, b""


def main():
    tmp = tempfile.mkdtemp(prefix="artifact-server-test.")
    tree = os.path.join(tmp, "artifacts")
    root = os.path.join(tmp, "root")
    os.makedirs(os.path.join(tree, "sub"))
    os.makedirs(root)
    os.symlink(tree, os.path.join(root, HOST))
    with open(os.path.join(tree, "plan.html"), "w") as f:
        f.write("<html><head><title>A plan</title></head><body>plan</body></html>")
    with open(os.path.join(tree, "sub", "notes.md"), "w") as f:
        f.write("# Notes\n")
    with open(os.path.join(tmp, "secret.txt"), "w") as f:
        f.write("outside the tree")

    # The module reads its configuration at import time, as it does under the hook.
    os.environ.pop("ARTIFACTS_BIND", None)
    os.environ["ARTIFACTS_ROOT"] = root
    os.environ["ARTIFACTS_LOCAL_HOST"] = HOST
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.join(HERE, "artifact-server"))
    import artifact_server

    check(
        "binds loopback when ARTIFACTS_BIND is unset",
        artifact_server.BIND == "127.0.0.1",
    )

    artifact_server.Handler.cache = artifact_server.IndexCache(artifact_server.ROOT)
    server = artifact_server.ThreadingHTTPServer(
        ("127.0.0.1", 0), artifact_server.Handler
    )
    artifact_server.Handler.log_message = lambda *args: None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    try:
        status, body = get(base, "/plan.html")
        check(
            "a bare /<relpath> serves the local host's file",
            status == 200 and b"plan" in body,
        )

        status, body = get(base, "/sub/notes.md")
        check("a bare nested /<relpath> serves", status == 200 and body == b"# Notes\n")

        status, body = get(base, f"/a/{HOST}/plan.html")
        check("/a/<host>/<relpath> serves through the symlinked root", status == 200)

        status, body = get(base, "/")
        check(
            "/ serves the GUI, not a file from the tree",
            status == 200 and b"<html" in body,
        )

        status, _ = get(base, "/%2e%2e/secret.txt")
        check("an encoded .. on the bare route is refused", status == 404)

        status, _ = get(base, "/../secret.txt")
        check("a literal .. on the bare route is refused", status == 404)

        status, _ = get(base, "/api/nope")
        check("an unknown /api/ path is not looked up in the tree", status == 404)

        status, body = get(base, "/api/index.json")
        index = json.loads(body) if status == 200 else {}
        names = sorted(a["name"] for a in index.get("artifacts", []))
        check(
            "the index lists the symlinked host's files",
            names == ["notes.md", "plan.html"],
        )
        check("the index names the host from the symlink", index.get("hosts") == [HOST])
    finally:
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)

    finish()


if __name__ == "__main__":
    main()
