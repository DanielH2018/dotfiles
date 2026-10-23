#!/usr/bin/env python3
"""Standalone tests for the local changes to artifact-server/artifact_server.py.

Run: python3 test_artifact_server.py

Upstream (DanielH2018/Server) tests the index, metadata and /a/<host>/ routing.
This covers only what the local copy adds: the bare /<relpath> route that keeps
link-artifact.sh's URLs working, a root laid out the way serve-artifacts.sh lays
it out (one symlink per host), the loopback default bind, the Host/Origin guard
on a live server, and the star list's read-only mode. One star round trip also
runs here, because the port to 3.9 is local and upstream's tests never execute it.
"""

import http.client
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


def status_with(port, method, path, headers):
    """Return the status of a request sent with exactly the given Host and Origin.

    urllib always writes its own Host, so a forged one needs http.client.
    """
    conn = http.client.HTTPConnection("127.0.0.1", port)
    try:
        conn.putrequest(method, path, skip_host=True)
        for key, value in headers.items():
            conn.putheader(key, value)
        conn.endheaders()
        return conn.getresponse().status
    finally:
        conn.close()


def post_star(base, payload, ctype="application/json"):
    """Return the status of a POST /api/star, without raising on an HTTP error."""
    req = urllib.request.Request(
        base + "/api/star",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": ctype},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except urllib.error.HTTPError as err:
        return err.code


def main():
    tmp = tempfile.mkdtemp(prefix="artifact-server-test.")
    tree = os.path.join(tmp, "artifacts")
    root = os.path.join(tmp, "root")
    os.makedirs(os.path.join(tree, "sub"))
    os.makedirs(root)
    os.symlink(tree, os.path.join(root, HOST))
    with open(os.path.join(tree, "plan.html"), "w") as f:
        f.write("<html><head><title>A plan</title></head><body>plan</body></html>")
    with open(os.path.join(tree, "sub", "notes.md"), "w", newline="\n") as f:
        f.write("# Notes\n")
    with open(os.path.join(tmp, "secret.txt"), "w") as f:
        f.write("outside the tree")
    # Shaped the way link-artifact.sh appends it: plan.html moved from one repo to
    # another.
    repos_file = os.path.join(tmp, "repos.tsv")
    with open(repos_file, "w") as f:
        f.write("plan.html\told-repo\nplan.html\tmyrepo\n")

    # The module reads its configuration at import time, as it does under the hook.
    for name in ("ARTIFACTS_BIND", "ARTIFACTS_PORT", "ARTIFACTS_ALLOWED_ORIGINS"):
        os.environ.pop(name, None)
    os.environ["ARTIFACTS_ROOT"] = root
    os.environ["ARTIFACTS_LOCAL_HOST"] = HOST
    os.environ["ARTIFACTS_REPOS_FILE"] = repos_file
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.join(HERE, "artifact-server"))
    import artifact_server

    check(
        "binds loopback when ARTIFACTS_BIND is unset",
        artifact_server.BIND == "127.0.0.1",
    )
    check(
        "allows only the loopback origin on its own port by default",
        artifact_server.ALLOWED_ORIGINS == "http://127.0.0.1:8080",
    )

    artifact_server.Handler.cache = artifact_server.IndexCache(artifact_server.ROOT)
    server = artifact_server.ThreadingHTTPServer(
        ("127.0.0.1", 0), artifact_server.Handler
    )
    artifact_server.Handler.log_message = lambda *args: None
    port = server.server_address[1]
    # main() derives the list from ARTIFACTS_PORT; this server took a free port instead.
    artifact_server.Handler.allowed_origins = tuple(
        artifact_server.parse_allowed_origins(f"http://127.0.0.1:{port}")
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

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

        check(
            "a rebound hostname is refused before any route",
            status_with(port, "GET", "/plan.html", {"Host": f"evil.example:{port}"})
            == 403,
        )
        check(
            "a rebound hostname cannot reach the star endpoint",
            status_with(port, "POST", "/api/star", {"Host": f"evil.example:{port}"})
            == 403,
        )
        check(
            "a cross-origin request with the right Host is refused",
            status_with(
                port,
                "GET",
                "/api/index.json",
                {"Host": f"127.0.0.1:{port}", "Origin": "https://evil.example"},
            )
            == 403,
        )
        check(
            "a request with no Host is refused",
            status_with(port, "GET", "/healthz", {}) == 403,
        )
        check(
            "a localhost Host on the server's port is served",
            status_with(port, "GET", "/healthz", {"Host": f"localhost:{port}"}) == 200,
        )

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

        by_name = {a["name"]: a for a in index.get("artifacts", [])}
        check(
            "an artifact carries the repo its latest line names",
            by_name.get("plan.html", {}).get("repo") == "myrepo",
        )
        check(
            "an artifact with no recorded repo carries none",
            "repo" not in by_name.get("notes.md", {}),
        )
        check(
            "the repos facet lists only repos in use", index.get("repos") == ["myrepo"]
        )

        stars_file = os.path.join(tmp, "stars.txt")
        stars = artifact_server.StarStore(artifact_server.Path(stars_file))
        artifact_server.Handler.stars = stars
        artifact_server.Handler.cache = artifact_server.IndexCache(
            artifact_server.ROOT, stars
        )
        star = {"host": HOST, "path": "plan.html", "starred": True}
        check("a star posts through the symlinked root", post_star(base, star) == 200)
        with open(stars_file) as f:
            check(
                "the star is keyed by the symlink's label",
                f.read() == f"{HOST}/plan.html\n",
            )
        by_name = {
            a["name"]: a
            for a in json.loads(get(base, "/api/index.json")[1])["artifacts"]
        }
        check("the index shows the star", by_name["plan.html"]["starred"] is True)
        check(
            "a text/plain star is refused",
            post_star(base, {**star, "starred": False}, ctype="text/plain") == 415,
        )

        artifact_server.Handler.stars = artifact_server.StarStore(
            artifact_server.Path(stars_file), writable=False
        )
        artifact_server.Handler.cache = artifact_server.IndexCache(
            artifact_server.ROOT, artifact_server.Handler.stars
        )
        check(
            "a read-only store refuses to unstar",
            post_star(base, {**star, "starred": False}) == 403,
        )
        # By name, not position: the index sorts newest first, and the two fixtures
        # can be written within one mtime tick, so either may come first.
        index = json.loads(get(base, "/api/index.json")[1])
        by_name = {a["name"]: a for a in index["artifacts"]}
        check(
            "a read-only store still shows the star, without a toggle",
            by_name["plan.html"]["starred"] is True and index["star_writable"] is False,
        )
    finally:
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)

    finish()


if __name__ == "__main__":
    main()
