"""The package imports under the interpreter the shims will use."""

import sys

import claude_guard


def test_package_exposes_a_version():
    assert isinstance(claude_guard.__version__, str)
    assert claude_guard.__version__


def test_runs_under_python_314_or_newer():
    assert sys.version_info >= (3, 14), sys.version
