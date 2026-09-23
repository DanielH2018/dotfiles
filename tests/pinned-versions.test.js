// Everything this repo resolves at build or apply time has to resolve to the same answer on two
// machines and on two dates. Before these pins, it did not: CI installed a bare `uv tool install
// prek` while a laptop installed another, actions rode mutable `@v4` tags, the runner was the
// rolling `ubuntu-latest`, and the sandbox image took `@anthropic-ai/claude-code@latest` as
// resolved on the host, once a day.
//
// The failure is silent in every case — a floating install produces a green run, just not a
// repeatable one — so each case below names the exact literal that has to be there.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { srcPath } = require('./lib/paths');

const repoRoot = path.resolve(__dirname, '..');
const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const tools = fs.readFileSync(srcPath('.chezmoidata', 'tools.toml'), 'utf8');
const sandbox = (f) => fs.readFileSync(srcPath('private_dot_claude', 'sandbox', f), 'utf8');

// tools.toml's [toolchain] table, parsed the way .github/workflows/ci.yml's awk step parses it.
function toolchain() {
  const table = (tools.split(/^\[toolchain\]$/m)[1] || '').split(/^\[/m)[0];
  return Object.fromEntries([...table.matchAll(/^([a-z_]+) = "([^"]+)"$/gm)].map((m) => [m[1], m[2]]));
}

// --- The CI workflow -------------------------------------------------------------------------

test('every action is pinned to a commit SHA, not a tag', () => {
  const uses = [...ci.matchAll(/^\s*- uses: (\S+)/gm)].map((m) => m[1]);
  // Non-vacuity: a regex census returns an empty list the moment the spelling moves, and an
  // `every` over nothing passes. Name the four actions this workflow must be running.
  const want = ['actions/checkout', 'actions/setup-node', 'actions/setup-python', 'astral-sh/setup-uv'];
  for (const action of want) {
    const line = uses.find((u) => u.startsWith(`${action}@`));
    assert.ok(line, `the workflow no longer uses ${action}`);
    assert.match(line, /@[0-9a-f]{40}$/, `${action} is pinned to a mutable tag, not a commit`);
  }
});

test('each pinned action records the tag its SHA came from', () => {
  // Without the comment the pin is unreadable and unbumpable: Renovate's github-actions manager
  // reads exactly this form, and a human cannot tell v4 from v7 by SHA.
  for (const m of ci.matchAll(/^\s*- uses: \S+@[0-9a-f]{40}(.*)$/gm)) {
    assert.match(m[1], /# v\d+\.\d+\.\d+/, `a SHA pin with no version comment: ${m[0].trim()}`);
  }
});

test('the runner is a release image, not the rolling alias', () => {
  assert.doesNotMatch(ci, /ubuntu-latest/,
    'ubuntu-latest moves to a new Ubuntu release with no commit here, taking the preinstalled shellcheck with it');
  assert.match(ci, /runs-on: ubuntu-\d\d\.\d\d/, 'the gate must name the runner image it was tested on');
});

test('the language versions are three-part', () => {
  const node = /node-version: '([^']+)'/.exec(ci);
  const python = /python-version: '([^']+)'/.exec(ci);
  assert.ok(node && python, 'the workflow must still set up node and python');
  for (const [name, m] of [['node', node], ['python', python]]) {
    assert.match(m[1], /^\d+\.\d+\.\d+$/,
      `${name}-version '${m[1]}' leaves the patch level to resolve at run time`);
  }
});

test('setup-uv is given a version', () => {
  // The SHA pin above fixes the ACTION. Without this input the action still installs whatever
  // uv Astral released most recently, which is the binary the whole suite then runs under.
  const block = /- uses: astral-sh\/setup-uv@[\s\S]*?\n\n/.exec(ci);
  assert.ok(block, 'the setup-uv step must still be present');
  assert.match(block[0], /version: '\d+\.\d+\.\d+'/, 'setup-uv installs a floating uv without a version input');
});

test('CI installs the toolchain versions tools.toml pins', () => {
  const pins = toolchain();
  for (const name of ['prek', 'oxlint', 'chezmoi', 'uv', 'ruff']) {
    assert.match(pins[name] || '', /^\d+\.\d+\.\d+$/, `tools.toml [toolchain] has no ${name} pin`);
  }
  // CI reads the values rather than repeating them, so what this asserts is that it reads them:
  // a literal version in the workflow is the drift that put CI and a laptop on different preks.
  assert.match(ci, /TOOLCHAIN_" toupper\(\$1\) "=/, 'CI must derive its pins from tools.toml');
  assert.match(ci, /uv tool install "prek==\$\{TOOLCHAIN_PREK\}"/);
  assert.match(ci, /npm install -g "oxlint@\$\{TOOLCHAIN_OXLINT\}"/);
  assert.doesNotMatch(ci, /get\.chezmoi\.io/,
    'the installer script installs whatever chezmoi is current on the day the run happens');
});

test('CI cancels a superseded run only where the range still covers everything', () => {
  // A push run checks `event.before..sha`. Cancelling push A when push B arrives leaves A's
  // commits in no run's range, so the signature check — the hole this workflow exists to close
  // — never sees them. A pull_request run checks base..head, where the newest run is a superset.
  assert.match(ci, /^concurrency:$/m, 'two runs must not share a runner HOME');
  assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
    'unconditional cancellation drops commits out of the signature check');
});

// --- The machine installers ------------------------------------------------------------------

test('no installer resolves a version at install time', () => {
  // The census walks the scripts rather than a hand-written list, so a new installer is covered
  // the day it lands. `found` is the non-vacuity guard: a rename that emptied the walk would
  // otherwise leave every assertion below passing over nothing.
  const roots = [srcPath('.chezmoiscripts'), srcPath('.chezmoitemplates')];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(sh|tmpl)$/.test(e.name) || !path.extname(e.name)) files.push(p);
    }
  };
  for (const r of roots) walk(r);
  assert.ok(files.length > 30, `sanity: the walk found only ${files.length} installer scripts`);

  const offenders = [];
  for (const f of files) {
    const body = fs.readFileSync(f, 'utf8');
    for (const [i, line] of body.split('\n').entries()) {
      if (line.trim().startsWith('#')) continue;
      // `uv tool install <bare name>` and `npm install -g <bare name>` both take the newest
      // release on the day they run.
      if (/uv tool install\s+["']?[a-z]/.test(line) && !/==/.test(line)) {
        offenders.push(`${path.relative(repoRoot, f)}:${i + 1} ${line.trim()}`);
      }
      if (/npm install -g/.test(line) && !/\\$/.test(line.trim()) && !/@/.test(line)) {
        offenders.push(`${path.relative(repoRoot, f)}:${i + 1} ${line.trim()}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'these install whatever version is current on the day they run');
});

test('the uv installer is fetched from its versioned URL', () => {
  const body = fs.readFileSync(
    srcPath('.chezmoiscripts', 'os-unix', 'run_onchange_after_install-python-tools.sh.tmpl'), 'utf8');
  assert.match(body, /astral\.sh\/uv\/\{\{ \.toolchain\.uv \}\}\/install\.sh/,
    'the bare astral.sh/uv/install.sh installs whatever Astral released most recently');
});

// --- The sandbox image -----------------------------------------------------------------------

test('the sandbox installs a pinned Claude Code, never @latest', () => {
  const launcher = sandbox('executable_claude-sandbox');
  const dockerfile = sandbox('Dockerfile.base');
  assert.doesNotMatch(launcher, /@latest/,
    'the launcher must not resolve or fall back to the newest release');
  assert.match(dockerfile, /^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m,
    'Dockerfile.base must carry the concrete version, as the one source the launcher reads');
});

test('the sandbox pins the toolchains its per-repo layers install', () => {
  const image = sandbox('executable_sandbox-image.sh');
  const dockerfile = sandbox('Dockerfile.base');
  assert.match(image, /^RUST_TOOLCHAIN="\d+\.\d+\.\d+"$/m,
    '`--default-toolchain stable` resolves at build time, so a rebuild moves the compiler');
  assert.doesNotMatch(image, /--default-toolchain stable/);
  assert.match(dockerfile, /^ARG NODE_PKG_VERSION=\d+\.\d+\.\d+-\S+$/m,
    'NodeSource installs whatever nodejs its repo carries that day without an exact package version');
  assert.doesNotMatch(dockerfile, /deb\.nodesource\.com\/setup_/,
    "the setup script is whatever NodeSource published on the build date");
});

test('the sandbox image and tools.toml agree on chezmoi and uv', () => {
  // Two places, deliberately: Dockerfile.base is deployed as-is, with no render step that could
  // read tools.toml. That makes drift the risk, and this is what catches it.
  const dockerfile = sandbox('Dockerfile.base');
  const pins = toolchain();
  assert.match(dockerfile, new RegExp(`^ARG CHEZMOI_VERSION=${pins.chezmoi}$`, 'm'),
    `the image must carry the chezmoi tools.toml pins (${pins.chezmoi})`);
  assert.match(dockerfile, new RegExp(`^ARG UV_VERSION=${pins.uv}$`, 'm'),
    `the image must carry the uv tools.toml pins (${pins.uv})`);
});
