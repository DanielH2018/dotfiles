#!/usr/bin/env python3
"""Standalone tests for the host label prune-artifacts.sh keys the star list on.

Run: python3 test_prune_artifacts.py

The browser (serve-artifacts.sh) and the sweep (prune-artifacts.sh) both prefix star
lines with artifact_host_label, and a star counts only while the two agree. A sweep
under any other label matches no star and deletes every starred artifact once it ages
out. These tests pin the two ways the label could drift: a PATH without /usr/sbin,
where a bare `scutil` would fall through to `hostname -s`, and a label change that
leaves star lines under the old name.

Every case runs the real scripts against a temp HOME, with stub `uname`, `hostname`
and `scutil` that print different names, so the Darwin branch runs on a Linux CI
runner too.
"""

import os
import subprocess
import tempfile
import time
from pathlib import Path

from _testkit import check, finish

HERE = Path(__file__).resolve().parent
PRUNE = HERE / "executable_prune-artifacts.sh"
if not PRUNE.exists():  # deployed copy drops chezmoi's mode prefix
    PRUNE = HERE / "prune-artifacts.sh"
LIB = HERE / "artifact-state.sh"

LOCAL_HOST_NAME = "fakehost"  # what scutil --get LocalHostName prints
SHORT_HOSTNAME = "fakehost-2"  # what hostname -s prints


def stub(path, body):
    path.write_text("#!/bin/sh\n" + body + "\n")
    path.chmod(0o755)


def make_env(tmp, with_sbin):
    """Build a hook-like environment, with or without scutil's directory on PATH."""
    bin_dir = tmp / "bin"
    sbin_dir = tmp / "sbin"
    if not bin_dir.exists():
        bin_dir.mkdir()
        sbin_dir.mkdir()
        stub(bin_dir / "uname", "echo Darwin")
        stub(bin_dir / "hostname", f"echo {SHORT_HOSTNAME}")
        stub(
            sbin_dir / "scutil",
            f'[ "$1 $2" = "--get LocalHostName" ] && echo {LOCAL_HOST_NAME}',
        )
    path = (
        [str(bin_dir)] + ([str(sbin_dir)] if with_sbin else []) + ["/usr/bin", "/bin"]
    )
    return {
        "HOME": str(tmp / "home"),
        "PATH": os.pathsep.join(path),
        "ARTIFACT_STATE_LIB": str(LIB),
        "ARTIFACT_SCUTIL": str(sbin_dir / "scutil"),
        "CLAUDE_ARTIFACT_RETENTION_DAYS": "30",
    }


def label(env):
    return subprocess.run(
        ["bash", "-c", '. "$ARTIFACT_STATE_LIB"; artifact_host_label'],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def aged_artifact(home, rel):
    """An artifact last updated 40 days ago, past the 30-day retention."""
    f = home / ".claude" / "artifacts" / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("<html></html>")
    old = time.time() - 40 * 86400
    os.utime(f, (old, old))
    return f


def prune(env):
    subprocess.run(["bash", str(PRUNE)], env=env, check=True)


def main():
    with tempfile.TemporaryDirectory(prefix="prune-artifacts-test.") as t:
        tmp = Path(t)
        with_sbin = make_env(tmp, with_sbin=True)
        without_sbin = make_env(tmp, with_sbin=False)
        check(
            "the label does not depend on /usr/sbin being on PATH",
            label(with_sbin) == label(without_sbin) == LOCAL_HOST_NAME,
        )

    # The browser started where /usr/sbin was on PATH; the sweep runs where it is not.
    with tempfile.TemporaryDirectory(prefix="prune-artifacts-test.") as t:
        tmp = Path(t)
        home = tmp / "home"
        browser_env = make_env(tmp, with_sbin=True)
        sweep_env = make_env(tmp, with_sbin=False)
        starred = aged_artifact(home, "starred.html")
        unstarred = aged_artifact(home, "unstarred.html")
        (home / ".claude" / "artifact-stars.txt").write_text(
            f"{label(browser_env)}/starred.html\n"
        )
        prune(sweep_env)
        check("a starred artifact past retention survives the sweep", starred.exists())
        check("an unstarred artifact past retention is swept", not unstarred.exists())

    # Stars written before this fix carry the label the browser published then, which
    # the root symlink records. The first sweep after the label changes keeps them.
    with tempfile.TemporaryDirectory(prefix="prune-artifacts-test.") as t:
        tmp = Path(t)
        home = tmp / "home"
        env = make_env(tmp, with_sbin=False)
        starred = aged_artifact(home, "pinned-by-star.html")
        root = home / ".claude" / ".artifacts-root"
        root.mkdir(parents=True)
        (root / SHORT_HOSTNAME).symlink_to(home / ".claude" / "artifacts")
        stars = home / ".claude" / "artifact-stars.txt"
        stars.write_text(
            f"{SHORT_HOSTNAME}/pinned-by-star.html\n"
            f"daniel-box/elsewhere.html\n"
            f"{LOCAL_HOST_NAME}/pinned-by-star.html\n"
        )
        prune(env)
        check("a star under the old label survives the label change", starred.exists())
        check(
            "the old label's lines move to the new label, once, other hosts untouched",
            stars.read_text()
            == f"{LOCAL_HOST_NAME}/pinned-by-star.html\ndaniel-box/elsewhere.html\n",
        )

    finish()


if __name__ == "__main__":
    main()
