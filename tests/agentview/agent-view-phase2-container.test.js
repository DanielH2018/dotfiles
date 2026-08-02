// Integration test (skip-unless-Docker) for Agent View Phase 2. Runs the ACTUAL committed
// hook + shared helper INSIDE a real claudebot container, over the real RW agent-view bind
// mount, mirroring the launcher's docker args (default user claudebot, --group-add 0). This
// exercises the container write path the hermetic host tests can't. Skips unless bash+jq on
// the host AND `docker info` works AND the base image exists (default claudebot:base,
// override with AGENT_VIEW_TEST_IMAGE). Real jq. The temp registry is chmod 0777 so the test
// probes the HOOK LOGIC regardless of host uid — the launcher's reliance on uid alignment is
// a deployment concern documented in the spec (§3/§10), not asserted here.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'hooks');
const SANDBOX = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox');
const HELPER = path.join(HOOKS, 'executable_agent-view-register.sh');
const HOOK = path.join(SANDBOX, 'executable_agent-view-state-hook.sh');
const IMAGE = process.env.AGENT_VIEW_TEST_IMAGE || 'claudebot:base';

function have(cmd, args) { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } }
const skip =
  !have('bash', ['-c', 'command -v jq']) ? 'bash/jq unavailable'
  : !have('docker', ['info']) ? 'docker daemon unavailable'
  : !have('docker', ['image', 'inspect', IMAGE]) ? `image ${IMAGE} not built`
  : false;

// Under podman-docker (the shim that execs rootless podman) a bind mount is denied
// unless it carries an SELinux relabel flag AND the run maps the container uid back
// to the caller — the same pair the launcher adds. No-ops under real Docker.
const PODMAN = (() => {
  try { return /podman/i.test(execFileSync('docker', ['--version'], { encoding: 'utf8' })); } catch { return false; }
})();
const ENGINE_ARGS = PODMAN ? ['--userns=keep-id:uid=1000,gid=1000'] : [];
const mnt = (spec) => (PODMAN ? (spec.split(':').length > 2 ? `${spec},z` : `${spec}:z`) : spec);

const dirs = [];
function reg() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'av-p2-'));
  fs.chmodSync(d, 0o777);                       // container uid may differ from host uid
  dirs.push(d);
  return d;
}
const KEY = 'airflow-abcd1234-foo';
const LOCATOR = 'tmux:/tmp/tmux-1000/default:main:%3';

// Seed a live sandbox row exactly as the launcher would (host-side av_write_full).
function seed(dir, state) {
  execFileSync('bash', ['-c',
    `source "${HELPER}"; av_write_full "${KEY}" "${state}" /repos/airflow host 100 sandbox ` +
    `"airflow · claude/foo (sandbox)" "${LOCATOR}" "" "${KEY}-deadbe"`],
    { env: { ...process.env, AGENT_VIEW_DIR: dir } });
}
// Run the container hook inside a real claudebot container with the launcher's Phase 2 mounts.
// (Prod copies the hook via entrypoint into ~/.claude/hooks; here we mount it straight to the
// final path — the entrypoint copy is a generic *.sh glob, not Phase-2-specific.)
function runInContainer(dir, stateArg, { withKey = true } = {}) {
  const args = ['run', '--rm', '--group-add', '0', ...ENGINE_ARGS,
    '-v', mnt(`${dir}:/home/claudebot/.claude/agent-view`),
    '-v', mnt(`${HELPER}:/home/claudebot/.claude/hooks/agent-view-register.sh:ro`),
    '-v', mnt(`${HOOK}:/home/claudebot/.claude/hooks/agent-view-state-hook.sh:ro`)];
  if (withKey) args.push('-e', `AGENT_VIEW_KEY=${KEY}`);
  args.push(IMAGE, 'bash', '/home/claudebot/.claude/hooks/agent-view-state-hook.sh', stateArg);
  execFileSync('docker', args, { stdio: 'ignore' });
}
const rowPath = (dir) => path.join(dir, `${KEY}.json`);
const readRow = (dir) => JSON.parse(fs.readFileSync(rowPath(dir), 'utf8'));

test('flips state in a real container and preserves launcher-owned fields', { skip }, () => {
  const dir = reg(); seed(dir, 'working');
  runInContainer(dir, 'needs-input');
  const r = readRow(dir);
  assert.strictEqual(r.state, 'needs-input', 'the container wrote through the RW bind mount');
  assert.strictEqual(r.run, `${KEY}-deadbe`, 'run preserved');
  assert.strictEqual(r.locator, LOCATOR, 'locator preserved');
  assert.strictEqual(r.kind, 'sandbox', 'kind preserved');
  assert.strictEqual(r.title, 'airflow · claude/foo (sandbox)', 'title preserved');
});

test('Stop event flips the row to completed', { skip }, () => {
  const dir = reg(); seed(dir, 'needs-input');
  runInContainer(dir, 'completed');
  assert.strictEqual(readRow(dir).state, 'completed');
});

test('no AGENT_VIEW_KEY -> no-op (exec/shell container can’t touch the row)', { skip }, () => {
  const dir = reg(); seed(dir, 'completed');
  runInContainer(dir, 'working', { withKey: false });
  assert.strictEqual(readRow(dir).state, 'completed', 'row untouched without the join key');
});

test('resurrection guard: the hook never recreates a launcher-deleted row', { skip }, () => {
  const dir = reg(); seed(dir, 'working');
  fs.rmSync(rowPath(dir));                       // the launcher's cleanup() removed it on exit
  runInContainer(dir, 'completed');
  assert.ok(!fs.existsSync(rowPath(dir)), 'a teardown hook event must not resurrect the row');
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
