// Wires the repo's Python test suites into `node --test`, in the two shapes it
// has: standalone files runnable as `python3 test_x.py`, and pytest projects
// that need their own dependencies. Deterministic; skips cleanly when the
// runner it needs is absent.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const skip = skipUnless('python3');

const skipPytest = skipUnless('uv');

const SANDBOX = srcPath('private_dot_claude', 'sandbox');
const VAULT_TOOLING = srcPath('private_dot_claude', 'vault-tooling');
const SHARE = srcPath('dot_local', 'share');

const SUITES = [
  'test_exec_stream.py',
  'test_gen_vault_index.py',
  'test_gh_pr_guard.py',
  'test_compact_session.py',
  'test_docker_create_filter.py',
  'test_filter_policy.py',
];

// `python3 test_x.py` exits 0 whether it ran every test, some of them, or none
// at all, so an exit code cannot tell a green suite from an empty one. Each
// suite therefore reports how many tests it ran, and this counts how many it
// declares; the two disagreeing is the signal.
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
print(json.dumps({"sync": sync, "coroutines": coroutines}))
`;

for (const name of SUITES) {
  test(`python: ${name}`, { skip }, () => {
    const file = path.join(SANDBOX, name);
    const declared = JSON.parse(
      execFileSync('python3', ['-c', DECLARED_TESTS, file], { encoding: 'utf8' }),
    );

    assert.ok(declared.sync.length > 0, `${name} declares no module-level test_* functions`);
    // A globals() scan filtering on callable() calls an `async def` happily,
    // gets a coroutine back, and never runs the body. The counts still agree,
    // so the comparison below is blind to it.
    assert.deepStrictEqual(
      declared.coroutines,
      [],
      `${name}: async test_* is called but never awaited, so its body never runs: ` +
        declared.coroutines.join(', '),
    );

    const stdout = execFileSync('python3', [file], { encoding: 'utf8' });
    const reported = /^OK (\d+)$/m.exec(stdout);
    assert.ok(
      reported,
      `${name} exited 0 without reporting a test count — a suite wired in here needs a ` +
        '__main__ runner ending in `print(f"OK {ran}")`, or it passes without running anything',
    );
    assert.strictEqual(
      Number(reported[1]),
      declared.sync.length,
      `${name} ran ${reported[1]} of its ${declared.sync.length} declared tests ` +
        `(${declared.sync.join(', ')}) — a test below the __main__ block is not in globals() ` +
        'when the scan runs, and a hand-listed runner skips whatever the list omits',
    );
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
