// Regression guard for scan_untrusted_compose() inside executable_claude-sandbox —
// the untrusted-repo container-escape preflight scanner. The launcher itself can't
// run hermetically (docker/git), so this extracts the REAL function body at test
// runtime (awk brace-counting from its def line to the matching closing brace) and
// drives it in a bash harness against fixture compose files in scratch REPO_PATHs.
// Contract (read from the source, not guessed): with no tty on stdin (always true
// under execFileSync) a finding is non-interactive-refused via `exit 1`; no finding
// returns 0; CLAUDE_SANDBOX_NO_OVERRIDE_SCAN=1 silences the scan entirely.
// Offline. Skips cleanly if bash is unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');
const { skipUnless } = require('../lib/probe');
const { srcPath } = require('../lib/paths');
const { run } = require('../lib/run');

const SANDBOX = srcPath('private_dot_claude', 'sandbox', 'executable_claude-sandbox');

const skip = skipUnless('bash', 'jq');

// Extract scan_untrusted_compose() verbatim: print from its def line, tracking
// brace depth, stop once depth returns to 0 at the matching closing brace.
const FUNC_SRC = execFileSync('awk', [
  '/^scan_untrusted_compose\\(\\) \\{/ { started=1 }\n' +
  'started {\n' +
  '  print\n' +
  '  depth += gsub(/{/,"{") - gsub(/}/,"}")\n' +
  '  if (started && depth==0) exit\n' +
  '}',
  SANDBOX,
], { encoding: 'utf8' });
assert.ok(/^scan_untrusted_compose\(\) \{/.test(FUNC_SRC), 'extracted the function definition');
assert.strictEqual(FUNC_SRC.trimEnd().split('\n').pop(), '}', 'extracted body ends at its matching closing brace');

// Drive the extracted function with REPO_PATH pointed at a scratch fixture dir.
// stdin is never a tty here, so a finding always takes the non-interactive
// `exit 1` branch — deterministic, no y/N prompt to simulate.
function scan(repoPath, env = {}) {
  return run('bash', ['-c', FUNC_SRC + '\nscan_untrusted_compose'], { env: { ...process.env, REPO_PATH: repoPath, ...env } });
}

function writeCompose(dir, contents) {
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), contents);
}

test('benign compose file passes (exit 0, no findings)', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-compose-');
  writeCompose(dir, 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n');
  const r = scan(dir);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
});

test('privileged: true is flagged and denied (non-interactive exit 1)', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-compose-');
  writeCompose(dir, 'services:\n  web:\n    image: nginx\n    privileged: true\n');
  const r = scan(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /privileged/);
  assert.match(r.stderr, /Non-interactive session/);
});

test('cap_add is flagged and denied', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-compose-');
  writeCompose(dir, 'services:\n  web:\n    image: nginx\n    cap_add:\n      - SYS_ADMIN\n');
  const r = scan(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /cap_add/);
});

test('security_opt is flagged and denied', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-compose-');
  writeCompose(dir, 'services:\n  web:\n    image: nginx\n    security_opt:\n      - seccomp:unconfined\n');
  const r = scan(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /security_opt/);
});

test('network_mode: host is flagged and denied', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-compose-');
  writeCompose(dir, 'services:\n  web:\n    image: nginx\n    network_mode: host\n');
  const r = scan(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /network_mode/);
});

test('a mounted docker.sock is flagged and denied', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-compose-');
  writeCompose(dir, 'services:\n  web:\n    image: nginx\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n');
  const r = scan(dir);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /docker\.sock/);
});

test('CLAUDE_SANDBOX_NO_OVERRIDE_SCAN=1 silences the scan even with a dangerous fixture', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-compose-');
  writeCompose(dir, 'services:\n  web:\n    image: nginx\n    privileged: true\n');
  const r = scan(dir, { CLAUDE_SANDBOX_NO_OVERRIDE_SCAN: '1' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
});

