"""Running the wrapped command: the subprocess call and the environment it gets.

Every runner goes through run() rather than subprocess directly, so the timeout
and the colour handling below are decided once. The tests replace this module's
run to capture the argv a runner built without executing it, which only works
while callers reach it as `process.run` — a `from process import run` would bind
the original and miss the replacement.
"""

from __future__ import annotations

import os
import subprocess

# Ten minutes, which no suite tq is put in front of comes close to. TQ_TIMEOUT=0
# disables the kill for the one that legitimately does.
TIMEOUT = int(os.environ.get("TQ_TIMEOUT") or 600)


def _text(raw):
    if isinstance(raw, bytes):
        return raw.decode("utf-8", "replace")
    return raw or ""


def run(argv, env):
    """The finished process, plus whether it had to be killed for running long.

    A hung runner is the one failure tq used to handle worse than no tq at all:
    the digest is built after the process exits, so a suite that never exits
    produced no output whatsoever, where the bare runner would at least have
    streamed what it managed first.
    """
    try:
        proc = subprocess.run(
            argv,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=TIMEOUT or None,
        )
        return proc, False
    except subprocess.TimeoutExpired as expired:
        # TimeoutExpired keeps what was captured before the kill, but hands it
        # back as bytes even under text=True, and carries no returncode at all.
        # 124 is what timeout(1) reports, so a caller reading tq's status has
        # something it already recognises.
        return subprocess.CompletedProcess(
            expired.cmd, 124, _text(expired.stdout), _text(expired.stderr)
        ), True


def plain_env():
    """Colour off, by both mechanisms. A FORCE_COLOR in the ambient environment
    makes runners emit ANSI even when stdout is a file, and the two runners
    disagree on precedence — pytest lets NO_COLOR win, node lets FORCE_COLOR
    win — so the only portable answer is to drop FORCE_COLOR outright. It is
    not cosmetic: node's coloured assertion diff marks actual-vs-expected with
    colour *only*, so stripping ANSI from it silently merges the two values."""
    env = os.environ.copy()
    env.pop("FORCE_COLOR", None)
    env["NO_COLOR"] = "1"
    # Leaked into a nested run — tq invoked from inside a test — this makes
    # `node --test` collect nothing and exit 0, which reads as a clean pass.
    env.pop("NODE_TEST_CONTEXT", None)
    # json_target() has already read TQ_JSON by the time the runner starts, so no
    # child needs it, and a nested tq inheriting it writes its own record over
    # this run's. When the path is relative the nested run does not even get that
    # far: it resolves against the inner cwd, and tq dies on the missing
    # directory instead of reporting the tests it just ran.
    env.pop("TQ_JSON", None)
    return env
