"""cc-wait command line.

    cc-wait <source> [args...]     wait on a source; see the exit codes below
    cc-wait --list                 the built-in sources and this repo's probes
    cc-wait --budget S <source>    wait at most S seconds (default 570, or $CC_WAIT_BUDGET)

`--budget` is cc-wait's own wherever it appears, so a source never sees it. The default sits
under the 600s limit of a foreground Bash call; a backgrounded call or a Monitor can pass more.

Exit codes: a terminal state's own code, declared by its source; 75 when the budget elapses
with the wait still open (re-run the printed command to resume it); 2 when cc-wait could not
wait at all.
"""

import os
import shlex
import sys
from pathlib import Path

from cc_wait import loop, repo
from cc_wait.builtins import BUILTINS
from cc_wait.cache import cache_dir
from cc_wait.source import COULD_NOT_WAIT, Source, SourceError

DEFAULT_BUDGET_S = 570.0
BUDGET_ENV = "CC_WAIT_BUDGET"


def split_budget(argv: list[str]) -> tuple[float | None, list[str]]:
    """Take `--budget S` or `--budget=S` out of `argv`.

    Returns:
      The budget (None when absent) and the remaining arguments.

    Raises:
      SourceError: the flag is present without a positive number.
    """
    budget = None
    rest: list[str] = []
    it = iter(argv)
    for arg in it:
        if arg == "--budget" or arg.startswith("--budget="):
            raw = arg.partition("=")[2] if "=" in arg else next(it, "")
            try:
                budget = float(raw)
            except ValueError:
                raise SourceError(f"--budget needs a number of seconds, not {raw!r}") from None
            if budget <= 0:
                raise SourceError("--budget must be positive")
        else:
            rest.append(arg)
    return budget, rest


def default_budget(env: dict[str, str]) -> float:
    raw = env.get(BUDGET_ENV, "")
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_BUDGET_S
    return value if value > 0 else DEFAULT_BUDGET_S


def resolve(name: str, cwd: Path) -> Source:
    """The source called `name`, or SourceError saying why there is none."""
    found = repo.find(name, cwd)
    if name in BUILTINS:
        if found is not None:
            raise SourceError(
                f"{found.path} has the same name as the built-in `{name}`; rename the probe"
            )
        return BUILTINS[name]
    if found is not None:
        return found
    root = repo.repo_root(cwd)
    local = repo.tracked_probes(root) if root else []
    known = ", ".join([*BUILTINS, *local])
    raise SourceError(f"no source named {name!r}; known here: {known}")


def list_sources(cwd: Path, out) -> None:
    for source in BUILTINS.values():
        print(f"{source.name:<12} built-in   {source.summary}", file=out)
    root = repo.repo_root(cwd)
    for name in repo.tracked_probes(root) if root else []:
        print(f"{name:<12} this repo  {root / repo.SOURCES_DIR / name}", file=out)


def main(argv: list[str] | None = None, out=None, cwd: Path | None = None, env=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    out = out if out is not None else sys.stdout
    cwd = cwd if cwd is not None else Path.cwd()
    env = env if env is not None else os.environ
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip(), file=out)
        return 0 if argv else COULD_NOT_WAIT
    if argv[0] == "--list":
        list_sources(cwd, out)
        return 0
    try:
        budget, rest = split_budget(argv)
        if not rest:
            raise SourceError("name a source; `cc-wait --list` shows them")
        source = resolve(rest[0], cwd)
        bound = source.bind(rest[1:])
    except SourceError as exc:
        print(f"WAIT: error {exc}", file=out, flush=True)
        return COULD_NOT_WAIT
    resume = shlex.join(["cc-wait", *argv])
    budget_s = budget or default_budget(env)
    return loop.run(bound, budget_s, resume, out=out, cache=cache_dir(env))


if __name__ == "__main__":
    sys.exit(main())
