// Wires the repo's Python test suites into `node --test`, in the two shapes it
// has: standalone files runnable as `python3 test_x.py`, and pytest projects
// that need their own dependencies. Deterministic; skips cleanly when the
// runner it needs is absent.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { skipUnless } = require('./lib/probe');
const { REPO, srcPath } = require('./lib/paths');

const skip = skipUnless('python3');

const skipPytest = skipUnless('uv');

const VAULT_TOOLING = srcPath('private_dot_claude', 'vault-tooling');
const SHARE = srcPath('dot_local', 'share');

// The standalone suites are derived, not listed. A hand-kept list here skipped whatever it
// omitted, silently: nine hooks/test_*.py files were never on it, and one of them had gone
// red on main without anything noticing. The same way .githooks/pre-push and
// bin/sweep-test-tmp find their inputs, this asks git for every tracked test_*.py and takes
// away what is provably not a standalone suite:
//
//   - a file inside a pytest project, i.e. with a pyproject.toml in an ancestor directory
//     below the repo root: those run under PYTEST_PROJECTS below, with their own deps;
//   - a file beside a run.py: a directory that ships its own runner is one suite, run by
//     whoever runs the runner (tests/tq by tests/tq-digest.test.js);
//   - a file carrying the opt-out marker, a comment line starting `# python-suites: skip`.
//
// The marker is the only way out that is a decision rather than a fact of the tree, so it
// carries its reason on the same line and the file it sits in is the only place it lives.
// It exists because a derived list runs a Python file its author never meant as a
// node-driven suite: a script that satisfies neither contract below fails here for that
// reason, not for a failing test. A file is opted out to say why it is not wired, never to
// hide a red suite -- that one gets an issue, and the marker names it. No tracked file
// carries it: the nine hooks/ suites did, until #545 gave them a count line.
const OPT_OUT = /^# python-suites: skip\b/m;

function standaloneSuites() {
  const tracked = execFileSync('git', ['ls-files', 'test_*.py', '*/test_*.py'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const inPytestProject = (rel) => {
    for (let dir = path.dirname(rel); dir !== '.' && dir !== ''; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(REPO, dir, 'pyproject.toml'))) return true;
    }
    return false;
  };
  return tracked.filter((rel) => !inPytestProject(rel)
    && !fs.existsSync(path.join(REPO, path.dirname(rel), 'run.py'))
    && !OPT_OUT.test(fs.readFileSync(path.join(REPO, rel), 'utf8')));
}

const SUITES = standaloneSuites();

// A derivation that finds nothing passes for free. The floor is a named member, so the
// failure says which file went missing rather than that a count moved.
test('the derived standalone suite list is not empty and holds a known member', () => {
  assert.ok(SUITES.length >= 15, `expected at least the six sandbox and nine hooks suites, derived ${SUITES.length}: ${SUITES.join(', ')}`);
  assert.ok(SUITES.some((rel) => rel.endsWith('/test_exec_stream.py')), 'sandbox/test_exec_stream.py is a standalone suite and must be derived');
  assert.ok(SUITES.some((rel) => rel.endsWith('/hooks/test_prune_worktrees.py')), 'hooks/test_prune_worktrees.py is a standalone suite and must be derived');
  assert.ok(!SUITES.some((rel) => rel.startsWith('tests/tq/')), 'tests/tq is one unittest suite under run.py, not standalone files');
  assert.ok(!SUITES.some((rel) => rel.includes('claude-guard/')), 'a pytest project\'s tests are not standalone suites');
});

test('the opt-out marker excludes a file, and its absence includes one', () => {
  assert.match('#!/usr/bin/env python3\n# python-suites: skip -- reports all passed, no count line\n', OPT_OUT);
  assert.doesNotMatch('#!/usr/bin/env python3\n"""python-suites: skip is only a marker as a comment."""\n', OPT_OUT);
  // `git grep -l` exits 1 on no match, which is the expected state of the tree.
  let optedOut = [];
  try {
    optedOut = execFileSync('git', ['grep', '-l', '^# python-suites: skip', '--', '*.py'], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' })
      .split('\n').filter(Boolean);
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  for (const rel of optedOut) assert.ok(!SUITES.includes(rel), `${rel} carries the marker and must not be derived`);
});

// `python3 test_x.py` exits 0 whether it ran every test, some of them, or none
// at all, so an exit code cannot tell a green suite from an empty one. Each
// suite therefore reports how many tests it ran on an `OK N` line, and this
// counts how many it declares; the two disagreeing is the signal. Two shapes
// declare a test:
//
//   - module-level `test_*` functions, run by a `__main__` globals() scan
//     (the sandbox suites);
//   - `check(name, condition)` calls, one printed `ok  `/`FAIL` line each,
//     counted by the helper itself (the hooks suites). A check inside a loop
//     runs once per iteration, so for this shape the call-site count is a
//     floor, not an equality -- ran below it means a block of checks was never
//     reached, which is the failure the count exists to catch.
//
// Parsed, not imported: importing executes module-level code, and would still
// not fire the __main__ runner, so it would say nothing about what ran. Only
// module-level defs are counted, to match what the runner's globals() scan can
// see — a def nested inside another function is invisible to both.
const DECLARED_TESTS = `
import ast, json, sys

tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
sync, coroutines = [], []
for node in tree.body:
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    if not node.name.startswith("test_"):
        continue
    if isinstance(node, ast.AsyncFunctionDef):
        coroutines.append(node.name)
    else:
        sync.append(node.name)
has_check = any(isinstance(n, ast.FunctionDef) and n.name == "check" for n in tree.body)
checks = sum(
    1 for n in ast.walk(tree)
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "check"
)
print(json.dumps({"sync": sync, "coroutines": coroutines, "has_check": has_check, "checks": checks}))
`;

for (const rel of SUITES) {
  const name = path.basename(rel);
  test(`python: ${name}`, { skip }, () => {
    const file = path.join(REPO, rel);
    const declared = JSON.parse(
      execFileSync('python3', ['-c', DECLARED_TESTS, file], { encoding: 'utf8' }),
    );

    const checkStyle = declared.sync.length === 0 && declared.has_check;
    if (checkStyle) {
      assert.ok(declared.checks > 0, `${name} defines check() but never calls it`);
    } else {
      assert.ok(declared.sync.length > 0, `${name} declares no module-level test_* functions and no check() helper`);
    }
    // A globals() scan filtering on callable() calls an `async def` happily,
    // gets a coroutine back, and never runs the body. The counts still agree,
    // so the comparison below is blind to it.
    assert.deepStrictEqual(
      declared.coroutines,
      [],
      `${name}: async test_* is called but never awaited, so its body never runs: ` +
        declared.coroutines.join(', '),
    );

    let stdout;
    try {
      stdout = execFileSync('python3', [file], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      // Without this a red suite fails as `Command failed: python3 ...`, naming the
      // file and nothing else; the suite's own output names the check.
      const output = [err.stdout, err.stderr].filter(Boolean).join('').trim();
      throw new Error(`${name} exited ${err.status}\n${output}`);
    }
    const reported = /^OK (\d+)$/m.exec(stdout);
    assert.ok(
      reported,
      `${name} exited 0 without reporting a test count — a suite wired in here needs a ` +
        '__main__ runner ending in `print(f"OK {ran}")`, or it passes without running anything',
    );
    if (checkStyle) {
      const okLines = stdout.split('\n').filter((line) => line.startsWith('ok  ')).length;
      assert.strictEqual(
        Number(reported[1]),
        okLines,
        `${name} reports OK ${reported[1]} but printed ${okLines} ok lines — the count line ` +
          'and the check() helper have come apart',
      );
      assert.ok(
        Number(reported[1]) >= declared.checks,
        `${name} ran ${reported[1]} checks against ${declared.checks} check() call sites — ` +
          'a block of checks was never reached',
      );
    } else {
      assert.strictEqual(
        Number(reported[1]),
        declared.sync.length,
        `${name} ran ${reported[1]} of its ${declared.sync.length} declared tests ` +
          `(${declared.sync.join(', ')}) — a test below the __main__ block is not in globals() ` +
          'when the scan runs, and a hand-listed runner skips whatever the list omits',
      );
    }
  });
}

// These two rely on pytest fixtures and have no __main__ runner, so
// `python3 test_x.py` collects nothing and exits 0 — a false pass, which is why
// they went unwired rather than being wired the cheap way. Adding them to
// SUITES now fails on the missing count line instead of passing quietly, but
// they still need a real pytest run, which is what follows.
//
// Run through `uv run --no-project`, which resolves each project's deps into a
// cached ephemeral environment. Deliberately not `uv sync`: that writes a .venv
// into the chezmoi *source* tree, which a global gitignore hides from
// `git status` while chezmoi still deploys every file in it. `--no-project` and
// `-p no:cacheprovider` between them leave nothing behind to deploy.
//
// Needs the network only until uv's cache is warm, so this is the one part of
// the suite that is not offline on a cold machine.
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
        env: { ...process.env, ...project.env },
        stdio: 'pipe',
      });
    } catch (err) {
      // `stdio: pipe` keeps a green run quiet, but it also swallows the report
      // on a red one — without this the failure names the project and nothing
      // else, which is not enough to act on. pytest already ran -q.
      const output = [err.stdout, err.stderr].filter(Boolean).join('').trim();
      throw new Error(`pytest failed in ${project.dir}\n${output}`);
    }
  });
}
