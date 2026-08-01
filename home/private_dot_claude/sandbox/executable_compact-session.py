#!/usr/bin/env python3
"""Compact a Claude Code sandbox session into structured data.

Usage:
  compact-session.py extract <session-dir> [--repo-path=<path>] [--branch=<branch>]
  compact-session.py summarize <json-file> [--api-key=<key>]
  compact-session.py render <json-file> <repo-name> <worktree-name> <vault-file>

extract: Parse JSONL files, output structured JSON to stdout.
summarize: Take extracted JSON, call Claude API for summary, output enhanced JSON.
render: Write the vault note for extracted JSON, print its index one-liner to stdout.
"""

import glob
import json
import os
import re
import subprocess
import sys
from datetime import datetime


def parse_sessions(session_dir):
    """Parse all JSONL files in the session's -workspace/ directory."""
    workspace_dir = os.path.join(session_dir, "-workspace")
    if not os.path.isdir(workspace_dir):
        workspace_dir = session_dir

    jsonl_files = glob.glob(os.path.join(workspace_dir, "*.jsonl"))
    if not jsonl_files:
        return None

    titles = set()
    pr_links = []
    user_messages = []
    user_count = 0
    assistant_count = 0
    timestamps = []
    branch = None

    for filepath in jsonl_files:
        with open(filepath) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                entry_type = obj.get("type", "")

                if entry_type == "ai-title" and obj.get("aiTitle"):
                    titles.add(obj["aiTitle"])
                elif entry_type == "custom-title" and obj.get("title"):
                    titles.add(obj["title"])
                elif entry_type == "pr-link":
                    url = obj.get("url", "")
                    if url:
                        pr_links.append(url)
                elif entry_type == "user":
                    user_count += 1
                    msg = obj.get("message", {})
                    content = ""
                    if isinstance(msg, dict):
                        content = msg.get("content", "")
                    elif isinstance(msg, str):
                        content = msg
                    if isinstance(content, str) and content:
                        cleaned = strip_wrapper_tags(content)
                        if cleaned:
                            user_messages.append(cleaned)
                elif entry_type == "assistant":
                    assistant_count += 1

                ts = obj.get("timestamp")
                if ts:
                    timestamps.append(ts)

                if not branch and obj.get("gitBranch"):
                    branch = obj["gitBranch"]

    if not timestamps:
        return None

    timestamps.sort()

    return {
        "titles": sorted(titles),
        "pr_links": sorted(set(pr_links)),
        "user_messages": user_messages,
        "user_count": user_count,
        "assistant_count": assistant_count,
        "first_timestamp": timestamps[0],
        "last_timestamp": timestamps[-1],
        "branch": branch,
    }


def strip_wrapper_tags(text):
    """Remove bash-input, local-command-caveat, bash-stdout/stderr tags."""
    if text.strip().startswith("<local-command-caveat>"):
        return ""
    if text.strip().startswith("<bash-input>"):
        return ""
    if text.strip().startswith("<bash-stdout>"):
        return ""
    if text.strip().startswith("<bash-stderr>"):
        return ""
    text = re.sub(
        r"</?(?:bash-input|bash-stdout|bash-stderr|local-command-caveat)[^>]*>",
        "",
        text,
    )
    return text.strip()


def get_git_info(repo_path, branch):
    """Get commit log and files changed from git."""
    if not repo_path or not branch:
        return {"commits": None, "files_changed": None}

    try:
        default_ref = subprocess.run(
            ["git", "-C", repo_path, "symbolic-ref", "refs/remotes/origin/HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if default_ref.returncode == 0:
            default_branch = default_ref.stdout.strip().split("/")[-1]
        else:
            default_branch = "main"
    except (subprocess.TimeoutExpired, FileNotFoundError):
        default_branch = "main"

    check = subprocess.run(
        [
            "git",
            "-C",
            repo_path,
            "show-ref",
            "--verify",
            "--quiet",
            f"refs/heads/{branch}",
        ],
        capture_output=True,
        timeout=5,
    )
    if check.returncode != 0:
        return {"commits": None, "files_changed": None}

    commits = None
    files_changed = None

    try:
        log_result = subprocess.run(
            ["git", "-C", repo_path, "log", "--oneline", f"{default_branch}..{branch}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if log_result.returncode == 0 and log_result.stdout.strip():
            commits = log_result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    try:
        diff_result = subprocess.run(
            ["git", "-C", repo_path, "diff", "--stat", f"{default_branch}...{branch}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if diff_result.returncode == 0 and diff_result.stdout.strip():
            files_changed = diff_result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return {"commits": commits, "files_changed": files_changed}


def cmd_extract(session_dir, repo_path=None, branch_override=None):
    """Extract structured data from session JSONL files."""
    data = parse_sessions(session_dir)
    if not data:
        print(
            json.dumps({"error": "No session data found", "session_dir": session_dir})
        )
        sys.exit(1)

    branch = branch_override or data["branch"]
    git_info = get_git_info(repo_path, branch)
    data["commits"] = git_info["commits"]
    data["files_changed"] = git_info["files_changed"]

    json.dump(data, sys.stdout, indent=2)
    print()


def cmd_summarize(json_file, api_key):
    """Enhance extracted JSON with Claude API summary."""
    with open(json_file) as f:
        data = json.load(f)

    user_msgs = data.get("user_messages", [])
    commits = data.get("commits", "")
    titles = data.get("titles", [])

    prompt_parts = []
    if titles:
        prompt_parts.append("Session titles: " + ", ".join(titles))
    if commits:
        prompt_parts.append("Commits:\n" + commits)
    if user_msgs:
        joined = "\n---\n".join(user_msgs)
        if len(joined) > 32000:
            joined = joined[:32000] + "\n[...truncated]"
        prompt_parts.append("User messages:\n" + joined)

    if not prompt_parts:
        json.dump(data, sys.stdout, indent=2)
        print()
        return

    prompt = "\n\n".join(prompt_parts)

    request_body = json.dumps(
        {
            "model": "claude-sonnet-4-6-20250514",
            "max_tokens": 1024,
            "messages": [
                {
                    "role": "user",
                    "content": (
                        "Summarize this Claude Code session. Provide:\n"
                        "1. A one-paragraph summary of what was accomplished\n"
                        "2. Key decisions made (bullet list)\n"
                        "3. Problems encountered and how they were resolved"
                        " (bullet list)\n\n"
                        "Be concise. If there are no clear decisions or problems,"
                        " omit those sections.\n\n" + prompt
                    ),
                }
            ],
        }
    )

    try:
        result = subprocess.run(
            [
                "curl",
                "-s",
                "-X",
                "POST",
                "https://api.anthropic.com/v1/messages",
                "-H",
                "Content-Type: application/json",
                "-H",
                f"x-api-key: {api_key}",
                "-H",
                "anthropic-version: 2023-06-01",
                "--data",
                request_body,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            response = json.loads(result.stdout)
            content_blocks = response.get("content", [])
            if content_blocks:
                summary_text = content_blocks[0].get("text", "")
                data["api_summary"] = summary_text
    except (subprocess.TimeoutExpired, json.JSONDecodeError, KeyError):
        data["api_summary_error"] = "API call failed"

    json.dump(data, sys.stdout, indent=2)
    print()


def split_api_summary(api_summary: str) -> tuple[str, str, str]:
    """Split a model-written summary into (paragraph, key decisions, problems)."""
    summary_paragraph = api_summary
    key_decisions = ""
    problems = ""
    parts = re.split(
        r"\n(?=\d\.\s|#{1,3}\s|Key [Dd]ecisions|Problems [Ee]ncountered)", api_summary
    )
    if len(parts) >= 1:
        summary_paragraph = parts[0].strip()
    for part in parts[1:]:
        if re.match(r"(?:#{1,3}\s*)?Key [Dd]ecisions", part, re.IGNORECASE):
            key_decisions = re.sub(
                r"^(?:#{1,3}\s*)?Key [Dd]ecisions[:\s]*\n?",
                "",
                part,
                flags=re.IGNORECASE,
            ).strip()
        elif re.match(r"(?:#{1,3}\s*)?Problems", part, re.IGNORECASE):
            problems = re.sub(
                r"^(?:#{1,3}\s*)?Problems [Ee]ncountered[:\s]*\n?",
                "",
                part,
                flags=re.IGNORECASE,
            ).strip()
    return summary_paragraph, key_decisions, problems


def ts_to_date(ts: str) -> str:
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except (ValueError, AttributeError):
        return "unknown"


def cmd_render(json_file: str, repo_name: str, wt_name: str, vault_file: str) -> None:
    """Write the vault note for an extracted session; print its index one-liner."""
    with open(json_file) as f:
        data = json.load(f)

    titles = data.get("titles", [])
    user_count = data.get("user_count", 0)
    assistant_count = data.get("assistant_count", 0)
    pr_links = data.get("pr_links", [])
    commits = data.get("commits")
    files_changed = data.get("files_changed")
    api_summary = data.get("api_summary")

    first_date = ts_to_date(data.get("first_timestamp", ""))
    last_date = ts_to_date(data.get("last_timestamp", ""))

    if api_summary:
        summary_paragraph, key_decisions, problems = split_api_summary(api_summary)
    else:
        parts = []
        if titles:
            parts.append("Session topics: " + ", ".join(titles) + ".")
        if commits:
            commit_lines = commits.strip().split("\n")
            parts.append(f"{len(commit_lines)} commit(s) on branch claude/{wt_name}.")
        summary_paragraph = " ".join(parts) if parts else "No summary available."
        key_decisions = ""
        problems = ""

    pr_formatted = ", ".join(f"[PR]({url})" for url in pr_links) if pr_links else "none"
    frontmatter_summary = (
        titles[0] if titles else f"Claude session on {repo_name}/claude/{wt_name}"
    )

    lines = [
        "---",
        f'title: "{repo_name} / {wt_name}"',
        f"summary: {frontmatter_summary}",
        f"tags: [sessions, {repo_name}, archived]",
        f"created: {first_date}",
        f"updated: {last_date}",
        "---",
        "",
        f"- **Repo:** {repo_name}",
        f"- **Branch:** claude/{wt_name}",
        f"- **Dates:** {first_date} to {last_date}",
        f"- **Messages:** {user_count} user / {assistant_count} assistant",
        f"- **PRs:** {pr_formatted}",
        "",
        "### Summary",
        summary_paragraph,
    ]

    if key_decisions:
        lines += ["", "### Key Decisions", key_decisions]
    if problems:
        lines += ["", "### Problems Encountered", problems]

    lines += [
        "",
        "### Files Changed",
        files_changed if files_changed else "Branch no longer available.",
    ]
    lines += [
        "",
        "### Commits",
        commits if commits else "Branch no longer available.",
        "",
    ]

    with open(vault_file, "w") as f:
        f.write("\n".join(lines))

    # The index row's no-titles fallback differs from the frontmatter's above. That
    # predates this command being split out of the launcher; kept so the two outputs
    # stay byte-identical to what the shell heredoc produced.
    print(titles[0] if titles else f"Session on claude/{wt_name}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(
            "Usage: compact-session.py extract <session-dir>"
            " [--repo-path=<path>] [--branch=<branch>]",
            file=sys.stderr,
        )
        print(
            "       compact-session.py summarize <json-file> [--api-key=<key>]",
            file=sys.stderr,
        )
        print(
            "       compact-session.py render <json-file> <repo-name>"
            " <worktree-name> <vault-file>",
            file=sys.stderr,
        )
        sys.exit(1)

    command = args[0]

    if command == "extract":
        if len(args) < 2:
            print("Error: session-dir required", file=sys.stderr)
            sys.exit(1)
        session_dir = args[1]
        repo_path = None
        branch = None
        for arg in args[2:]:
            if arg.startswith("--repo-path="):
                repo_path = arg.split("=", 1)[1]
            elif arg.startswith("--branch="):
                branch = arg.split("=", 1)[1]
        cmd_extract(session_dir, repo_path, branch)

    elif command == "summarize":
        if len(args) < 2:
            print("Error: json-file required", file=sys.stderr)
            sys.exit(1)
        json_file = args[1]
        api_key = None
        for arg in args[2:]:
            if arg.startswith("--api-key="):
                api_key = arg.split("=", 1)[1]
        if not api_key:
            api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get(
                "ANTHROPIC_ADMIN_API_KEY"
            )
        if not api_key:
            print("Error: --api-key or ANTHROPIC_API_KEY required", file=sys.stderr)
            sys.exit(1)
        cmd_summarize(json_file, api_key)

    elif command == "render":
        if len(args) < 5:
            print(
                "Error: json-file, repo-name, worktree-name and vault-file required",
                file=sys.stderr,
            )
            sys.exit(1)
        cmd_render(args[1], args[2], args[3], args[4])

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)
