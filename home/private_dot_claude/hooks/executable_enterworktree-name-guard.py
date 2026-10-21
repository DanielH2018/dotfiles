#!/usr/bin/env python3
# gen-hooks: register
#   event: PreToolUse
#   matcher: EnterWorktree
#   timeout: 5
#   order: 80
"""PreToolUse hook: deny an `EnterWorktree` call that names no worktree.

Called with neither `name` nor `path`, `EnterWorktree` generates a name such as
`bright-running-fox`, and the branch becomes `worktree-bright-running-fox`. That name
says nothing about the work, so the session banners and worktree reports that list it
say nothing either. This hook denies the call and tells the session the form to use.
A `path`-only call switches into an existing worktree and passes.

The agent user's branch fence pushes only `worktree-<prefix>+<slug>` branches, so when
CLAUDE_WORKTREE_PREFIX is set the message asks for `<prefix>/<slug>`.

Three entry points are not tool calls, so this does not cover them: `claude --worktree`
with no name on the command line, an `Agent` call with `isolation: "worktree"`
(`agent-<agentId>`), and a Remote Control session (`bridge-<sessionId>`).

Fails open: unreadable input prints nothing, which leaves the call to the normal
permission flow.
"""

import os
import sys

# The shared modules live in lib/ beside this hook, deployed or in the source tree.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "lib"))
import hook_input  # noqa: E402


def denial(tool_input: dict, prefix: str) -> str | None:
    """The deny reason for this call, or None when it names a worktree."""
    if (
        str(tool_input.get("name") or "").strip()
        or str(tool_input.get("path") or "").strip()
    ):
        return None
    form = f"{prefix}/<slug>" if prefix else "<slug>"
    return (
        "EnterWorktree needs a `name`, or a generated one such as `bright-running-fox` "
        "becomes the worktree and branch name. Call it again with "
        f'name: "{form}", where the slug says what the work is, such as '
        "`claim-labels` or `fix-cert-watcher`."
    )


def main() -> int:
    event = hook_input.read_event()
    if event is None or event.get("tool_name", "EnterWorktree") != "EnterWorktree":
        return 0
    reason = denial(
        hook_input.tool_input(event), os.environ.get("CLAUDE_WORKTREE_PREFIX", "")
    )
    if reason:
        hook_input.emit_decision("deny", reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
