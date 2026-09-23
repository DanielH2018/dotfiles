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
const { renderTemplate, chezmoiAvailable } = require('./lib/render');

// Skip the render-based census where chezmoi is absent rather than failing on spawn ENOENT.
const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

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

test('the language and uv versions come from tools.toml, three-part', () => {
  // Two halves, and each is empty without the other. The workflow has to take the value from
  // the toolchain step rather than carry a literal, because a second copy is the drift this
  // whole arrangement exists to stop. And the value that step reads has to be three-part: a
  // two-part node or python request leaves the patch level to resolve at run time, so two runs
  // of one commit can use different interpreters. setup-uv is in the list for a third reason —
  // the action's SHA pin fixes the ACTION, and without a version input it still installs
  // whatever uv Astral released most recently, which is the binary the suite then runs under.
  const pins = toolchain();
  for (const [input, key] of [['node-version', 'node'], ['python-version', 'python'], ['version', 'uv']]) {
    const m = new RegExp(`^\\s*${input}: (.+)$`, 'm').exec(ci);
    assert.ok(m, `the workflow no longer sets ${input}`);
    assert.strictEqual(m[1].trim(), `\${{ env.TOOLCHAIN_${key.toUpperCase()} }}`,
      `${input} carries a literal instead of reading the tools.toml pin`);
    assert.match(pins[key] || '', /^\d+\.\d+\.\d+$/,
      `tools.toml's ${key} pin leaves the patch level to resolve at run time`);
  }
});

test("CI's managed python is the pinned version, not a two-part request", () => {
  // `uv python install 3.14` resolved a patch level on the day the run happened. An exact
  // install still answers the claude-guard shims' two-part request, because uv creates the
  // `cpython-3.14-*` alias beside `cpython-3.14.6-*`.
  assert.match(ci, /uv python install "\$\{TOOLCHAIN_PYTHON\}"/);
  assert.doesNotMatch(ci, /^\s*uv python install \d+\.\d+$/m);
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

test('a push run gets a concurrency group to itself', () => {
  // A push run checks `event.before..sha`. If push B is cancelled, its commits sit inside no
  // run's range — push C starts from B's head — and the signature check, the hole this
  // workflow exists to close, never sees them. `cancel-in-progress: false` is not enough: the
  // documented default is that a queued run cancels whatever is already PENDING in its group.
  // Only a group per commit keeps a push run uncancellable. A pull_request run checks
  // base..head, where the newest run is a superset, so grouping by ref is safe there.
  assert.match(ci, /^concurrency:$/m, 'a superseded PR run must not keep burning minutes');
  const group = /^\s*group: (.+)$/m.exec(ci);
  assert.ok(group, 'the concurrency block must set a group');
  assert.match(group[1], /github\.event_name == 'pull_request' && github\.ref \|\| github\.sha/,
    'a push run grouped by ref can be cancelled, which drops its commits out of the signature check');
});

// --- The machine installers ------------------------------------------------------------------

// The census runs over the RENDERED scripts, not the template sources — a `{{ .toolchain.ruff }}`
// splits into three words on whitespace, so a source-text census reads a pinned line as unpinned
// and an unpinned one the same way. The render is also what the machine executes.
//
// The walk finds the scripts rather than a hand-written list, so a new installer is covered the
// day it lands; `installLines` is the non-vacuity guard, because a walk that found nothing would
// leave the assertion passing over an empty list.
test('no installer resolves a package version at install time', { skip }, () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(sh|tmpl|ps1)$/.test(e.name) || !path.extname(e.name)) files.push(p);
    }
  };
  for (const r of [srcPath('.chezmoiscripts'), srcPath('.chezmoitemplates')]) walk(r);
  assert.ok(files.length > 30, `sanity: the walk found only ${files.length} scripts`);

  // A package argument is pinned when it carries `==` (uv) or `@<digit>` (npm). A `$name` or
  // `"$t"` argument is flagged even when the loop it came from pins every element: the version
  // has to be readable on the line that installs it, or a census like this one is blind to it —
  // which is how the first version of this test passed over `uv tool install "$t"`.
  const pinned = (arg) => /==\S/.test(arg) || /@\d/.test(arg);
  const offenders = [];
  let installLines = 0;

  for (const f of files) {
    let body = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.tmpl')) {
      // Pinned to the workstation profile: a server or WSL render drops whole scripts, and a
      // script that renders empty is one this census cannot see.
      try {
        body = renderTemplate(body, { source: srcPath(), profile: 'workstation' });
      } catch {
        continue; // a PowerShell template chezmoi will not render on this OS
      }
    }
    const lines = body.split('\n');
    for (const [i, raw] of lines.entries()) {
      const line = raw.trim();
      if (line.startsWith('#')) continue;
      const m = /(?:uv tool install|npm install -g)((?:\s+--\S+)*)\s+(.*)$/.exec(line);
      if (!m) continue;
      installLines += 1;
      // Everything after a `||`, `&&`, `;` or `|` belongs to another command, not to this one.
      const ownArgs = m[2].split(/\s*(?:\|\||&&|;|\|)\s*/)[0];
      // A trailing backslash puts the packages on the continuation lines instead.
      const args = /\\$/.test(line)
        ? lines.slice(i + 1).reduce((acc, l) => {
          if (acc.done) return acc;
          acc.list.push(l.trim().replace(/\s*\\$/, ''));
          if (!/\\$/.test(l.trim())) acc.done = true;
          return acc;
        }, { list: [], done: false }).list
        : ownArgs.split(/\s+/);
      for (const a of args) {
        const arg = a.replace(/^['"]|['"]$/g, '');
        if (!arg || arg.startsWith('-')) continue;
        if (!pinned(arg)) offenders.push(`${path.relative(repoRoot, f)}:${i + 1} ${arg}`);
      }
    }
  }
  assert.ok(installLines >= 3, `sanity: the census found only ${installLines} global install lines`);
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
