// Regression guard for the rootless-podman compatibility layer in
// executable_claude-sandbox. Under podman-docker (the `docker` shim that execs
// rootless podman) a bind mount is denied unless the spec carries an SELinux
// relabel flag AND the run carries --userns=keep-id — each alone still fails.
// When that layer regresses the failure is silent rather than loud: the
// container simply cannot write ~/.claude, so `claude auth login` persists
// nothing while the host-side auth marker is still touched, and every later run
// starts unauthenticated.
// Same technique as claude-sandbox-launcher.test.js: extract the REAL function
// bodies (awk brace-depth counter) and drive them in a bash harness.
// Offline. Skips cleanly if bash is unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX_DIR = path.join(__dirname, '..', '..', 'home', 'private_dot_claude', 'sandbox');
const SANDBOX = path.join(SANDBOX_DIR, 'executable_claude-sandbox');
// The launcher plus the libs it sources. Both checks below count across the whole
// launch path, and parts of it have moved out: the create-filter run that carries
// ENGINE_ARGS is in sandbox-proxy.sh, and the inline -v mounts that must go through
// add_mount_relabel are split between the proxy and mount libs.
const SRC = [SANDBOX, ...fs.readdirSync(SANDBOX_DIR)
  .filter((f) => /^executable_sandbox-.*\.sh$/.test(f))
  .sort()
  .map((f) => path.join(SANDBOX_DIR, f))]
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

let toolsOk = true;
try { execFileSync('bash', ['-c', 'command -v awk'], { stdio: 'ignore' }); } catch { toolsOk = false; }
const skip = toolsOk ? false : 'bash/awk unavailable';

function extractFunction(name) {
  const src = execFileSync('awk', [
    `/^${name}\\(\\) \\{/ { started=1 }\n` +
    'started {\n' +
    '  print\n' +
    '  depth += gsub(/{/,"{") - gsub(/}/,"}")\n' +
    '  if (started && depth==0) exit\n' +
    '}',
    SANDBOX,
  ], { encoding: 'utf8' });
  assert.ok(new RegExp(`^${name}\\(\\) \\{`).test(src), `extracted the ${name} definition`);
  return src;
}

const ADD_MOUNT_RELABEL_SRC = skip ? '' : extractFunction('add_mount_relabel');
const RELABEL_DOCKER_ARGS_SRC = skip ? '' : extractFunction('relabel_docker_args');
const DETECT_ENGINE_SRC = skip ? '' : extractFunction('detect_container_engine');

function run(script, env = {}) {
  try {
    const out = execFileSync('bash', ['-c', script], {
      env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function relabel(spec, flag) {
  const r = run(`set -u\n${ADD_MOUNT_RELABEL_SRC}\nSANDBOX_MOUNT_RELABEL=${flag === undefined ? '""' : `'${flag}'`}\nadd_mount_relabel '${spec}'`);
  assert.strictEqual(r.code, 0, `add_mount_relabel failed: ${r.stderr}`);
  return r.stdout.trimEnd();
}

// --- add_mount_relabel(): the per-spec SELinux flag ---

test('with no relabel configured every spec passes through untouched (real Docker path)', { skip }, () => {
  assert.strictEqual(relabel('/src:/dst'), '/src:/dst');
  assert.strictEqual(relabel('/src:/dst:ro'), '/src:/dst:ro');
});

test('a two-field spec gains the flag as a new option field', { skip }, () => {
  assert.strictEqual(relabel('/src:/dst', 'z'), '/src:/dst:z');
});

test('a spec that already has options gains the flag as another comma option, keeping :ro', { skip }, () => {
  assert.strictEqual(relabel('/src:/dst:ro', 'z'), '/src:/dst:ro,z');
});

test('relabelling is idempotent — an existing z/Z flag is left alone', { skip }, () => {
  assert.strictEqual(relabel('/src:/dst:z', 'z'), '/src:/dst:z');
  assert.strictEqual(relabel('/src:/dst:ro,z', 'z'), '/src:/dst:ro,z');
  assert.strictEqual(relabel('/src:/dst:ro,Z', 'z'), '/src:/dst:ro,Z');
});

test('a path containing spaces (the macOS 1Password socket) survives the transform', { skip }, () => {
  assert.strictEqual(
    relabel('/Users/d/Library/Group Containers/x/agent.sock:/run/1password/agent.sock', 'z'),
    '/Users/d/Library/Group Containers/x/agent.sock:/run/1password/agent.sock:z',
  );
});

// --- relabel_docker_args(): the whole-array rewrite ---

function relabelArgs(args, flag, passes = 1) {
  const literal = args.map((a) => `'${a}'`).join(' ');
  const r = run(`set -u\n${ADD_MOUNT_RELABEL_SRC}\n${RELABEL_DOCKER_ARGS_SRC}\n` +
    `SANDBOX_MOUNT_RELABEL=${flag === undefined ? '""' : `'${flag}'`}\n` +
    `DOCKER_ARGS=(${literal})\n` +
    `${'relabel_docker_args\n'.repeat(passes)}` +
    `printf '%s\\n' "\${DOCKER_ARGS[@]}"`);
  assert.strictEqual(r.code, 0, `relabel_docker_args failed: ${r.stderr}`);
  return r.stdout.trimEnd().split('\n');
}

test('every -v value in the array is rewritten and nothing else is', { skip }, () => {
  assert.deepStrictEqual(
    relabelArgs(['--rm', '-it', '-v', '/w:/workspace', '-e', 'K=v:x', '-v', '/s:/d:ro', '--name', 'c'], 'z'),
    ['--rm', '-it', '-v', '/w:/workspace:z', '-e', 'K=v:x', '-v', '/s:/d:ro,z', '--name', 'c'],
  );
});

test('a second pass over the same array changes nothing (mounts appended late are safe)', { skip }, () => {
  assert.deepStrictEqual(
    relabelArgs(['-v', '/w:/workspace', '-v', '/s:/d:ro'], 'z', 2),
    ['-v', '/w:/workspace:z', '-v', '/s:/d:ro,z'],
  );
});

test('with no relabel configured the array is returned verbatim', { skip }, () => {
  assert.deepStrictEqual(
    relabelArgs(['-v', '/w:/workspace', '-e', 'K=v'], undefined),
    ['-v', '/w:/workspace', '-e', 'K=v'],
  );
});

test('a trailing -v with no value does not run off the end of the array', { skip }, () => {
  assert.deepStrictEqual(relabelArgs(['--rm', '-v'], 'z'), ['--rm', '-v']);
});

// --- detect_container_engine(): which engine is behind `docker` ---

const dirs = [];
function fakeDocker(body) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-engine-'));
  dirs.push(d);
  if (body !== null) {
    fs.writeFileSync(path.join(d, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return d;
}

// The host's own /usr/bin/docker may itself be the podman shim, so the isolated
// case has to drop the system dirs entirely rather than just prepend to them.
// PATH is set inside the script, not via env: node needs a working PATH of its
// own to spawn bash in the first place.
function detectEngine(binDir, { isolated = false } = {}) {
  const p = isolated ? binDir : `${binDir}:/usr/bin:/bin`;
  const r = run(`set -u\nPATH='${p}'\n${DETECT_ENGINE_SRC}\ndetect_container_engine`);
  assert.strictEqual(r.code, 0, `detect_container_engine failed: ${r.stderr}`);
  return r.stdout.trim();
}

test('the podman-docker shim is detected as podman', { skip }, () => {
  assert.strictEqual(detectEngine(fakeDocker(`echo 'podman version 5.8.4'`)), 'podman');
});

test('real Docker is detected as docker', { skip }, () => {
  assert.strictEqual(detectEngine(fakeDocker(`echo 'Docker version 27.3.1, build ce1223035a'`)), 'docker');
});

test('no docker on PATH falls back to docker rather than erroring', { skip }, () => {
  assert.strictEqual(detectEngine(fakeDocker(null), { isolated: true }), 'docker');
});

test('a docker that fails to run falls back to docker', { skip }, () => {
  assert.strictEqual(detectEngine(fakeDocker('exit 1')), 'docker');
});

// --- Wiring guards: the helpers above are worthless if the launcher skips them ---

test('every `docker run` on DOCKER_ARGS is preceded by relabel_docker_args', { skip }, () => {
  const lines = SRC.split('\n');
  const runLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /docker run "\$\{DOCKER_ARGS\[@\]\}"/.test(l));
  assert.ok(runLines.length >= 2, 'found the DOCKER_ARGS run sites');
  for (const { l, i } of runLines) {
    const before = lines.slice(Math.max(0, i - 3), i).join('\n');
    assert.match(before, /relabel_docker_args/, `unrelabelled run at line ${i + 1}: ${l.trim()}`);
  }
});

test('inline `docker run` invocations relabel each of their own -v specs', { skip }, () => {
  const lines = SRC.split('\n');
  // The socket proxy is deliberately exempt: it bind-mounts the host Docker
  // socket, which must not be relabelled, and that whole docker-in-docker path
  // has no rootless-podman equivalent anyway.
  const EXEMPT = /\/var\/run\/docker\.sock/;
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bdocker run\b/.test(lines[i]) || /DOCKER_ARGS/.test(lines[i])) continue;
    for (let j = i; j < lines.length && /\\$/.test(lines[j]); j++) {
      const next = lines[j + 1] ?? '';
      if (/^\s*-v /.test(next) && !/add_mount_relabel/.test(next) && !EXEMPT.test(next)) {
        offenders.push(`line ${j + 2}: ${next.trim()}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], `inline mounts missing add_mount_relabel:\n${offenders.join('\n')}`);
});

test('every container-launching run carries the engine args (userns keep-id under podman)', { skip }, () => {
  const occurrences = SRC.match(/\$\{ENGINE_ARGS\[@\]\+"\$\{ENGINE_ARGS\[@\]\}"\}/g) || [];
  // main DOCKER_ARGS, the OAuth-login run, and the docker create-filter helper
  assert.strictEqual(occurrences.length, 3);
});

test('keep-id maps the container-side claudebot uid, not the host uid', { skip }, () => {
  assert.match(SRC, /--userns="keep-id:uid=\$CLAUDEBOT_UID,gid=\$CLAUDEBOT_GID"/);
  assert.match(SRC, /^CLAUDEBOT_UID=1000/m);
  const dockerfile = fs.readFileSync(path.join(path.dirname(SANDBOX), 'Dockerfile.base'), 'utf8');
  assert.match(dockerfile, /useradd .*--uid 1000 claudebot/);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
