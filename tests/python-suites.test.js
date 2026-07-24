// Wires the repo's standalone Python test suites into `node --test`. Each file
// is runnable directly (`python3 test_x.py`) and exits non-zero on failure.
// Offline and deterministic. Skips cleanly if python3 is unavailable.
//
// Excluded (not wired here):
//   home/private_dot_claude/vault-tooling/config-map/tests/test_*.py (6 files)
//   home/private_dot_claude/vault-tooling/vault-index/tests/test_*.py (3 files)
//     - pytest-only: rely on pytest fixtures (tmp_path, monkeypatch, fake_env,
//       fixture_config, fake_embedder from conftest.py) and have no __main__
//       runner, so `python3 test_x.py` executes zero assertions (false pass).
//       This machine has no pytest/pip installed to run them properly.
//       test_indexer.py additionally imports duckdb, which is also unavailable.
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

let python3Ok = true;
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch { python3Ok = false; }
const skip = python3Ok ? false : 'python3 unavailable';

const SANDBOX = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox');

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
