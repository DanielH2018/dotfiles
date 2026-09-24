"""The check() harness the standalone hooks/test_*.py suites share.

Each suite runs as `python3 test_x.py`, so this file is found on sys.path as the
script's own directory, in the source tree and deployed to ~/.claude/hooks alike.
The name does not match test_*.py, so tests/python-suites.test.js never collects
it as a suite of its own.

Import `check` by name (`from _testkit import check`): that runner counts
`check(...)` call sites as bare names, and an attribute call would count zero.
"""

import subprocess
import sys

failures = []
ran = 0


def check(name, condition):
    global ran
    ran += 1
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def git(args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    )


def finish():
    """Exit 1 naming the failed checks, or print the `OK N` line the runner counts."""
    print()
    if failures:
        print(f"{len(failures)} failed: {', '.join(failures)}")
        sys.exit(1)
    print(f"OK {ran}")
