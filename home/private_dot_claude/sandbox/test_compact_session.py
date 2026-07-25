#!/usr/bin/env python3
"""Standalone tests for compact-session.py (run: python3 test_compact_session.py)."""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "executable_compact-session.py")
if not os.path.exists(SCRIPT):
    SCRIPT = os.path.join(HERE, "compact-session.py")  # deployed tree, prefix stripped


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def run_extract(session_dir, extra_args=None):
    """Invoke `compact-session.py extract <session_dir>`; return (rc, stdout, stderr)."""
    args = [sys.executable, SCRIPT, "extract", session_dir] + (extra_args or [])
    p = subprocess.run(args, capture_output=True, text=True, check=False)
    return p.returncode, p.stdout, p.stderr


def run_summarize(json_file, extra_args=None, env=None):
    """Invoke `compact-session.py summarize <json_file>`; return (rc, stdout, stderr)."""
    args = [sys.executable, SCRIPT, "summarize", json_file] + (extra_args or [])
    p = subprocess.run(args, capture_output=True, text=True, env=env, check=False)
    return p.returncode, p.stdout, p.stderr


def test_extracts_titles_pr_links_and_counts():
    with tempfile.TemporaryDirectory() as d:
        session_dir = os.path.join(d, "session")
        lines = [
            "not json",
            json.dumps(
                {
                    "type": "ai-title",
                    "aiTitle": "Fix flaky test",
                    "timestamp": "2026-01-01T00:00:00Z",
                }
            ),
            json.dumps(
                {
                    "type": "custom-title",
                    "title": "My Custom Title",
                    "timestamp": "2026-01-01T00:01:00Z",
                }
            ),
            json.dumps(
                {
                    "type": "pr-link",
                    "url": "https://github.com/org/repo/pull/42",
                    "timestamp": "2026-01-01T00:02:00Z",
                }
            ),
            json.dumps(
                {
                    "type": "user",
                    "message": {"content": "Please fix the bug"},
                    "timestamp": "2026-01-01T00:03:00Z",
                    "gitBranch": "feature/fix-bug",
                }
            ),
            json.dumps(
                {
                    "type": "user",
                    "message": {"content": "<bash-input>ls -la</bash-input>"},
                    "timestamp": "2026-01-01T00:04:00Z",
                }
            ),
            json.dumps(
                {
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "Fixed it"}]},
                    "timestamp": "2026-01-01T00:05:00Z",
                }
            ),
            json.dumps({"type": "assistant", "timestamp": "2026-01-01T00:06:00Z"}),
        ]
        write(
            os.path.join(session_dir, "-workspace", "chat.jsonl"),
            "\n".join(lines) + "\n",
        )

        rc, out, err = run_extract(session_dir)
        assert rc == 0, f"extract failed: {err}"
        data = json.loads(out)

        assert data["titles"] == ["Fix flaky test", "My Custom Title"]
        assert data["pr_links"] == ["https://github.com/org/repo/pull/42"]
        assert data["user_count"] == 2
        assert data["assistant_count"] == 2
        assert data["user_messages"] == ["Please fix the bug"], (
            "wrapper-tagged message should be stripped to nothing and dropped"
        )
        assert data["branch"] == "feature/fix-bug"
        assert data["first_timestamp"] == "2026-01-01T00:00:00Z"
        assert data["last_timestamp"] == "2026-01-01T00:06:00Z"
        assert data["commits"] is None and data["files_changed"] is None


def test_malformed_only_yields_graceful_error():
    with tempfile.TemporaryDirectory() as d:
        session_dir = os.path.join(d, "session")
        write(
            os.path.join(session_dir, "-workspace", "chat.jsonl"),
            "not json\nalso not json\n",
        )

        rc, out, _err = run_extract(session_dir)
        assert rc == 1, "no parseable entries should exit 1"
        data = json.loads(out)
        assert data["error"] == "No session data found"


def test_summarize_without_api_key_fails_closed():
    with tempfile.TemporaryDirectory() as d:
        json_file = os.path.join(d, "session.json")
        write(
            json_file,
            json.dumps({"user_messages": ["hi"], "commits": "", "titles": []}),
        )

        env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_ADMIN_API_KEY")
        }
        rc, out, err = run_summarize(json_file, env=env)
        assert rc == 1, "missing api key should exit 1"
        assert "api-key" in err.lower() or "ANTHROPIC_API_KEY" in err
        assert out == "", "no output should be produced when failing closed"


def test_summarize_with_no_content_skips_network():
    with tempfile.TemporaryDirectory() as d:
        json_file = os.path.join(d, "session.json")
        original = {"user_messages": [], "commits": "", "titles": [], "user_count": 0}
        write(json_file, json.dumps(original))

        rc, out, err = run_summarize(
            json_file, extra_args=["--api-key=fake-key-for-test"]
        )
        assert rc == 0, f"summarize should succeed without calling the API: {err}"
        data = json.loads(out)
        assert "api_summary" not in data and "api_summary_error" not in data
        assert data == original, (
            "data should pass through unchanged when there is nothing to summarize"
        )


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
