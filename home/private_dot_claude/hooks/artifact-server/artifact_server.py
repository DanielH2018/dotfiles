#!/usr/bin/env python3
"""Serve ~/.claude/artifacts from every homelab host at one authenticated URL.

Claude Code writes plan/spec/review artifacts to `~/.claude/artifacts` on each host
(artifact-design skill). Locally they are reachable over a loopback python -m http.server,
which only works from a terminal on that host. This serves the same trees behind Traefik +
Authelia, with a browsable index and search across every host's artifacts.

Layout: each host's tree is mounted read-only at ROOT/<host>, so a URL carries the host
that wrote the file:

    /                       the GUI
    /api/index.json         the index every search reads
    /api/star               POST: star or unstar one artifact (see StarStore)
                            GET ?host=&path=: that artifact's star, and whether it can change
    /api/star.js            the star button each served HTML artifact loads
    /api/trash              POST: move one local artifact into its tree's .trash/ (see Trash)
    /api/restore            POST: move one trashed artifact back where it was
    /a/<host>/<relpath>     one artifact, served from ROOT/<host>/<relpath>
    /healthz                liveness

Upstream writes only the star list, and every artifact tree stays mounted read-only there;
the list lives in its own file, ARTIFACTS_STARS_FILE, which retention-sweep on each host
reads so that a starred artifact is never aged out. The local copy also writes the local
host's own tree when ARTIFACTS_TRASH=1, and only to move a file into `.trash/` or back.

The index is built ON REQUEST and cached against a signature of (path, mtime, size) for
every file under ROOT. It is not built on a timer: retention-sweep deletes artifacts after
30 days, so a timer-built index serves links to files that are already gone. Building on
request cannot. ~50 files parse in single-digit milliseconds.

Two siblings ship beside this one in the same ConfigMap: `artifact_meta.py` holds the
taxonomy and the metadata parsers, and `_gui_html.py` holds the page served at `/`.

Local copy: vendored from DanielH2018/Server ansible/roles/k8s/artifacts/files/ at 977d9bf3ab41
and started by serve-artifacts.sh on each workstation. The star list (StarStore, POST
/api/star) was ported from upstream later, in DanielH2018/Server#4430. It differs from upstream
in eight places:

- It binds ARTIFACTS_BIND, default 127.0.0.1. Upstream binds 0.0.0.0 inside a pod; a laptop
  must never serve these documents to the LAN.
- ARTIFACTS_LOCAL_HOST names the one host tree that also answers a bare /<relpath>.
  link-artifact.sh emits http://127.0.0.1:<port>/<relpath>, which `http.server` served before
  this did, and every link already in a transcript keeps working.
- The multi-except clauses are parenthesised, and artifact_meta.py defers annotations, because
  macOS's /usr/bin/python3 is 3.9.
- Each local artifact carries the repository its session worked in, read from
  ARTIFACTS_REPOS_FILE, and the GUI filters and sorts on it. Upstream has no such field.
- ARTIFACTS_STARS_READONLY=1 shows the star list without letting the GUI change it.
  serve-artifacts.sh sets it on the k3s nodes, where the cluster's browser owns the list.
- Every request must carry a Host, and any Origin, from ARTIFACTS_ALLOWED_ORIGINS, so a
  DNS-rebound page cannot read a loopback server (host_guard.py). The default is
  http://127.0.0.1:<ARTIFACTS_PORT>, which `localhost` also matches. The pod would need
  its public and LAN names listed there, and its probes a matching Host header.
- Each HTML artifact is served with one added `<script src="/api/star.js">` tag, so the page
  can be starred where it is read. The file on disk is never changed, so a copied artifact
  carries no button. The tag is added only when a star list is configured.
- ARTIFACTS_TRASH=1 lets the GUI move a LOCAL_HOST artifact into `<tree>/.trash/` and back
  (Trash). A file under `.trash/` is indexed with `trashed: true` and its original path.
"""

from __future__ import annotations

import contextlib
import html
import json
import os
import posixpath
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

# Flat siblings in the same directory, mounted together at /app from one ConfigMap, so a
# plain import resolves each under `python3 /app/artifact_server.py` and under the tests'
# path insert. None of them imports back.
from _gui_html import GUI_HTML, STAR_JS
from artifact_meta import (
    apply_metadata,
    load_known_services,
    parse_html,
    parse_markdown,
    slug_title,
)
from host_guard import Allowed, check_host, parse_allowed_origins

ROOT = Path(os.environ.get("ARTIFACTS_ROOT", "/srv/artifacts"))
PORT = int(os.environ.get("ARTIFACTS_PORT", "8080"))
BIND = os.environ.get("ARTIFACTS_BIND", "127.0.0.1")
LOCAL_HOST = os.environ.get("ARTIFACTS_LOCAL_HOST", "")
# link-artifact.sh appends `<relpath>\t<repo>` here each time a session writes an artifact,
# naming the repository the session was working in. Unset or absent means no repo facet.
REPOS_FILE = os.environ.get("ARTIFACTS_REPOS_FILE", "")
STARS_FILE = os.environ.get("ARTIFACTS_STARS_FILE", "")
STARS_READONLY = os.environ.get("ARTIFACTS_STARS_READONLY", "") == "1"
TRASH_ENABLED = os.environ.get("ARTIFACTS_TRASH", "") == "1"
# Inside each host's tree, so retention-sweep's `~/.claude/artifacts/**/*` row ages trashed
# files out like any other. Trash touches the mtime, which gives each one 30 days to restore.
TRASH_DIR = ".trash"
# Comma-separated origins whose Host and Origin this server answers to (host_guard.py).
# Behind a reverse proxy, list every name the proxy forwards with its Host intact.
ALLOWED_ORIGINS = os.environ.get(
    "ARTIFACTS_ALLOWED_ORIGINS", f"http://127.0.0.1:{PORT}"
)
# A star or trash request carries one host and one relpath, so anything larger is not one.
MAX_JSON_BODY = 4096


def load_repos(path: str = REPOS_FILE) -> dict[str, str]:
    """Map each artifact's relpath to the repository that last wrote it.

    The file is append-only, so a later line for the same relpath wins: an artifact
    rewritten from a second repository moves to it.
    """
    repos: dict[str, str] = {}
    if not path:
        return repos
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return repos
    for line in text.splitlines():
        rel, sep, repo = line.partition("\t")
        if sep and rel and repo.strip():
            repos[rel] = repo.strip()
    return repos


INDEXABLE = {
    ".html",
    ".htm",
    ".md",
    ".txt",
    ".svg",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
}
# Only these are parsed for metadata; the rest are listed with filesystem facts alone.
PARSEABLE = {".html", ".htm", ".md"}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".json": "application/json",
}


def scan(root: Path) -> list[tuple[str, Path, os.stat_result]]:
    """Every indexable file under root, as (host, path, stat), sorted for a stable signature."""
    found: list[tuple[str, Path, os.stat_result]] = []
    if not root.is_dir():
        return found
    for host_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for path in sorted(host_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in INDEXABLE:
                continue
            try:
                found.append((host_dir.name, path, path.stat()))
            except OSError:
                # A file pruned between the walk and the stat is simply not indexed.
                continue
    return found


class StarStore:
    """The starred artifacts, one `<host>/<relpath>` line each, in a single file.

    `<host>` is the ROOT/<host> segment, which is also the label each host's
    retention-sweep carries (CLAUDE_ARTIFACTS_HOST). The sweep keeps every artifact whose
    line names its own label, so one file serves every host it reaches.

    Attributes:
        path: The star file. A missing file means nothing is starred.
        writable: Whether POST /api/star may change the file.
    """

    def __init__(self, path: Path, writable: bool = True) -> None:
        self.path = path
        self.writable = writable
        # ThreadingHTTPServer handles requests concurrently, and two stars landing in the same
        # read-modify-write would lose one of them.
        self._lock = threading.Lock()

    def signature(self) -> tuple[int, int] | None:
        """The file's (mtime_ns, size), or None when it does not exist."""
        try:
            st = self.path.stat()
        except OSError:
            return None
        return st.st_mtime_ns, st.st_size

    def load(self, strict: bool = False) -> set[str]:
        """Reads the starred keys.

        Args:
            strict: Raise on a read error other than a missing file. `mark` reads strictly,
                because writing back an empty list over an unreadable one unstars everything.

        Returns:
            The set of `<host>/<relpath>` keys; empty when the file does not exist.

        Raises:
            OSError: `strict` is set and the file exists but cannot be read.
        """
        try:
            text = self.path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return set()
        except OSError:
            if strict:
                raise
            return set()
        return {line for line in text.splitlines() if line.strip()}

    def mark(self, key: str, starred: bool) -> None:
        """Adds or removes one key and replaces the file atomically.

        The new list is written beside the old one and renamed over it, so a prune reading
        the file mid-write sees one whole list or the other. A torn read would drop stars for
        that sweep, and dropping a star is how a starred artifact gets deleted.

        Raises:
            OSError: The file cannot be read, or its directory cannot be written.
        """
        with self._lock:
            keys = self.load(strict=True)
            if starred:
                keys.add(key)
            else:
                keys.discard(key)
            fd, tmp = tempfile.mkstemp(prefix=".stars.", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write("".join(f"{k}\n" for k in sorted(keys)))
                # mkstemp creates 0600. The agent user's prune on daniel-box reads this file
                # as another uid, and it lists file names, not secrets.
                os.chmod(tmp, 0o644)
                os.replace(tmp, self.path)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise


class Trash:
    """Moves artifacts of one host's tree into `<tree>/.trash/<relpath>` and back.

    A trashed `.html` takes the `.md` of the same stem with it, because the GUI shows the two
    as one document. Trashing over an earlier trashed copy replaces it; restoring onto a
    path that holds a file again is refused, so a restore never overwrites.

    Attributes:
        host: The ROOT/<host> label whose tree this changes; every other host is refused.
        tree: That tree's real directory.
    """

    def __init__(self, host: str, tree: Path) -> None:
        self.host = host
        self.tree = tree
        self._bin = tree / TRASH_DIR
        # Two moves of the same file racing would each see the other's source vanish.
        self._lock = threading.Lock()

    def _place(self, rel: str, trashed: bool) -> Path:
        return self._bin / rel if trashed else self.tree / rel

    def with_companion(self, rel: str, trashed: bool) -> list[str]:
        """`rel`, plus the `.md` beside it when `rel` is an `.html` that has one."""
        rels = [rel]
        stem, ext = posixpath.splitext(rel)
        if ext.lower() in (".html", ".htm"):
            md = self._place(stem + ".md", trashed)
            if md.is_file() and not md.is_symlink():
                rels.append(stem + ".md")
        return rels

    def move(self, rels: list[str], restore: bool) -> None:
        """Moves every relpath in `rels` into the trash, or out of it when `restore`.

        Raises:
            FileExistsError: `restore` is set and a file already sits at a target.
            OSError: A move failed, or a target directory resolves outside the tree.
        """
        with self._lock:
            pairs = [
                (self._place(r, restore), self._place(r, not restore)) for r in rels
            ]
            if restore:
                for _, dst in pairs:
                    if dst.exists() or dst.is_symlink():
                        raise FileExistsError(f"{dst} already exists")
            for src, dst in pairs:
                dst.parent.mkdir(parents=True, exist_ok=True)
                # A `.trash` symlinked out of the tree would carry the file off with it.
                parent = os.path.realpath(dst.parent)
                if not (parent + os.sep).startswith(str(self.tree) + os.sep):
                    raise OSError(f"{dst.parent} resolves outside {self.tree}")
                os.replace(src, dst)
                if not restore:
                    os.utime(dst)
            if restore:
                for src, _ in pairs:
                    self._prune(src.parent)

    def _prune(self, directory: Path) -> None:
        """Removes the empty directories a restore leaves under the trash."""
        while directory != self._bin and self._bin in directory.parents:
            try:
                directory.rmdir()
            except OSError:
                return
            directory = directory.parent


def build_index(
    root: Path,
    known_services: list[str] | None = None,
    repos: dict[str, str] | None = None,
    stars: StarStore | None = None,
    trash_host: str = "",
) -> dict:
    """Scans `root` and builds the searchable index of every artifact under it.

    Parses each HTML/Markdown file for title, summary, and metadata (matched against
    `known_services`, loaded from disk when not given), and flags a Markdown file with an
    HTML companion of the same stem so the GUI can fold the duplicate away.

    Args:
        root: Directory containing one subdirectory per host.
        known_services: Service names to match against metadata; loaded via
            load_known_services() when None.
        repos: Relpath to repository name for LOCAL_HOST's artifacts; loaded via
            load_repos() when None.
        stars: The star list each entry's `starred` flag reads; None stars nothing and
            reports starring as unavailable.
        trash_host: The host whose artifacts the GUI may trash; empty turns trash off.

    Returns:
        The index dict, with keys `generated`, `count`, `hosts`, `repos`, `categories`,
        `statuses`, `star_writable`, `trash_host` and `artifacts`. An artifact under a
        host's `.trash/` carries `trashed: true` and the relpath it is restored to.
    """
    known = load_known_services() if known_services is None else known_services
    repos = load_repos() if repos is None else repos
    starred = stars.load() if stars else set()
    entries = []
    for host, path, st in scan(root):
        stored = path.relative_to(root / host).as_posix()
        trashed = stored.startswith(TRASH_DIR + "/")
        rel = stored[len(TRASH_DIR) + 1 :] if trashed else stored
        suffix = path.suffix.lower()
        entry = {
            "host": host,
            "name": path.name,
            "path": rel,
            "url": f"/a/{host}/{stored}",
            "kind": suffix.lstrip("."),
            "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
            "starred": not trashed and f"{host}/{rel}" in starred,
            "trashed": trashed,
        }
        if host == LOCAL_HOST and rel in repos:
            entry["repo"] = repos[rel]
        if suffix in PARSEABLE:
            try:
                body = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                body = ""
            entry.update(parse_html(body) if suffix != ".md" else parse_markdown(body))
        entry.setdefault("title", slug_title(path.name))
        entry.setdefault("summary", "")
        if suffix in PARSEABLE:
            apply_metadata(entry, body, suffix == ".md", known)
        # An .md alongside an .html of the same stem is the same document — the skill writes
        # both. Flagged so the GUI can fold the Markdown copy away by default.
        entry["companion_html"] = (
            suffix == ".md" and (path.parent / (path.stem + ".html")).exists()
        )
        entries.append(entry)
    entries.sort(key=lambda e: e["mtime"], reverse=True)
    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "count": len(entries),
        "hosts": sorted({e["host"] for e in entries}),
        "repos": sorted({e["repo"] for e in entries if e.get("repo")}),
        # Facet values come from what the corpus actually holds, not a fixed vocabulary, so a
        # category nothing uses never appears as a dead dropdown entry.
        "categories": sorted({e["category"] for e in entries if e.get("category")}),
        "statuses": sorted({e["status"] for e in entries if e.get("status")}),
        "star_writable": bool(stars and stars.writable),
        "trash_host": trash_host,
        "artifacts": entries,
    }


class IndexCache:
    """Rebuilds only when a file under root, or the star list, was added, removed, or changed."""

    def __init__(
        self, root: Path, stars: StarStore | None = None, trash_host: str = ""
    ) -> None:
        self.root = root
        self.stars = stars
        self.trash_host = trash_host
        self._signature: tuple | None = None
        self._index: dict | None = None

    def signature(self) -> tuple:
        files = tuple(
            (host, str(path), st.st_mtime_ns, st.st_size)
            for host, path, st in scan(self.root)
        )
        # The repo map changes without any artifact changing when a backfill rewrites it.
        try:
            st = os.stat(REPOS_FILE) if REPOS_FILE else None
        except OSError:
            st = None
        repos_sig = (st.st_mtime_ns, st.st_size) if st else None
        # A star changes no artifact, so without the list's own stat a toggle would never
        # reach the cached index.
        return files, repos_sig, self.stars.signature() if self.stars else None

    def get(self) -> dict:
        sig = self.signature()
        if sig != self._signature or self._index is None:
            self._index = build_index(
                self.root, stars=self.stars, trash_host=self.trash_host
            )
            self._signature = sig
        return self._index


def safe_path(root: Path, host: str, rel: str) -> Path | None:
    """Resolve /a/<host>/<rel> under root, or None if it escapes or does not exist.

    Traversal is rejected by resolving both sides and comparing prefixes, so `..`, an
    absolute path, and a symlink pointing out of the tree are all refused.

    DECIDED: the check is `os.path.realpath` then `str.startswith`, not `Path.resolve` then
    a `parents` test. Both reject the same inputs; only the first is the shape CodeQL's
    `py/path-injection` query recognises as a sanitizer (its normalization step is
    `os.path.normpath|abspath|realpath`, its safe-access check is `startswith`, and it models
    neither `Path.resolve` nor `Path.parents`). The pathlib form carried five hand-dismissed
    alerts that came back on every refactor. Full reasoning: ADR-0016.
    """
    if not host or "/" in host or host in (".", ".."):
        return None
    base = os.path.realpath(os.path.join(root, host))
    try:
        resolved = os.path.realpath(os.path.join(base, rel))
    except (OSError, ValueError):
        return None
    if not resolved.startswith(base + os.sep):
        return None
    target = Path(resolved)
    if not target.is_file():
        return None
    return target


def add_star_tag(body: bytes, host: str, rel: str) -> bytes:
    """Inserts the star button's script tag before the page's last `</body>`, or at the end."""
    tag = (
        f'<script src="/api/star.js" data-host="{html.escape(host)}" '
        f'data-path="{html.escape(rel)}" defer></script>'
    ).encode()
    at = body.lower().rfind(b"</body>")
    return body + tag if at < 0 else body[:at] + tag + body[at:]


def render_gui() -> bytes:
    return GUI_HTML.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    """Serves the GUI, index JSON, health check and stored artifacts, and takes star toggles.

    Attributes:
        cache: The shared IndexCache instance serving /api/index.json.
        stars: The star list POST /api/star changes; None turns starring off.
        trash: The tree POST /api/trash and /api/restore change; None turns trash off.
        allowed_origins: The origins every request's Host and Origin must match; empty
            refuses every request.
    """

    server_version = "artifacts/1.0"
    cache: IndexCache = None  # type: ignore[assignment]
    stars: StarStore | None = None
    trash: Trash | None = None
    allowed_origins: tuple[Allowed, ...] = ()

    # `format` shadows the builtin, and is the parameter name BaseHTTPRequestHandler.log_message
    # declares — renaming it makes this an incompatible override.
    def log_message(self, format: str, *args: object) -> None:
        # One line per request on stdout, so `kubectl logs` reads like every other workload
        # here rather than BaseHTTPRequestHandler's stderr format.
        print(f"{self.address_string()} {format % args}", flush=True)

    def _send(
        self, status: int, body: bytes, ctype: str, extra: dict | None = None
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # These artifacts are internal reviews and audits behind Authelia; keep them out of
        # search engines even if the route is ever widened.
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def parse_request(self) -> bool:
        """Refuses a request whose Host or Origin is not allowed, whatever its method.

        Runs before any do_* method, so no route can be reached without the check.
        """
        if not super().parse_request():
            return False
        reason = check_host(self.headers, self.allowed_origins)
        if reason is not None:
            self.close_connection = True
            self._send(403, f"{reason}\n".encode(), "text/plain; charset=utf-8")
            return False
        return True

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        """Routes the request path to the GUI, health check, index JSON, or a stored artifact."""
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/index.html"):
            self._send(200, render_gui(), "text/html; charset=utf-8")
            return
        if path == "/healthz":
            self._send(200, b"ok\n", "text/plain; charset=utf-8")
            return
        if path == "/api/star":
            self._get_star()
            return
        if path == "/api/star.js":
            self._send(200, STAR_JS.encode("utf-8"), "text/javascript; charset=utf-8")
            return
        if path == "/api/index.json":
            body = json.dumps(self.cache.get()).encode("utf-8")
            self._send(200, body, "application/json")
            return
        if path.startswith("/a/"):
            self._serve_artifact(path[len("/a/") :])
            return
        if LOCAL_HOST and not path.startswith("/api/"):
            self._serve_artifact(LOCAL_HOST + path)
            return
        self._send(404, b"not found\n", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        """Routes a POST to the star toggle or to trash and restore."""
        route = unquote(urlparse(self.path).path)
        if route == "/api/star":
            self._post_star()
        elif route in ("/api/trash", "/api/restore"):
            self._post_trash(restore=route == "/api/restore")
        else:
            self._send(404, b"not found\n", "text/plain; charset=utf-8")

    def _read_json(self) -> dict | None:
        """Reads a JSON object body, or answers 415/400 and returns None."""
        text = "text/plain; charset=utf-8"
        # The JSON content type is the CSRF defence. Another origin can POST a form or
        # text/plain without asking, but a JSON body needs a CORS preflight, which this
        # server never answers, so the browser never sends the request.
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self._send(415, b"send application/json\n", text)
            return None
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_JSON_BODY:
            self._send(400, b"bad Content-Length\n", text)
            return None
        try:
            payload = json.loads(self.rfile.read(length))
        except ValueError:
            payload = None
        if not isinstance(payload, dict):
            self._send(400, b"expected a JSON object\n", text)
            return None
        return payload

    def _post_star(self) -> None:
        """Stars or unstars one artifact from a `{"host", "path", "starred"}` JSON body.

        Answers 200 with the stored state, 403 when starring is off, 415 for a non-JSON
        body, 400 for a malformed one, and 404 when host/path names no artifact.
        """
        text = "text/plain; charset=utf-8"
        stars = self.stars
        if stars is None or not stars.writable:
            self._send(403, b"starring is not enabled on this server\n", text)
            return
        payload = self._read_json()
        if payload is None:
            return
        host, rel, starred = (payload.get(k) for k in ("host", "path", "starred"))
        if not (
            isinstance(host, str) and isinstance(rel, str) and isinstance(starred, bool)
        ):
            self._send(400, b"expected {host, path, starred}\n", text)
            return
        rel = self._star_rel(host, rel)
        if rel is None:
            self._send(404, b"no such artifact\n", text)
            return
        try:
            stars.mark(f"{host}/{rel}", starred)
        except OSError as err:
            self._send(500, f"could not write the star list: {err}\n".encode(), text)
            return
        body = json.dumps({"host": host, "path": rel, "starred": starred})
        self._send(200, body.encode("utf-8"), "application/json")

    def _post_trash(self, restore: bool) -> None:
        """Trashes or restores one artifact, and its `.md` companion, from `{"host", "path"}`.

        `path` is always the artifact's live relpath, never its `.trash/` one. Answers 200
        with the relpaths moved, 403 when trash is off, 404 when the pair names no artifact
        that may move, 409 for a starred artifact or a restore onto an existing file, and
        415/400 for a bad body.
        """
        text = "text/plain; charset=utf-8"
        trash = self.trash
        if trash is None:
            self._send(403, b"trash is not enabled on this server\n", text)
            return
        payload = self._read_json()
        if payload is None:
            return
        host, rel = payload.get("host"), payload.get("path")
        if not (isinstance(host, str) and isinstance(rel, str)):
            self._send(400, b"expected {host, path}\n", text)
            return
        rel = self._trash_rel(trash, host, rel, trashed=restore)
        if rel is None:
            self._send(404, b"no such artifact\n", text)
            return
        rels = trash.with_companion(rel, trashed=restore)
        if not restore and self.stars is not None:
            try:
                starred = self.stars.load(strict=True)
            except OSError as err:
                self._send(500, f"could not read the star list: {err}\n".encode(), text)
                return
            if any(f"{host}/{r}" in starred for r in rels):
                self._send(409, b"starred: unstar it before trashing it\n", text)
                return
        try:
            trash.move(rels, restore)
        except FileExistsError:
            self._send(409, b"a file already exists where it would be restored\n", text)
            return
        except OSError as err:
            self._send(500, f"could not move the artifact: {err}\n".encode(), text)
            return
        body = json.dumps(
            {"host": host, "path": rel, "trashed": not restore, "moved": rels}
        )
        self._send(200, body.encode("utf-8"), "application/json")

    def _star_rel(self, host: str, rel: str) -> str | None:
        """Normalises an artifact's relpath for the star list, or None when it names none."""
        rel = posixpath.normpath(rel).lstrip("/")
        # A newline would split one key into two lines of the star file. A trashed file is
        # not starrable, or the star would keep it past the sweep that should empty it.
        if (
            "\n" in rel
            or "\r" in rel
            or rel.split("/")[0] == TRASH_DIR
            or safe_path(self.cache.root, host, rel) is None
        ):
            return None
        return rel

    def _trash_rel(
        self, trash: Trash, host: str, rel: str, trashed: bool
    ) -> str | None:
        """Normalises a live relpath that may be trashed (or restored), or returns None."""
        rel = posixpath.normpath(rel).lstrip("/")
        if host != trash.host or "\n" in rel or "\r" in rel:
            return None
        if rel.split("/")[0] in (TRASH_DIR, ".", ".."):
            return None
        # Executables and anything else outside the index are kept on purpose.
        if posixpath.splitext(rel)[1].lower() not in INDEXABLE:
            return None
        stored = f"{TRASH_DIR}/{rel}" if trashed else rel
        # safe_path follows a symlink to its target, and moving the target would leave the
        # link dangling, so a link is refused before it resolves.
        if os.path.islink(os.path.join(self.cache.root, host, stored)):
            return None
        if safe_path(self.cache.root, host, stored) is None:
            return None
        return rel

    def _get_star(self) -> None:
        """Answers `{"starred", "writable"}` for the artifact named by ?host=&path=.

        404 when starring is off or the pair names no artifact, which the star button reads
        as "draw nothing".
        """
        text = "text/plain; charset=utf-8"
        stars = self.stars
        if stars is None:
            self._send(404, b"starring is not enabled on this server\n", text)
            return
        query = parse_qs(urlparse(self.path).query)
        host = query.get("host", [""])[0]
        rel = self._star_rel(host, query.get("path", [""])[0])
        if not host or rel is None:
            self._send(404, b"no such artifact\n", text)
            return
        body = {"starred": f"{host}/{rel}" in stars.load(), "writable": stars.writable}
        self._send(200, json.dumps(body).encode("utf-8"), "application/json")

    def _serve_artifact(self, rest: str) -> None:
        host, _, rel = rest.partition("/")
        # posixpath.normpath collapses `.`/`..` before safe_path resolves; both run, because
        # normpath alone does not stop a symlink and resolve() alone does not stop `%2e%2e`.
        rel = posixpath.normpath(rel).lstrip("/")
        target = safe_path(ROOT, host, rel)
        if target is None:
            self._send(404, b"not found\n", "text/plain; charset=utf-8")
            return
        try:
            body = target.read_bytes()
        except OSError:
            self._send(404, b"not found\n", "text/plain; charset=utf-8")
            return
        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        if self.stars is not None and ctype.startswith("text/html"):
            body = add_star_tag(body, host, rel)
        st = target.stat()
        self._send(
            200,
            body,
            ctype,
            {"Last-Modified": self.date_time_string(int(st.st_mtime))},
        )


def main() -> None:
    try:
        Handler.allowed_origins = tuple(parse_allowed_origins(ALLOWED_ORIGINS))
    except ValueError as err:
        raise SystemExit(f"ARTIFACTS_ALLOWED_ORIGINS: {err}") from err
    if STARS_FILE:
        Handler.stars = StarStore(Path(STARS_FILE), writable=not STARS_READONLY)
    trash_host = ""
    if TRASH_ENABLED and LOCAL_HOST:
        tree = Path(os.path.realpath(ROOT / LOCAL_HOST))
        Handler.trash = Trash(LOCAL_HOST, tree)
        trash_host = LOCAL_HOST
    Handler.cache = IndexCache(ROOT, Handler.stars, trash_host)
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(
        f"serving {ROOT} on :{PORT} at {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
