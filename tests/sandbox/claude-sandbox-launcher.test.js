// Regression guard for two pure-ish helpers behind executable_claude-sandbox,
// picked as the highest-value slice testable without docker. validate_version is
// still launcher-resident; detect_docker_need moved out to sandbox-image.sh, which
// is why extraction globs the libs rather than reading one file:
//   - validate_version(): the only gate between untrusted repo content
//     (.sdkmanrc/.nvmrc/go.mod/.terraform-version version strings) and a
//     shell command / curl URL built from it in generate_dockerfile() —
//     a missed injection char here is a container-escape-adjacent bug.
//   - detect_docker_need(): decides whether the container is granted a
//     Docker socket proxy at all (see the NEEDS_DOCKER gate later in the
//     launcher) — a false negative silently breaks compose workflows, a
//     false positive grants unnecessary Docker access.
// Uses the same technique as claude-sandbox-compose-scan.test.js: extract the
// REAL function body at test runtime (awk brace-depth counter) and drive it
// in a bash harness, rather than re-implementing or guessing its logic.
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

const SANDBOX_DIR = srcPath('private_dot_claude', 'sandbox');
const SANDBOX = path.join(SANDBOX_DIR, 'executable_claude-sandbox');
// The launcher plus every lib it sources — detect_docker_need now lives in the image
// lib. Globbed rather than listed, so the next function to move out does not break
// extraction here.
const SOURCES = [SANDBOX, ...fs.readdirSync(SANDBOX_DIR)
  .filter((f) => /^executable_sandbox-.*\.sh$/.test(f))
  .sort()
  .map((f) => path.join(SANDBOX_DIR, f))];

const skip = skipUnless('bash', 'awk');

// Extract <name>() { ... } verbatim: print from its def line, tracking brace
// depth, stop once depth returns to 0 at the matching closing brace.
function extractFunction(name) {
  const src = execFileSync('awk', [
    `/^${name}\\(\\) \\{/ { started=1 }\n` +
    'started {\n' +
    '  print\n' +
    '  depth += gsub(/{/,"{") - gsub(/}/,"}")\n' +
    '  if (started && depth==0) exit\n' +
    '}',
    ...SOURCES,
  ], { encoding: 'utf8' });
  assert.ok(new RegExp(`^${name}\\(\\) \\{`).test(src), `extracted the ${name} definition`);
  assert.strictEqual(src.trimEnd().split('\n').pop(), '}', `extracted ${name} body ends at its matching closing brace`);
  return src;
}

const VALIDATE_VERSION_SRC = extractFunction('validate_version');
const DETECT_DOCKER_NEED_SRC = extractFunction('detect_docker_need');

// Single-quote for safe embedding in a bash -c string (double quotes would let
// $(...) / `...` in an "unsafe" fixture actually execute during the harness's
// own parsing, before validate_version ever sees the literal string).
function shq(s) { return `'${s.replace(/'/g, `'\\''`)}'`; }

const runScript = (script, env = {}) => run('bash', ['-c', script], { env: { ...process.env, ...env } });

// --- validate_version(): untrusted-input sanitizer ---

const SAFE_VERSIONS = ['1.5.7', '3.11', '17', '1.21.0-rc1', '17_2+build'];
const UNSAFE_VERSIONS = [
  '1.5.7; rm -rf /',
  '$(whoami)',
  '1.5 7',
  '1.5.7`id`',
  '../../etc/passwd',
  '1.5.7|true',
  '1.5.7&&true',
  "1.5.7'",
];

test('validate_version accepts version strings made only of [0-9a-zA-Z._+-]', { skip }, () => {
  for (const v of SAFE_VERSIONS) {
    const r = runScript(`${VALIDATE_VERSION_SRC}\nvalidate_version label ${shq(v)}`);
    assert.strictEqual(r.code, 0, `should accept: ${v} (stderr: ${r.stderr})`);
    assert.strictEqual(r.stderr, '');
  }
});

test('validate_version rejects shell-metacharacter strings with exit 1 and an error message', { skip }, () => {
  for (const v of UNSAFE_VERSIONS) {
    const r = runScript(`${VALIDATE_VERSION_SRC}\nvalidate_version label ${shq(v)}`);
    assert.strictEqual(r.code, 1, `should reject: ${v}`);
    assert.match(r.stderr, /unsafe label version string/);
  }
});

// --- detect_docker_need(): NEEDS_DOCKER gate ---

function detectDockerNeed(repo) {
  const r = runScript(`${DETECT_DOCKER_NEED_SRC}\nNEEDS_DOCKER=false\ndetect_docker_need\nprintf '%s' "$NEEDS_DOCKER"`,
    { REPO_PATH: repo });
  assert.strictEqual(r.code, 0);
  return r.stdout;
}

test('a repo with no compose file and no Makefile does not need docker', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  assert.strictEqual(detectDockerNeed(dir), 'false');
});

test('a top-level docker-compose.yml sets NEEDS_DOCKER=true', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  assert.strictEqual(detectDockerNeed(dir), 'true');
});

test('a top-level compose.yaml (the newer compose-spec name) also sets NEEDS_DOCKER=true', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
  assert.strictEqual(detectDockerNeed(dir), 'true');
});

test('a compose file one directory deep (monorepo layout, maxdepth 2) is still detected', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  fs.mkdirSync(path.join(dir, 'backend'));
  fs.writeFileSync(path.join(dir, 'backend', 'docker-compose.yml'), 'services: {}\n');
  assert.strictEqual(detectDockerNeed(dir), 'true');
});

test('a compose file two directories deep is past the documented maxdepth 2 boundary and is missed', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  fs.mkdirSync(path.join(dir, 'backend', 'svc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backend', 'svc', 'docker-compose.yml'), 'services: {}\n');
  assert.strictEqual(detectDockerNeed(dir), 'false');
});

test('a Makefile referencing "docker compose" (space form) sets NEEDS_DOCKER=true', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'up:\n\tdocker compose up -d\n');
  assert.strictEqual(detectDockerNeed(dir), 'true');
});

test('a Makefile referencing "docker-compose" (hyphen form) sets NEEDS_DOCKER=true', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'up:\n\tdocker-compose up -d\n');
  assert.strictEqual(detectDockerNeed(dir), 'true');
});

test('a Makefile with unrelated content does not need docker', { skip }, () => {
  const dir = scratch(os.tmpdir(), 'cs-docker-need-');
  fs.writeFileSync(path.join(dir, 'Makefile'), 'build:\n\tgo build ./...\n');
  assert.strictEqual(detectDockerNeed(dir), 'false');
});

