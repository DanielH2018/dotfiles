# claude-guard slice 1: segmenter, `explain`, `replay` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `claude-guard` package skeleton with a Python port of `cmdparse.sh`'s segmenter that agrees with the bash implementation on every vector and on a 677-command replay corpus, plus the `segment --json`, `explain` and `replay` CLI subcommands.

**Architecture:** One stdlib-only package at `home/dot_local/share/claude-guard/` (deploys to `~/.local/share/claude-guard/`). `segment.py` is a line-by-line port of the awk pass in `cmdparse.sh`, keeping its contract: a refusal is a status, never a skip. `cli.py` exposes the segmenter for tests, for a human debugging a prompt, and for the parity gate against the bash hook. No hook is registered in this slice; the judge, the rules loader and the shims are slices 2 to 4.

**Tech Stack:** Python 3.14 (uv-managed interpreter), pytest 8, `uv run --no-project`, node:test for the repo-level runner wiring, shellcheck for the one bash shim.

**Spec:** `docs/specs/2026-09-06-claude-guard-design.md`

## Global Constraints

- Python 3.14 syntax; `requires-python = ">=3.14"`; stdlib only, no runtime dependencies.
- Edit the chezmoi **source** under `home/`, never `~/.local/share/claude-guard` or `~/.claude`. Do not run `chezmoi apply`.
- Work only in the worktree `/home/ubuntu/.local/share/chezmoi/.claude/worktrees/claude-guard` (branch `worktree-claude-guard`). Never `git stash` in this repo.
- Every rule or behaviour ships with an accept/reject test pair; a guard that only ever passes is not evidence.
- The segmenter's contract is `cmdparse.sh`'s: `unreadable:*` is a refusal the caller must treat as "defer or ask", never as "nothing to worry about".
- Run pytest from the package directory as `uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q` with `PYTHONPATH=.`; never `uv sync` (it writes a `.venv` into the source tree that chezmoi would deploy).
- Commit messages explain why. Commits are signed by the repo's git config; do not pass `--no-verify`. The pre-push gate needs `node` on PATH: `export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"` before `git push`.

---

## File structure

| path (under the worktree) | responsibility |
|---|---|
| `home/dot_local/share/claude-guard/pyproject.toml` | package metadata, pytest and ruff config for 3.14 |
| `home/dot_local/share/claude-guard/README.md` | what the package is, the segmenter contract, how to run tests |
| `home/dot_local/share/claude-guard/claude_guard/__init__.py` | version string only |
| `home/dot_local/share/claude-guard/claude_guard/segment.py` | `Segment`, `Parsed`, `parse()`: the awk pass, ported |
| `home/dot_local/share/claude-guard/claude_guard/cli.py` | `segment --json`, `explain`, `replay` |
| `home/dot_local/share/claude-guard/tests/test_segment.py` | the 24 `cmdparse.test.js` cases ported, plus the shared vector corpus |
| `home/dot_local/share/claude-guard/tests/test_cli.py` | the three subcommands, driven as subprocesses |
| `home/dot_local/bin/executable_claude-guard` | bash entry shim: resolves the managed 3.14 and execs `-m claude_guard.cli` |
| `tests/python-suites.test.js` (modify) | registers the package's pytest project with `--python 3.14` |
| `home/.chezmoiscripts/os-unix/run_once_after_install-python-tools.sh.tmpl:66` (modify) | installs 3.14 beside 3.12 |

---

### Task 1: Package skeleton and test-runner wiring

**Files:**
- Create: `home/dot_local/share/claude-guard/pyproject.toml`
- Create: `home/dot_local/share/claude-guard/claude_guard/__init__.py`
- Create: `home/dot_local/share/claude-guard/tests/test_package.py`
- Modify: `tests/python-suites.test.js:105-126` (the `PYTEST_PROJECTS` block and its loop)

**Interfaces:**
- Produces: the package import name `claude_guard`; the pytest invocation every later task uses.

- [ ] **Step 1: Write the failing test**

`home/dot_local/share/claude-guard/tests/test_package.py`:

```python
"""The package imports under the interpreter the shims will use."""

import sys

import claude_guard


def test_package_exposes_a_version():
    assert isinstance(claude_guard.__version__, str)
    assert claude_guard.__version__


def test_runs_under_python_314_or_newer():
    assert sys.version_info >= (3, 14), sys.version
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd home/dot_local/share/claude-guard
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q
```

Expected: `ModuleNotFoundError: No module named 'claude_guard'` (or "no tests ran" if pytest cannot find `tests/`).

- [ ] **Step 3: Create the package and its config**

`home/dot_local/share/claude-guard/pyproject.toml`:

```toml
[project]
name = "claude-guard"
version = "0.1.0"
description = "One Python package for Claude Code Bash permission decisions: segmentation, rules, checks."
requires-python = ">=3.14"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8.0"]

# Not built or installed: the hooks reach it by PYTHONPATH at its deployed path,
# the same way jsonq and tq are laid out. `package = false` keeps `uv run` from
# trying to build it.
[tool.uv]
package = false

[tool.pytest.ini_options]
testpaths = ["tests"]

# The repo root's ruff config targets py39 for the tools that must run under a
# system interpreter. This package runs under uv's managed 3.14 only, so it gets
# its own target; ruff picks the closest pyproject.toml.
[tool.ruff]
target-version = "py314"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "C4", "SIM"]
```

`home/dot_local/share/claude-guard/claude_guard/__init__.py`:

```python
"""claude-guard: one Python package for Claude Code Bash permission decisions.

Slice 1 ships the segmenter (`claude_guard.segment`) and the CLI that exposes it.
The judge, the rules loader and the hook shims are later slices of the same
package; see docs/specs/2026-09-06-claude-guard-design.md in the dotfiles repo.
"""

__version__ = "0.1.0"
```

- [ ] **Step 4: Run the test to verify it passes**

Same command as step 2. Expected: `2 passed`.

- [ ] **Step 5: Wire the project into the repo's node runner**

In `tests/python-suites.test.js`, the `PYTEST_PROJECTS` entries are resolved under `VAULT_TOOLING`. Add a per-project `root` and an optional `python`, and register the package. Replace the block from `const PYTEST_PROJECTS = [` through the `execFileSync('uv', …)` call with:

```js
const PYTEST_PROJECTS = [
  // config-map declares no runtime deps and sets pythonpath itself.
  { root: VAULT_TOOLING, dir: 'config-map', deps: ['pytest>=8.0'], env: {} },
  // vault-index needs duckdb, but not its other dependency: fastembed is
  // imported lazily inside embedder.py, and the suite substitutes a fake
  // embedder, so pulling ~200MB of onnxruntime in would buy nothing. It sets no
  // pythonpath of its own, hence PYTHONPATH here.
  { root: VAULT_TOOLING, dir: 'vault-index', deps: ['pytest>=8.0', 'duckdb>=1.1.0'], env: { PYTHONPATH: '.' } },
  // claude-guard is 3.14-only by design (spec: docs/specs/2026-09-06-claude-guard-design.md),
  // so it names its interpreter; uv fetches a managed 3.14 on a cold machine.
  { root: SHARE, dir: 'claude-guard', deps: ['pytest>=8.0'], env: { PYTHONPATH: '.' }, python: '3.14' },
];

for (const project of PYTEST_PROJECTS) {
  test(`pytest: ${project.dir}`, { skip: skipPytest }, () => {
    const withFlags = project.deps.flatMap((dep) => ['--with', dep]);
    const pythonFlags = project.python ? ['--python', project.python] : [];
    try {
      execFileSync('uv', ['run', '--no-project', ...pythonFlags, ...withFlags, 'pytest', '-p', 'no:cacheprovider', '-q'], {
        cwd: path.join(project.root, project.dir),
```

and add, next to the `VAULT_TOOLING` constant near the top of the file:

```js
const SHARE = path.join(__dirname, '..', 'home', 'dot_local', 'share');
```

- [ ] **Step 6: Run the node runner for just this file**

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
node --test tests/python-suites.test.js 2>&1 | tail -8
```

Expected: the summary shows `pytest: claude-guard` passing alongside the two existing projects, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add home/dot_local/share/claude-guard tests/python-suites.test.js
git commit -m "Add the claude-guard package skeleton under uv's 3.14

The spec (docs/specs/2026-09-06-claude-guard-design.md) moves the Bash
permission hooks into one Python package. This is the empty package with
its pytest project wired into the node runner, so every later slice lands
against a running suite. 3.14-only, so the runner learns a per-project
--python flag."
```

---

### Task 2: The segmenter data model and the port of the awk pass

**Files:**
- Create: `home/dot_local/share/claude-guard/claude_guard/segment.py`
- Create: `home/dot_local/share/claude-guard/tests/test_segment.py`

**Interfaces:**
- Produces:
  - `Segment(text: str, sep: str, heredocs: tuple[str, ...], heredoc_quoted: tuple[bool, ...])`, frozen. `sep` is one of `'&&' '||' ';' '|' '&' 'newline' 'eof'`.
  - `Parsed(status: str, segments: tuple[Segment, ...], substitutions: tuple[str, ...])`, frozen, with `.ok` (`status == "ok"`).
  - `parse(command: str) -> Parsed`. Statuses: `"ok"`, `"unreadable:unbalanced-quote"`, `"unreadable:substitution"`.
  - `visible(parsed: Parsed) -> list[str]`: the segment texts stripped and with empties dropped, which is how every consumer and the vector corpus see a split.

The reference is the awk program in `home/private_dot_claude/hooks/executable_cmdparse.sh` (from `_CP_AWK='` to the closing quote) plus the trailing-empty collapse in `cmd_parse()` just below it. awk is 1-indexed; the port is 0-indexed. Keep the branch order identical: it is what makes `'` inside `"…"` inert, a backtick inside `"…"` a substitution, and `<(` inside `"…"` plain text.

- [ ] **Step 1: Write the failing tests for separators and the trailing collapse**

`home/dot_local/share/claude-guard/tests/test_segment.py`:

```python
"""Port of tests/hooks/cmdparse.test.js, case for case, plus the shared corpus.

Every case names the bash test it mirrors so a divergence can be traced to the
original. `visible()` is the view every consumer takes: stripped, empties dropped.
"""

from claude_guard.segment import Parsed, Segment, parse, visible


def seps(p: Parsed) -> list[str]:
    return [s.sep for s in p.segments]


# --- separators ------------------------------------------------------------------------

def test_a_single_command_reports_one_segment_terminated_by_eof():
    p = parse("ls -la")
    assert p.ok
    assert p.segments == (Segment("ls -la", "eof", (), ()),)


def test_a_newline_separates_two_commands():
    p = parse("echo x\nterraform destroy")
    assert visible(p) == ["echo x", "terraform destroy"]
    assert seps(p) == ["newline", "eof"]


def test_the_newline_split_agrees_with_the_semicolon_and_and_and_glued_forms():
    forms = ["echo x\nterraform destroy", "echo x; terraform destroy",
             "echo x && terraform destroy", "echo x&&terraform destroy"]
    assert {tuple(visible(parse(f))) for f in forms} == {("echo x", "terraform destroy")}


def test_a_lone_ampersand_separates_and_does_not_glue_the_tail_onto_the_previous_segment():
    p = parse("git status && ls & rm -rf /")
    assert visible(p) == ["git status", "ls", "rm -rf /"]
    assert seps(p) == ["&&", "&", "eof"]


def test_a_pipe_separates_and_the_separator_is_recorded():
    p = parse("cat f | wc -l")
    assert visible(p) == ["cat f", "wc -l"]
    assert seps(p) == ["|", "eof"]


def test_or_or_is_one_separator_not_two_pipes():
    p = parse("test -f x || echo missing")
    assert visible(p) == ["test -f x", "echo missing"]
    assert seps(p) == ["||", "eof"]


def test_fd_dups_are_not_separators():
    p = parse("cmd 2>&1 >&2")
    assert visible(p) == ["cmd 2>&1 >&2"]


def test_a_trailing_separator_does_not_create_an_empty_second_command():
    for cmd in ("ls;", "ls\n", "ls &&\n"):
        p = parse(cmd)
        assert len(p.segments) == 1, cmd
        assert p.segments[0].sep == "eof", cmd


def test_a_trailing_command_after_a_separator_is_not_collapsed():
    p = parse("ls; pwd")
    assert len(p.segments) == 2
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd home/dot_local/share/claude-guard
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_segment.py
```

Expected: `ModuleNotFoundError: No module named 'claude_guard.segment'`.

- [ ] **Step 3: Write the port**

`home/dot_local/share/claude-guard/claude_guard/segment.py`:

```python
"""One decomposition of a Bash command, ported from cmdparse.sh's awk pass.

Contract, unchanged from the bash library:

    parse(command) -> Parsed
        .status      "ok" | "unreadable:unbalanced-quote" | "unreadable:substitution"
        .segments    top-level segments in order, each with the separator that TERMINATED it
                     (&& || ; | & newline eof), the heredoc bodies attached to it, and whether
                     each heredoc's delimiter was quoted (a quoted delimiter means the body
                     is not expanded, so it cannot carry a live substitution)
        .substitutions  the content of every $( ), `...`, <( ) and >( ), segmented the same
                     way and flattened across nesting depth; a nested substitution gets its
                     own entry beside its parent's

    A NON-OK STATUS IS A REFUSAL, NEVER A SKIP. The caller must defer (PermissionRequest)
    or ask (PreToolUse). It must never be read as "nothing to worry about here".

Why one pass: heredoc lifting and substitution scanning share the same frame stack, so a
heredoc textually inside a double-quoted substitution (`git commit -am "$(cat <<'EOF' … EOF)"`)
is still lifted once the scan crosses into the `$( )` and is back at a command position. A
two-pass version of this parser shipped that bug in bash.

Frames: squote, dquote, backtick, paren ($( )), dparen ($(( ))), brace (${ }), procsub.
Separators and `<<` are recognised only at a command position: stack empty, or the innermost
frame executing (paren, procsub, backtick). $(( )) and ${ } are tracked to their boundary but
are not executing, so `<<` inside $(( )) is a shift operator, and closing either records no
substitution.

Separators are `&&`, `||`, `;`, `|`, a lone `&` not preceded by `<`/`>` (fd dups), and a
newline. A trailing separator terminates the last segment rather than opening an empty one
(`ls;` is one segment), because the compound gate keys on the segment count and a spurious
second segment would widen it.
"""

from dataclasses import dataclass

_EXECUTING = frozenset({"paren", "procsub", "backtick"})
_SUB_FRAMES = frozenset({"paren", "dparen", "procsub"})
_DELIM_END = frozenset(" \t\n;&|><(")


@dataclass(frozen=True, slots=True)
class Segment:
    text: str
    sep: str
    heredocs: tuple[str, ...]
    heredoc_quoted: tuple[bool, ...]


@dataclass(frozen=True, slots=True)
class Parsed:
    status: str
    segments: tuple[Segment, ...]
    substitutions: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def _unreadable(reason: str) -> Parsed:
    return Parsed(f"unreadable:{reason}", (), ())


def parse(command: str) -> Parsed:
    s = command
    n = len(s)

    kind: list[str] = []        # frame stack
    cnt: list[int] = []         # nesting counter per frame, aligned with `kind`
    seg_start: list[int] = [0]  # per depth; index 0 is the top level
    pend: list[tuple[str, bool, bool, int]] = []   # (delim, strip_tabs, quoted, offset)
    heredocs: list[tuple[int, str, bool]] = []      # (offset, body, quoted)
    segs: list[list] = []                           # [text, sep, off0, off1]
    subs: list[str] = []

    def push(k: str, start: int) -> None:
        kind.append(k)
        cnt.append(0)
        seg_start.append(start)

    def pop() -> None:
        kind.pop()
        cnt.pop()
        seg_start.pop()

    def cut(i: int, sep: str) -> None:
        depth = len(kind)
        piece = s[seg_start[depth]:i]
        if depth == 0:
            segs.append([piece, sep, seg_start[0], i])
        else:
            subs.append(piece)

    i = 0
    while i < n:
        c = s[i]
        depth = len(kind)
        top = kind[-1] if kind else ""

        if top == "squote":
            if c == "'":
                pop()
            i += 1
            continue

        if c == "\\":
            i += 2
            continue

        if c == "'":
            if top == "dquote":
                i += 1
                continue
            push("squote", i + 1)
            i += 1
            continue

        if c == '"':
            if top == "dquote":
                pop()
                i += 1
                continue
            push("dquote", i + 1)
            i += 1
            continue

        if c == "`":
            if top == "backtick":
                subs.append(s[seg_start[depth]:i])
                pop()
                i += 1
                continue
            push("backtick", i + 1)
            i += 1
            continue

        next1 = s[i + 1] if i + 1 < n else ""

        if c == "$" and next1 == "(":
            next2 = s[i + 2] if i + 2 < n else ""
            push("dparen" if next2 == "(" else "paren", i + 2)
            i += 2
            continue

        if c == "$" and next1 == "{":
            push("brace", i + 2)
            i += 2
            continue

        if c in "<>" and next1 == "(" and top != "dquote":
            push("procsub", i + 2)
            i += 2
            continue

        if top in _SUB_FRAMES:
            if c == "(":
                cnt[-1] += 1
                i += 1
                continue
            if c == ")":
                if cnt[-1] > 0:
                    cnt[-1] -= 1
                    i += 1
                    continue
                if top != "dparen":
                    subs.append(s[seg_start[depth]:i])
                pop()
                i += 1
                continue

        if top == "brace":
            if c == "{":
                cnt[-1] += 1
                i += 1
                continue
            if c == "}":
                if cnt[-1] > 0:
                    cnt[-1] -= 1
                    i += 1
                    continue
                pop()
                i += 1
                continue

        at_cmd = depth == 0 or top in _EXECUTING

        if at_cmd and c == "<" and next1 == "<":
            next2 = s[i + 2] if i + 2 < n else ""
            if next2 != "<":  # `<<<` is a herestring, not a heredoc
                hoff = i
                j = i + 2
                strip = False
                if j < n and s[j] == "-":
                    strip = True
                    j += 1
                while j < n and s[j] in " \t":
                    j += 1
                quoted = False
                delim = ""
                if j < n and s[j] in "'\"":
                    q = s[j]
                    j += 1
                    k = s.find(q, j)
                    if k == -1:
                        return _unreadable("unbalanced-quote")
                    delim = s[j:k]
                    quoted = True
                    j = k + 1
                else:
                    while j < n and s[j] not in _DELIM_END:
                        delim += s[j]
                        j += 1
                pend.append((delim, strip, quoted, hoff))
                i = j
                continue

        if at_cmd:
            if (c == "&" and next1 == "&") or (c == "|" and next1 == "|"):
                cut(i, c + next1)
                seg_start[depth] = i + 2
                i += 2
                continue
            if c == "&":
                prevc = s[i - 1] if i > seg_start[depth] else ""
                if prevc != ">" and prevc != "<":
                    cut(i, "&")
                    seg_start[depth] = i + 1
                    i += 1
                    continue
            if c == ";" or c == "|":
                cut(i, c)
                seg_start[depth] = i + 1
                i += 1
                continue
            if c == "\n":
                cut(i, "newline")
                seg_start[depth] = i + 1
                i += 1
                if pend:
                    body_start = i
                    for delim, strip, quoted, hoff in pend:
                        body = ""
                        while True:
                            rest = s[body_start:]
                            line_end = rest.find("\n")
                            if line_end == -1:
                                line, has_nl = rest, False
                            else:
                                line, has_nl = rest[:line_end], True
                            cmp = line.lstrip("\t") if strip else line
                            if cmp == delim:
                                body_start = body_start + line_end + 1 if has_nl else n
                                break
                            body += line + "\n"
                            if not has_nl:
                                body_start = n
                                break
                            body_start += line_end + 1
                        heredocs.append((hoff, body, quoted))
                    pend.clear()
                    seg_start[depth] = body_start
                    i = body_start
                continue

        i += 1

    if kind:
        reason = "substitution"
        if any(k in ("squote", "dquote") for k in kind):
            reason = "unbalanced-quote"
        return _unreadable(reason)

    segs.append([s[seg_start[0]:], "eof", seg_start[0], n + 1])

    # A trailing separator terminates the last command; it does not start an empty new one.
    # A loop, because `ls &&\n` ends in two separators back to back.
    while len(segs) > 1:
        text, _sep, off0, off1 = segs[-1]
        if any(off0 <= hoff < off1 for hoff, _b, _q in heredocs):
            break
        if text.strip(" \t\r\n"):
            break
        segs.pop()
        segs[-1][1] = "eof"

    out: list[Segment] = []
    for text, sep, off0, off1 in segs:
        mine = [(body, quoted) for hoff, body, quoted in heredocs if off0 <= hoff < off1]
        out.append(Segment(text, sep, tuple(b for b, _q in mine), tuple(q for _b, q in mine)))
    return Parsed("ok", tuple(out), tuple(subs))


def visible(parsed: Parsed) -> list[str]:
    """The split as every consumer sees it: stripped, with empty segments dropped."""
    return [t for t in (seg.text.strip() for seg in parsed.segments) if t]
```

- [ ] **Step 4: Run the tests to verify they pass**

Same command as step 2. Expected: `9 passed`.

- [ ] **Step 5: Commit**

```bash
git add claude_guard/segment.py tests/test_segment.py
git commit -m "Port cmdparse.sh's segmenter to Python

Line for line from the awk pass, same frame stack, same branch order, same
trailing-empty collapse. The port adds one field the awk did not record:
whether each heredoc's delimiter was quoted, which the judge needs to tell
a Write-shaped heredoc from one whose body can expand."
```

---

### Task 3: Quotes, escapes and substitutions

**Files:**
- Modify: `home/dot_local/share/claude-guard/tests/test_segment.py` (append)

**Interfaces:**
- Consumes: `parse`, `visible`, `Parsed.substitutions` from Task 2.

These cases pin the branch order in the port. They mirror the named `cmdparse.test.js` cases; if one fails, the port diverged from the awk and the fix is in `segment.py`, not in the test.

- [ ] **Step 1: Append the tests**

```python
# --- quotes and escapes ----------------------------------------------------------------

def test_a_quoted_separator_does_not_split():
    assert visible(parse("echo 'a; b' && echo \"c | d\"")) == ["echo 'a; b'", "echo \"c | d\""]


def test_separately_quoted_arguments_still_split_between_them():
    assert visible(parse("echo 'a'; echo 'b'")) == ["echo 'a'", "echo 'b'"]


def test_an_escaped_separator_does_not_split():
    assert visible(parse("echo a\\; b")) == ["echo a\\; b"]


def test_a_single_quote_inside_double_quotes_is_inert():
    p = parse('echo "it\'s"; ls')
    assert p.ok
    assert visible(p) == ['echo "it\'s"', "ls"]


def test_an_unbalanced_quote_is_refused_never_approximated():
    p = parse("echo 'oops; rm -rf /")
    assert p.status == "unreadable:unbalanced-quote"
    assert p.segments == ()
    assert not p.ok


def test_an_unbalanced_double_quote_is_refused():
    assert parse('echo "oops').status == "unreadable:unbalanced-quote"


# --- substitutions ---------------------------------------------------------------------

def test_command_and_process_substitution_parse_instead_of_refusing_and_expose_their_content():
    p = parse("echo $(ls; terraform apply) <(cat x)")
    assert p.ok
    assert len(p.segments) == 1
    assert p.substitutions == ("ls", " terraform apply", "cat x")


def test_a_substitution_inside_double_quotes_is_not_a_blind_spot():
    p = parse('echo "$(id)"')
    assert p.ok
    assert p.substitutions == ("id",)


def test_a_backtick_substitution_is_recorded():
    p = parse("echo `whoami`; ls")
    assert visible(p) == ["echo `whoami`", "ls"]
    assert p.substitutions == ("whoami",)


def test_nested_substitutions_are_each_recorded_exactly_once():
    p = parse("echo $(echo $(id))")
    assert p.ok
    assert p.substitutions == ("id", "echo $(id)")


def test_a_substitution_containing_a_quote_parses_and_its_content_is_exposed_intact():
    p = parse('echo "$(echo "inner"; ls)"')
    assert p.ok
    assert p.substitutions == ('echo "inner"', " ls")


def test_dollar_brace_is_not_treated_as_execution():
    p = parse("echo ${x:-default}; ls")
    assert p.ok
    assert p.substitutions == ()
    assert visible(p) == ["echo ${x:-default}", "ls"]


def test_a_substitution_nested_inside_dollar_brace_is_still_found():
    p = parse("echo ${x:-$(id)}")
    assert p.substitutions == ("id",)


def test_arithmetic_is_tracked_but_records_no_substitution():
    p = parse("echo $((1 << 2)); ls")
    assert p.ok
    assert p.substitutions == ()
    assert visible(p) == ["echo $((1 << 2))", "ls"]


def test_an_unbalanced_substitution_is_still_refused():
    p = parse("echo $(ls")
    assert p.status == "unreadable:substitution"


def test_an_unbalanced_quote_inside_a_substitution_reports_the_quote():
    assert parse("echo $(echo 'x)").status == "unreadable:unbalanced-quote"
```

- [ ] **Step 2: Run the file**

Same pytest command, `tests/test_segment.py`. Expected: all pass. If a case fails, compare the branch in `segment.py` against the same branch in the awk (`executable_cmdparse.sh`) and fix the port; do not change the expected value unless `bash executable_cmdparse.sh --json` gives that value for the same input.

To check a single input against bash:

```bash
printf '%s' 'echo $(echo $(id))' | bash ../../../private_dot_claude/hooks/executable_cmdparse.sh --json
```

- [ ] **Step 3: Commit**

```bash
git add tests/test_segment.py
git commit -m "Pin the segmenter's quote and substitution branches"
```

---

### Task 4: Heredocs

**Files:**
- Modify: `home/dot_local/share/claude-guard/tests/test_segment.py` (append)

**Interfaces:**
- Consumes: `Segment.heredocs`, `Segment.heredoc_quoted` from Task 2.

- [ ] **Step 1: Append the tests**

```python
# --- heredocs --------------------------------------------------------------------------

BODY = "line one; rm -rf /\nline two && terraform destroy\n"


def test_a_heredoc_body_is_lifted_not_segmented():
    p = parse(f"cat <<'EOF'\n{BODY}EOF")
    assert p.ok
    assert visible(p) == ["cat <<'EOF'"]
    assert p.segments[0].heredocs == (BODY,)
    assert p.segments[0].heredoc_quoted == (True,)


def test_an_unquoted_delimiter_is_recorded_as_unquoted():
    p = parse(f"cat <<EOF\n{BODY}EOF")
    assert p.segments[0].heredocs == (BODY,)
    assert p.segments[0].heredoc_quoted == (False,)


def test_a_redirect_alongside_a_heredoc_stays_visible_in_the_segment():
    p = parse("cat > /tmp/x <<'EOF'\nhello\nEOF")
    assert visible(p) == ["cat > /tmp/x <<'EOF'"]
    assert p.segments[0].heredocs == ("hello\n",)


def test_a_command_after_a_terminated_heredoc_is_its_own_segment():
    p = parse("cat <<'EOF'\nhello\nEOF\nls")
    assert visible(p) == ["cat <<'EOF'", "ls"]
    assert p.segments[0].heredocs == ("hello\n",)
    assert p.segments[1].heredocs == ()


def test_dash_strips_leading_tabs_when_matching_the_terminator():
    p = parse("cat <<-EOF\n\thello\n\tEOF\nls")
    assert visible(p) == ["cat <<-EOF", "ls"]
    assert p.segments[0].heredocs == ("\thello\n",)


def test_triple_angle_is_a_herestring_not_a_heredoc():
    p = parse("cat <<< 'hello'; ls")
    assert visible(p) == ["cat <<< 'hello'", "ls"]
    assert p.segments[0].heredocs == ()


def test_a_heredoc_with_no_terminator_runs_to_the_end_of_input():
    p = parse("cat <<'EOF'\nhello\nworld")
    assert p.ok
    assert p.segments[0].heredocs == ("hello\nworld\n",)


def test_a_heredoc_inside_a_double_quoted_substitution_is_lifted_not_misread_as_syntax():
    cmd = 'git commit -am "$(cat <<\'EOF\'\nbody; with & shell | syntax\nEOF\n)"'
    p = parse(cmd)
    assert p.ok
    assert len(p.segments) == 1
    assert "cat <<'EOF'" in p.substitutions[0]


def test_two_heredocs_on_one_command_are_both_attached_in_order():
    p = parse("diff <(cat <<'A'\none\nA\n) - <<'B'\ntwo\nB")
    assert p.ok


def test_an_unterminated_quoted_delimiter_is_refused():
    assert parse("cat <<'EOF\nhello").status == "unreadable:unbalanced-quote"


def test_a_trailing_segment_that_only_carries_a_heredoc_is_not_collapsed():
    # The collapse drops an EMPTY tail; a tail that owns a heredoc body is not empty.
    p = parse("ls;\ncat <<'EOF'\nx\nEOF")
    assert [seg.heredocs for seg in p.segments][-1] == ("x\n",)
```

- [ ] **Step 2: Run the file**

Same command. Expected: all pass. Divergence rule as in Task 3.

- [ ] **Step 3: Commit**

```bash
git add tests/test_segment.py
git commit -m "Pin heredoc lifting, including the quoted-delimiter flag the port adds"
```

---

### Task 5: The shared vector corpus and the bash parity test

**Files:**
- Create: `home/dot_local/share/claude-guard/tests/test_vectors.py`

**Interfaces:**
- Consumes: `parse`, `visible`.
- Produces: `bash_parse(command) -> dict` helper reused by Task 6's replay test.

The corpus `tests/fixtures/command-vectors.json` at the repo root is `{"vectors": [{name, why, command, readonly, cmdparse: {status, segments}}]}`, 15 entries. The bash test compares `status` and the stripped, non-empty segments. This test does the same, and additionally runs every vector through `executable_cmdparse.sh --json` and compares the full decomposition.

- [ ] **Step 1: Write the tests**

```python
"""The shared adversarial corpus, and byte-for-byte parity with the bash segmenter.

tests/fixtures/command-vectors.json at the repo root is asserted by two implementations
today: cmdparse.sh (bash) and auto-approve-readonly.py in the server repo. This package
replaces the first; until slice 6 retires the bash, both must agree, and this file is
where a divergence shows up.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from claude_guard.segment import parse, visible

REPO = Path(__file__).resolve().parents[5]
FIXTURE = REPO / "tests" / "fixtures" / "command-vectors.json"
CMDPARSE = REPO / "home" / "private_dot_claude" / "hooks" / "executable_cmdparse.sh"

skip_no_fixture = pytest.mark.skipif(not FIXTURE.exists(), reason="corpus not beside a deployed copy")
skip_no_bash = pytest.mark.skipif(
    not (CMDPARSE.exists() and shutil.which("bash") and shutil.which("awk")),
    reason="bash segmenter unavailable",
)


def vectors() -> list[dict]:
    return json.loads(FIXTURE.read_text())["vectors"]


def bash_parse(command: str) -> dict:
    out = subprocess.run(
        ["bash", str(CMDPARSE), "--json"], input=command, capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)


@skip_no_fixture
def test_the_corpus_is_not_silently_empty():
    vs = vectors()
    assert len(vs) >= 10
    assert any(v["readonly"] for v in vs)
    assert any(not v["readonly"] for v in vs)


@skip_no_fixture
@pytest.mark.parametrize("v", vectors() if FIXTURE.exists() else [], ids=lambda v: v["name"])
def test_corpus_vector(v):
    p = parse(v["command"])
    assert p.status == v["cmdparse"]["status"]
    assert visible(p) == v["cmdparse"]["segments"]


@skip_no_fixture
@skip_no_bash
@pytest.mark.parametrize("v", vectors() if FIXTURE.exists() else [], ids=lambda v: v["name"])
def test_bash_parity_on_the_corpus(v):
    b = bash_parse(v["command"])
    p = parse(v["command"])
    assert p.status == b["status"]
    assert [s.text for s in p.segments] == b["seg"]
    assert [s.sep for s in p.segments] == b["sep"]
    assert ["\x1f".join(s.heredocs) for s in p.segments] == b["heredoc"]
    assert list(p.substitutions) == b["subseg"]


@skip_no_bash
@pytest.mark.parametrize(
    "command",
    [
        "cat <<'EOF'\nline one\nEOF\nls",
        'git commit -am "$(cat <<\'EOF\'\nbody\nEOF\n)"',
        "echo $(echo $(id)) `whoami` ${x:-$(id)} $((1<<2))",
        "ls &&\n",
        "cmd 2>&1 >&2 | tail -3",
        "echo 'unbalanced",
    ],
)
def test_bash_parity_on_hand_picked_shapes(command):
    b = bash_parse(command)
    p = parse(command)
    assert p.status == b["status"]
    assert [s.text for s in p.segments] == b["seg"]
    assert [s.sep for s in p.segments] == b["sep"]
    assert ["\x1f".join(s.heredocs) for s in p.segments] == b["heredoc"]
    assert list(p.substitutions) == b["subseg"]
```

- [ ] **Step 2: Run it**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_vectors.py
```

Expected: all pass, none skipped (the worktree has the fixture and the bash library). A parity failure names the field; fix `segment.py`.

- [ ] **Step 3: Commit**

```bash
git add tests/test_vectors.py
git commit -m "Assert the segmenter against the shared corpus and against cmdparse.sh

The corpus is the cross-implementation contract both repos rely on; the
parity test compares the full decomposition, not only the visible split,
so the port cannot drift in a field the corpus does not cover."
```

---

### Task 6: The CLI: `segment --json`, `explain`, `replay`

**Files:**
- Create: `home/dot_local/share/claude-guard/claude_guard/cli.py`
- Create: `home/dot_local/share/claude-guard/tests/test_cli.py`

**Interfaces:**
- Consumes: `parse`, `visible`, `Parsed`, `Segment`.
- Produces: `main(argv: list[str] | None = None) -> int`; the JSON shape of `segment --json`, identical to `cmdparse.sh --json`: `{"status","nseg","seg","sep","heredoc","subseg"}`; the replay record shape `{"command": str, "cwd": str}` per JSONL line.

`replay` in this slice has one mode, `--compare-bash PATH`: the slice-1 exit criterion. Its allow-count mode arrives with the judge in slice 2.

- [ ] **Step 1: Write the failing tests**

```python
"""The CLI, driven as a subprocess the way the shims and a human will drive it."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

PKG_DIR = Path(__file__).resolve().parents[1]
CMDPARSE = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks" / "executable_cmdparse.sh"


def run(*args: str, stdin: str = "") -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", *args],
        input=stdin, capture_output=True, text=True, cwd=PKG_DIR,
        env={"PYTHONPATH": str(PKG_DIR), "PATH": "/usr/bin:/bin"},
    )


def test_segment_json_matches_the_bash_shape():
    r = run("segment", "--json", stdin="ls; cat <<'EOF'\nx\nEOF")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out == {
        "status": "ok", "nseg": 2,
        "seg": ["ls", " cat <<'EOF'"], "sep": [";", "eof"],
        "heredoc": ["", "x\n"], "subseg": [],
    }


def test_segment_json_reports_a_refusal_as_a_status_not_an_error():
    r = run("segment", "--json", stdin="echo 'oops")
    assert r.returncode == 0
    assert json.loads(r.stdout)["status"] == "unreadable:unbalanced-quote"


def test_explain_prints_one_line_per_segment_with_its_separator():
    r = run("explain", "git status && ls & rm -rf /")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.splitlines()
    assert lines[0] == "status: ok"
    assert lines[1] == "[0] sep=&& heredocs=0: git status"
    assert lines[2] == "[1] sep=& heredocs=0: ls"
    assert lines[3] == "[2] sep=eof heredocs=0: rm -rf /"


def test_explain_lists_substitutions():
    r = run("explain", "echo $(id)")
    assert "sub[0]: id" in r.stdout


def test_explain_on_a_refusal_exits_nonzero_and_says_why():
    r = run("explain", "echo 'oops")
    assert r.returncode == 1
    assert "status: unreadable:unbalanced-quote" in r.stdout


@pytest.mark.skipif(not CMDPARSE.exists(), reason="bash segmenter not beside a deployed copy")
def test_replay_compare_bash_reports_parity(tmp_path):
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(
        json.dumps({"command": "ls; pwd", "cwd": "/tmp"}) + "\n"
        + json.dumps({"command": "cat <<'EOF'\nx\nEOF\nls", "cwd": "/tmp"}) + "\n"
    )
    r = run("replay", str(corpus), "--compare-bash", str(CMDPARSE))
    assert r.returncode == 0, r.stderr + r.stdout
    assert r.stdout.strip().splitlines()[-1] == "PARITY 2/2"


@pytest.mark.skipif(not CMDPARSE.exists(), reason="bash segmenter not beside a deployed copy")
def test_replay_compare_bash_exits_nonzero_on_a_mismatch(tmp_path, monkeypatch):
    # A fake bash segmenter that disagrees on purpose proves the comparison can go red.
    fake = tmp_path / "fake-cmdparse.sh"
    fake.write_text('#!/bin/bash\ncat >/dev/null\nprintf \'{"status":"ok","nseg":1,"seg":["nope"],"sep":["eof"],"heredoc":[""],"subseg":[]}\\n\'\n')
    fake.chmod(0o755)
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls", "cwd": "/tmp"}) + "\n")
    r = run("replay", str(corpus), "--compare-bash", str(fake))
    assert r.returncode == 1
    assert "PARITY 0/1" in r.stdout
    assert "MISMATCH" in r.stdout
```

- [ ] **Step 2: Run to verify they fail**

```bash
PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q tests/test_cli.py
```

Expected: every test fails with `No module named claude_guard.cli`.

- [ ] **Step 3: Write the CLI**

`home/dot_local/share/claude-guard/claude_guard/cli.py`:

```python
"""claude-guard command line.

    claude-guard segment --json            # decomposition of the command on stdin, cmdparse.sh's shape
    claude-guard explain "<command>"       # the segments and, from slice 2, the rule that decided each
    claude-guard replay <jsonl> --compare-bash <cmdparse.sh>
                                           # parity of every {command, cwd} record against the bash segmenter

`segment --json` exists for tests and the parity gate, never for the hook path. The hook
entry points (`permission-request`, `pre-tool-use`) arrive in slice 2.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from claude_guard.segment import Parsed, parse


def to_json_shape(p: Parsed) -> dict:
    """The dict `cmdparse.sh --json` prints, so the two can be compared field for field."""
    return {
        "status": p.status,
        "nseg": len(p.segments),
        "seg": [s.text for s in p.segments],
        "sep": [s.sep for s in p.segments],
        "heredoc": ["\x1f".join(s.heredocs) for s in p.segments],
        "subseg": list(p.substitutions),
    }


def cmd_segment(args: argparse.Namespace) -> int:
    command = sys.stdin.read()
    print(json.dumps(to_json_shape(parse(command))))
    return 0


def cmd_explain(args: argparse.Namespace) -> int:
    p = parse(args.command)
    print(f"status: {p.status}")
    for i, seg in enumerate(p.segments):
        print(f"[{i}] sep={seg.sep} heredocs={len(seg.heredocs)}: {seg.text.strip()}")
    for i, sub in enumerate(p.substitutions):
        print(f"sub[{i}]: {sub.strip()}")
    return 0 if p.ok else 1


def bash_parse(cmdparse: Path, command: str) -> dict:
    out = subprocess.run(
        ["bash", str(cmdparse), "--json"], input=command, capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)


def cmd_replay(args: argparse.Namespace) -> int:
    records = [json.loads(line) for line in Path(args.corpus).read_text().splitlines() if line.strip()]
    agree = 0
    for rec in records:
        command = rec["command"]
        mine = to_json_shape(parse(command))
        theirs = bash_parse(Path(args.compare_bash), command)
        if mine == theirs:
            agree += 1
            continue
        head = command.replace("\n", "⏎")[:90]
        print(f"MISMATCH: {head}")
        for key in ("status", "seg", "sep", "heredoc", "subseg"):
            if mine[key] != theirs[key]:
                print(f"  {key}: python={mine[key]!r} bash={theirs[key]!r}")
    print(f"PARITY {agree}/{len(records)}")
    return 0 if agree == len(records) else 1


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="claude-guard", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("segment", help="decompose the command on stdin")
    s.add_argument("--json", action="store_true", required=True, help="print cmdparse.sh's JSON shape")
    s.set_defaults(fn=cmd_segment)

    e = sub.add_parser("explain", help="show how a command segments")
    e.add_argument("command")
    e.set_defaults(fn=cmd_explain)

    r = sub.add_parser("replay", help="run a JSONL of {command, cwd} records")
    r.add_argument("corpus")
    r.add_argument("--compare-bash", required=True, metavar="CMDPARSE_SH",
                   help="path to cmdparse.sh; report segmentation parity")
    r.set_defaults(fn=cmd_replay)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Same command. Expected: `7 passed`.

- [ ] **Step 5: Commit**

```bash
git add claude_guard/cli.py tests/test_cli.py
git commit -m "Add the claude-guard CLI: segment --json, explain, replay --compare-bash

replay is the slice-1 exit gate: it runs a corpus of real commands through
both segmenters and prints the parity. The fake-bash test proves the
comparison can go red, so a green PARITY line is evidence."
```

---

### Task 7: The `claude-guard` bin shim, the 3.14 install, the README

**Files:**
- Create: `home/dot_local/bin/executable_claude-guard`
- Create: `home/dot_local/share/claude-guard/README.md`
- Modify: `home/.chezmoiscripts/os-unix/run_once_after_install-python-tools.sh.tmpl:66`
- Create: `tests/claude-guard-shim.test.js`

**Interfaces:**
- Produces: `~/.local/bin/claude-guard <subcommand>` on a deployed machine.

- [ ] **Step 1: Write the failing node test for the shim**

`tests/claude-guard-shim.test.js`:

```js
// The claude-guard bin shim: resolves uv's managed 3.14 and execs the package CLI.
// Pins the two properties the spec's failure contract rests on: no uv-managed 3.14
// means a clear error on stderr and exit 2 (never a silent exit 0), and a present
// one runs the real CLI out of the source tree via CLAUDE_GUARD_HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const SHIM = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-guard');
const SHARE = path.join(__dirname, '..', 'home', 'dot_local', 'share', 'claude-guard');

let uvOk = true;
try { execFileSync('uv', ['--version'], { stdio: 'ignore' }); } catch { uvOk = false; }

test('shim runs the CLI from CLAUDE_GUARD_HOME', { skip: uvOk ? false : 'uv unavailable' }, () => {
  const r = spawnSync('bash', [SHIM, 'explain', 'ls; pwd'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^status: ok/m);
  assert.match(r.stdout, /\[1\] sep=eof heredocs=0: pwd/);
});

test('shim fails closed with a message when no managed 3.14 is available', () => {
  // A PATH with no uv makes `uv python find` fail the same way a missing interpreter does.
  const r = spawnSync('bash', [SHIM, 'explain', 'ls'], {
    encoding: 'utf8', env: { PATH: '/nonexistent', HOME: process.env.HOME, CLAUDE_GUARD_HOME: SHARE },
  });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /uv python install 3\.14/);
  assert.strictEqual(r.stdout, '');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
node --test tests/claude-guard-shim.test.js 2>&1 | tail -6
```

Expected: both fail, the shim file does not exist.

- [ ] **Step 3: Write the shim**

`home/dot_local/bin/executable_claude-guard`:

```bash
#!/usr/bin/env bash
# claude-guard — CLI entry for the claude_guard package: explain, replay, segment.
#
# Not a hook. The hook shims live in ~/.claude/hooks and carry the per-event failure
# contracts (spec: docs/specs/2026-09-06-claude-guard-design.md). This one is for a human or
# a test, so a missing interpreter is an error, not a silent no-decision.
#
# The package is 3.14-only and runs under uv's managed interpreter. `--no-project` matters:
# without it, `uv python find` run inside a uv project answers with that project's venv, which
# on the server repo is a different 3.14 with a different sys.path. `-S` skips site-packages;
# the package needs only the stdlib and PYTHONPATH still applies without site.
set -eu
SHARE="${CLAUDE_GUARD_HOME:-$HOME/.local/share/claude-guard}"
if ! PY=$(uv python find --no-project --managed-python 3.14 2>/dev/null); then
  echo "claude-guard: no uv-managed Python 3.14 found; run: uv python install 3.14" >&2
  exit 2
fi
PYTHONPATH="$SHARE" exec "$PY" -S -m claude_guard.cli "$@"
```

Make it executable in the source tree so the test can invoke it (chezmoi sets the mode from the `executable_` prefix on apply, but the test runs it in place):

```bash
chmod +x home/dot_local/bin/executable_claude-guard
```

- [ ] **Step 4: Run the node test to verify it passes**

Same command as step 2. Expected: `pass 2`.

- [ ] **Step 5: Install 3.14 beside 3.12**

In `home/.chezmoiscripts/os-unix/run_once_after_install-python-tools.sh.tmpl`, replace line 66:

```bash
uv python install 3.12 || echo "install-python-tools: 'uv python install 3.12' failed" >&2
```

with:

```bash
uv python install 3.12 || echo "install-python-tools: 'uv python install 3.12' failed" >&2
# claude-guard (~/.local/share/claude-guard) is 3.14-only; its shims resolve this interpreter
# at call time with `uv python find --no-project --managed-python 3.14`.
uv python install 3.14 || echo "install-python-tools: 'uv python install 3.14' failed" >&2
```

This is a `run_once` script, so a machine that has already run it does not re-run it. daniel-box already has 3.14.6 (`uv python list --only-installed`); on the PC and the Mac, run `uv python install 3.14` by hand once. Record that in the PR body.

- [ ] **Step 6: Write the README**

`home/dot_local/share/claude-guard/README.md`:

```markdown
# claude-guard

One Python package for Claude Code Bash permission decisions. Slice 1 ships the segmenter
and the CLI; the judge, the rules loader and the hook shims are later slices of the spec in
`docs/specs/2026-09-06-claude-guard-design.md` (dotfiles repo).

## The segmenter's contract

`claude_guard.segment.parse(command)` returns a `Parsed` whose `status` is `ok` or
`unreadable:<reason>`. **A non-ok status is a refusal, never a skip.** A caller must defer
(PermissionRequest) or ask (PreToolUse); it must never read it as "nothing to worry about".

On `ok`: `segments` are the top-level commands in order, each with the separator that
terminated it (`&&` `||` `;` `|` `&` `newline` `eof`), its lifted heredoc bodies, and whether
each heredoc delimiter was quoted. `substitutions` holds the content of every `$( )`,
`` ` ` ``, `<( )` and `>( )`, flattened across nesting. This is a port of `cmdparse.sh`'s
awk pass and agrees with it field for field (`tests/test_vectors.py`).

## Running

    claude-guard explain 'git status && ls & rm -rf /'
    claude-guard replay commands.jsonl --compare-bash ~/.claude/hooks/cmdparse.sh
    printf '%s' 'ls; pwd' | claude-guard segment --json

## Tests

From this directory, under uv's managed 3.14, without writing a `.venv` into the source tree:

    PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q

`tests/python-suites.test.js` at the repo root runs the same command as part of `node --test`.
```

- [ ] **Step 7: Lint and the gate-coverage guard**

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
shellcheck home/dot_local/bin/executable_claude-guard
bin/lint-sh-templates && bin/lint-bsd-portability
cd home/dot_local/share/claude-guard && uv run --no-project --python 3.14 --with ruff ruff check . && cd -
node --test tests/lint-gate-coverage.test.js 2>&1 | tail -4
```

Expected: shellcheck silent, both lints pass, ruff `All checks passed!`, and the gate-coverage test green. If gate-coverage names a registry the new bin or test file must join, add the entry it names and re-run.

- [ ] **Step 8: Commit**

```bash
git add home/dot_local/bin/executable_claude-guard home/dot_local/share/claude-guard/README.md \
        home/.chezmoiscripts/os-unix/run_once_after_install-python-tools.sh.tmpl tests/claude-guard-shim.test.js
git commit -m "Add the claude-guard bin shim and install its 3.14 interpreter

The package is 3.14-only, so the shim resolves uv's managed interpreter at
call time (--no-project, or a shim run inside a uv project gets that
project's venv). A missing interpreter is exit 2 with the install command
on stderr: this shim is for humans and tests, so it must not be silent."
```

---

### Task 8: The slice-1 exit gate: replay parity on the 677-command corpus, then the draft PR

**Files:** none new. This task produces evidence and the PR.

- [ ] **Step 1: Obtain the corpus**

`/tmp/prompted_inputs.jsonl` on daniel-box holds the 677 prompted Bash commands from the seven days to 2026-09-06 as `{command, cwd}` records. If it is gone, regenerate it (otelq and jq are allow-listed):

```bash
otelq logs '{service_name="claude-code"} | event_name="tool_decision" | source=~"user_.*"' \
  --stream --since 7d --limit 5000 > /tmp/prompted.json
jq -c '.data.result[].stream | select(.tool_name=="Bash") | {command: ((.tool_parameters|fromjson? // {}) | .full_command // ""), cwd: "/home/ubuntu/server"}' \
  /tmp/prompted.json > /tmp/prompted_inputs.jsonl
wc -l /tmp/prompted_inputs.jsonl
```

- [ ] **Step 2: Run the parity gate against the SOURCE bash segmenter**

```bash
CLAUDE_GUARD_HOME=$PWD/home/dot_local/share/claude-guard bash home/dot_local/bin/executable_claude-guard \
  replay /tmp/prompted_inputs.jsonl --compare-bash home/private_dot_claude/hooks/executable_cmdparse.sh | tail -15
```

Expected: `PARITY 677/677` (or N/N for the regenerated count) and exit 0. On a mismatch, the lines above the summary name the field; fix `segment.py`, add the shape to `test_bash_parity_on_hand_picked_shapes`, and re-run. Do not edit the corpus.

- [ ] **Step 3: Run the whole repo suite the way the pre-push gate does**

```bash
export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
git ls-files '*.test.js' '*.test.mjs' | xargs -r node --test 2>&1 | grep -E '^ℹ (tests|pass|fail|skipped)'
```

Expected: `fail 0`.

- [ ] **Step 4: Acknowledge the config-soak ledger if it asks**

The pre-push gate runs `config-soak` over reviewed config paths. This slice adds no hook, but if the push is blocked with `GATE FAIL — unreviewed change(s)`, review the named diff and run:

```bash
node bin/config-soak land <path-it-names>
git add config-soak.json && git commit -m "config-soak: acknowledge the claude-guard slice-1 files"
```

- [ ] **Step 5: Push and open the draft PR**

```bash
git push -u origin worktree-claude-guard
gh pr create --draft --title "Add claude-guard: a Python port of the Bash segmenter with a parity gate" --body-file - <<'EOF'
## What changed, and why

First slice of `docs/specs/2026-09-06-claude-guard-design.md`: the package skeleton, a
line-for-line port of `cmdparse.sh`'s awk segmenter, and a CLI whose `replay --compare-bash`
is the exit gate for this slice. No hook is registered yet; nothing changes for a session
until slice 3.

## Verification

- `tests/test_vectors.py`: the shared corpus and full-decomposition parity with
  `executable_cmdparse.sh` on every vector plus hand-picked heredoc and substitution shapes.
- Replay of the 677 prompted commands from the week to 2026-09-06:

      PARITY 677/677

- `git ls-files '*.test.js' '*.test.mjs' | xargs -r node --test`: <paste the ℹ pass/fail lines>

## After merge

On the PC and the Mac, `uv python install 3.14` once by hand; the install script is
`run_once` and has already run there.
EOF
```

Replace the placeholder line in the body with the real replay and test output before submitting.

---

## Self-review

**Spec coverage for slice 1.** Segmenter with `cmdparse.sh`'s contract: Tasks 2 to 5. Quoted-delimiter flag: Task 2 data model, Task 4 tests. `explain` and `replay`: Task 6. Package location, `pyproject.toml`, 3.14, stdlib only: Task 1. Interpreter resolution with `--no-project --managed-python`: Task 7. Corpus as acceptance test, parity on the 677-command replay: Tasks 5 and 8. Test-runner wiring: Task 1. Not in this slice, by the spec's rollout table: `rules.py`, `judge.py`, `checks/`, `deny.py`, the hook shims, shadow mode, and every doc-section update, which belong to slices 2 to 6 and get their own plans.

**Placeholder scan.** The one intentional placeholder is the PR body's `<paste …>` line, which Task 8 step 5 instructs the executor to replace with real output before submitting.

**Type consistency.** `Segment(text, sep, heredocs, heredoc_quoted)` and `Parsed(status, segments, substitutions)` are used with those names in Tasks 2 to 6. `visible()` returns `list[str]` everywhere. `to_json_shape()` emits the six keys the bash `--json` emits and `test_vectors.py` compares the same six by name.
