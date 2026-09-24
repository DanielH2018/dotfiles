"""The module loader the filter suites share: test_filter_policy.py and
test_docker_create_filter.py.

Each suite runs as `python3 test_x.py`, so this file is found on sys.path as the
script's own directory, in the source tree and deployed to ~/.claude/sandbox alike.
It sets CANON_LIB on import, before either suite loads a filter module that reads
it. Define no `test_*` name here: a suite's __main__ runner scans its own
globals(), and an imported test would be counted and run there.
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def _canon_lib():
    """canon.py sits somewhere different in each tree these suites run from.

    Deployed it is under ~/.local/share; in the chezmoi source it is two levels
    up under dot_local; in the filter container both files are bind-mounted flat
    into /opt. Resolving all three is why the deployed copy of these suites used to
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


def load(filename, modname):
    """Load a sandbox module by path, under its source or deployed name."""
    path = os.path.join(HERE, filename)
    if not os.path.exists(path):
        path = os.path.join(HERE, "executable_" + filename)
    spec = importlib.util.spec_from_file_location(modname, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create(host_config):
    """A minimal container-create body carrying the given HostConfig."""
    return {"Image": "alpine", "HostConfig": host_config}
