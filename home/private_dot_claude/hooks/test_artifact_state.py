#!/usr/bin/env python3
"""Standalone tests for the host label lib/artifact-state.sh keys the star list on.

Run: python3 test_artifact_state.py

The browser (serve-artifacts.sh) prefixes star lines with artifact_host_label, and
retention-sweep's G20 row keeps an artifact only under the same label, so a star counts
only while the two agree. A sweep under any other label matches no star and deletes
every starred artifact once it ages out. These tests pin the two ways the label could
drift: a PATH without /usr/sbin, where a bare `scutil` would fall through to
`hostname -s`, and a label change that leaves star lines under the old name.
tests/retention-sweep.test.js pins the sweeper's half of the agreement.

Every case runs the real lib against a temp HOME, with stub `uname`, `hostname` and
`scutil` that print different names, so the Darwin branch runs on a Linux CI runner too.
"""

import os
import subprocess
import tempfile
from pathlib import Path

from _testkit import check, finish

HERE = Path(__file__).resolve().parent
LIB = HERE / "lib" / "artifact-state.sh"

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
    }


def label(env):
    return subprocess.run(
        ["bash", "-c", '. "$ARTIFACT_STATE_LIB"; artifact_host_label'],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def migrate(env):
    subprocess.run(
        [
            "bash",
            "-c",
            '. "$ARTIFACT_STATE_LIB"; artifact_migrate_stars "$1"',
            "-",
            label(env),
        ],
        env=env,
        check=True,
    )


def main():
    with tempfile.TemporaryDirectory(prefix="artifact-state-test.") as t:
        tmp = Path(t)
        with_sbin = make_env(tmp, with_sbin=True)
        without_sbin = make_env(tmp, with_sbin=False)
        check(
            "the label does not depend on /usr/sbin being on PATH",
            label(with_sbin) == label(without_sbin) == LOCAL_HOST_NAME,
        )

    # Stars written before a label change carry the label the browser published then,
    # which the root symlink records. Migration moves them before the list is read.
    with tempfile.TemporaryDirectory(prefix="artifact-state-test.") as t:
        tmp = Path(t)
        home = tmp / "home"
        env = make_env(tmp, with_sbin=False)
        root = home / ".claude" / ".artifacts-root"
        root.mkdir(parents=True)
        (root / SHORT_HOSTNAME).symlink_to(home / ".claude" / "artifacts")
        stars = home / ".claude" / "artifact-stars.txt"
        stars.write_text(
            f"{SHORT_HOSTNAME}/pinned-by-star.html\n"
            f"daniel-box/elsewhere.html\n"
            f"{LOCAL_HOST_NAME}/pinned-by-star.html\n"
        )
        migrate(env)
        check(
            "the old label's lines move to the new label, once, other hosts untouched",
            stars.read_text()
            == f"{LOCAL_HOST_NAME}/pinned-by-star.html\ndaniel-box/elsewhere.html\n",
        )

    finish()


if __name__ == "__main__":
    main()
