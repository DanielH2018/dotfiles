// Wires the repo's Python test suites into `node --test`, in the two shapes it
// has: standalone files runnable as `python3 test_x.py`, and pytest projects
// that need their own dependencies. Deterministic; skips cleanly when the
// runner it needs is absent.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

let python3Ok = true;
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch { python3Ok = false; }
const skip = python3Ok ? false : 'python3 unavailable';

let uvOk = true;
try { execFileSync('uv', ['--version'], { stdio: 'ignore' }); } catch { uvOk = false; }
const skipPytest = uvOk ? false : 'uv unavailable';

const SANDBOX = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox');
const VAULT_TOOLING = path.join(__dirname, '..', 'home', 'private_dot_claude', 'vault-tooling');

const SUITES = [
  'test_exec_stream.py',
  'test_gen_vault_index.py',
  'test_gh_pr_guard.py',
  'test_compact_session.py',
];

for (const name of SUITES) {
  test(`python: ${name}`, { skip }, () => {
    execFileSync('python3', [path.join(SANDBOX, name)], { stdio: 'pipe' });
  });
}

// These two rely on pytest fixtures and have no __main__ runner, so
// `python3 test_x.py` collects nothing and exits 0 — a false pass, which is why
// they went unwired rather than being wired the cheap way.
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
  { dir: 'config-map', deps: ['pytest>=8.0'], env: {} },
  // vault-index needs duckdb, but not its other dependency: fastembed is
  // imported lazily inside embedder.py, and the suite substitutes a fake
  // embedder, so pulling ~200MB of onnxruntime in would buy nothing. It sets no
  // pythonpath of its own, hence PYTHONPATH here.
  { dir: 'vault-index', deps: ['pytest>=8.0', 'duckdb>=1.1.0'], env: { PYTHONPATH: '.' } },
];

for (const project of PYTEST_PROJECTS) {
  test(`pytest: ${project.dir}`, { skip: skipPytest }, () => {
    const withFlags = project.deps.flatMap((dep) => ['--with', dep]);
    try {
      execFileSync('uv', ['run', '--no-project', ...withFlags, 'pytest', '-p', 'no:cacheprovider', '-q'], {
        cwd: path.join(VAULT_TOOLING, project.dir),
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
