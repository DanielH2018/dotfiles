#!/usr/bin/env python3
"""Standalone tests for split_alerts.py and verify_locks.py.

Run: python3 test_dependabot_sweep.py

Each rule is checked from both sides where it has two: an alert that must clear and one
that must stay open, a payload that must split and one that must be refused. A checker
that cleared everything would pass the clearing half alone.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Importing the scripts below would otherwise write a __pycache__ into the chezmoi
# source tree, which chezmoi would then deploy.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent


def _load(name: str):
    path = HERE / f"executable_{name}.py"
    if not path.exists():  # deployed copy drops chezmoi's mode prefix
        path = HERE / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


split_alerts = _load("split_alerts")
verify_locks = _load("verify_locks")


def _alert(
    number,
    package,
    manifest,
    patched,
    repo="privacy-com/svc",
    severity="high",
    ecosystem="pip",
):
    return {
        "repo": repo,
        "number": number,
        "severity": severity,
        "ecosystem": ecosystem,
        "packageName": package,
        "manifestPath": manifest,
        "scope": "runtime",
        "patchedVersion": patched,
    }


def _uv_lock(packages: dict[str, list[str]]) -> str:
    blocks = [
        f'[[package]]\nname = "{n}"\nversion = "{v}"\n'
        for n, vs in packages.items()
        for v in vs
    ]
    return "version = 1\n\n" + "\n".join(blocks)


def _git(cwd: Path, *args: str) -> None:
    env = {
        **os.environ,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
    }
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        env=env,
        check=True,
        capture_output=True,
    )


def _run(main, argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


def test_split_writes_one_file_per_repo_and_leaves_out_excluded_repos():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        payload = {
            "alerts": [
                _alert(1, "urllib3", "uv.lock", "2.8.0", repo="privacy-com/processing"),
                _alert(2, "black", "uv.lock", "26.10.1", repo="privacy-com/processing"),
                _alert(
                    3,
                    "certifi",
                    "poetry.lock",
                    "2026.10.19",
                    repo="privacy-com/airflow",
                ),
            ],
            "error": None,
            "stale": False,
            "partialErrors": [],
            "fetchedAt": "2026-11-03T13:29:31Z",
        }
        (tmp / "vulns.json").write_text(json.dumps(payload))
        code, out, _ = _run(
            split_alerts.main,
            [
                "--input",
                str(tmp / "vulns.json"),
                "--out",
                str(tmp / "out"),
                "--exclude",
                "airflow",
            ],
        )
        assert code == 0
        assert sorted(p.name for p in (tmp / "out").iterdir()) == [
            "alerts-processing.json"
        ]
        assert [
            a["number"]
            for a in json.loads((tmp / "out" / "alerts-processing.json").read_text())
        ] == [1, 2]
        assert "| processing | 2 | 0 | 2 | 0 | 0 | pip | 1 | 0 |" in out


def test_split_refuses_a_partial_payload_and_writes_nothing():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        payload = {
            "alerts": [_alert(1, "urllib3", "uv.lock", "2.8.0")],
            "error": None,
            "stale": False,
            "partialErrors": ["privacy-com/disputes: 502"],
        }
        (tmp / "vulns.json").write_text(json.dumps(payload))
        code, _, err = _run(
            split_alerts.main,
            ["--input", str(tmp / "vulns.json"), "--out", str(tmp / "out")],
        )
        assert code == 1
        assert "partial" in err
        assert not (tmp / "out").exists()


def test_a_complete_payload_is_not_refused():
    assert (
        split_alerts.refusal(
            {"alerts": [], "error": None, "stale": False, "partialErrors": []}
        )
        is None
    )


def test_trailing_zero_segments_do_not_change_a_version():
    assert verify_locks.at_least("26.2", "26.2.0")
    assert verify_locks.at_least("2.8.0", "2.8")
    assert not verify_locks.at_least("26.1.9", "26.2")
    assert verify_locks.at_least("1.10.0", "1.9.0")  # numeric, not lexical


def test_an_alert_clears_only_when_every_locked_copy_is_patched():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "Cargo.lock").write_text(
            _uv_lock({"openssl": ["0.10.80"], "rustls": ["0.21.12", "0.23.46"]})
        )
        alerts = [
            _alert(1, "openssl", "Cargo.lock", "0.10.72", ecosystem="rust"),
            _alert(2, "rustls", "common/Cargo.toml", "0.23.46", ecosystem="rust"),
        ]
        cleared, still_open = verify_locks.classify(alerts, tmp)
        assert [a["number"] for a in cleared] == [1]
        assert [(a["number"], a["state"]) for a in still_open] == [(2, "below patched")]


def test_an_absent_package_or_deleted_lockfile_clears_but_a_missing_patch_stays_open():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "uv.lock").write_text(_uv_lock({"pyjwt": ["2.15.0"]}))
        alerts = [
            _alert(1, "GitPython", "uv.lock", "3.2.1"),
            _alert(2, "urllib3", "core/poetry.lock", "2.8.0"),
            _alert(3, "PyJWT", "uv.lock", None),
        ]
        cleared, still_open = verify_locks.classify(alerts, tmp)
        assert {(a["number"], a["state"]) for a in cleared} == {
            (1, "package absent"),
            (2, "lockfile deleted"),
        }
        assert [(a["number"], a["state"]) for a in still_open] == [(3, "no patch")]


def test_a_pyproject_manifest_resolves_to_whichever_lockfile_sits_beside_it():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "infra").mkdir()
        (tmp / "infra" / "poetry.lock").write_text("")
        (tmp / "app").mkdir()
        (tmp / "app" / "uv.lock").write_text("")
        assert verify_locks.lock_for("infra/pyproject.toml", tmp) == "infra/poetry.lock"
        assert verify_locks.lock_for("app/pyproject.toml", tmp) == "app/uv.lock"


def test_non_toml_lockfiles_parse_to_their_locked_versions():
    npm = json.dumps(
        {
            "packages": {
                "": {},
                "node_modules/qs": {"version": "6.17.1"},
                "node_modules/a/node_modules/form-data": {"version": "4.0.6"},
            }
        }
    )
    assert verify_locks.parse_lock(npm, "simulation/node/package-lock.json") == {
        "qs": {"6.17.1"},
        "form-data": {"4.0.6"},
    }
    gem = (
        "GEM\n  specs:\n    json (2.19.9)\n"
        "    nokogiri (1.18.3-arm64-darwin)\n      racc (~> 1.4)\n"
    )
    assert verify_locks.parse_lock(gem, "Gemfile.lock") == {
        "json": {"2.19.9"},
        "nokogiri": {"1.18.3"},
    }
    req = (
        "gitpython==3.2.1\n"
        "boto3[crt]==1.40.0 ; python_version >= '3.9'\n"
        "# pulumi==3.0\n"
    )
    assert verify_locks.parse_lock(req, "infra/main/requirements.txt") == {
        "gitpython": {"3.2.1"},
        "boto3": {"1.40.0"},
    }


def test_lock_changes_report_a_major_move_and_an_added_package_but_not_a_minor_bump():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _git(repo, "init", "-q", "-b", "main")
        (repo / "uv.lock").write_text(
            _uv_lock({"werkzeug": ["2.2.2"], "urllib3": ["2.7.0"], "pyasn1": ["0.4.8"]})
        )
        _git(repo, "add", "uv.lock")
        _git(repo, "commit", "-q", "-m", "base")
        _git(repo, "switch", "-q", "-c", "fix")
        (repo / "uv.lock").write_text(
            _uv_lock(
                {
                    "werkzeug": ["3.1.9"],
                    "urllib3": ["2.8.0"],
                    "pyasn1": ["0.6.5"],
                    "zmij": ["1.0.23"],
                }
            )
        )
        _git(repo, "commit", "-q", "-am", "fix")
        lines = verify_locks.lock_changes(repo, "main")
        assert lines == [
            "MAJOR uv.lock: pyasn1 ['0.4.8'] -> ['0.6.5']",
            "MAJOR uv.lock: werkzeug ['2.2.2'] -> ['3.1.9']",
            "ADDED uv.lock: zmij ['1.0.23']",
        ]


if __name__ == "__main__":
    # Discovered, not hand-listed: tests/python-suites.test.js counts the test_* defs
    # itself and fails when that count and the OK line disagree.
    ran = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            ran += 1
    print(f"OK {ran}")
