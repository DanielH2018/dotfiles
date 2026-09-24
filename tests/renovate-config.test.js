// renovate.json's custom managers are hand-written regexes. When a pinned file is renamed or a
// pin's line changes shape, the manager matches nothing, and Renovate logs nothing about it.
// That pin then ages exactly as it did before the config existed. The config validator cannot
// catch this, because it checks the schema and not what the regexes find in the tree.
//
// These tests run each manager the way Renovate does (matchStrings with the `g` flag over every
// tracked file its managerFilePatterns selects). They assert that every `# renovate:` annotation
// in the tree is consumed by some manager. The homelab repo keeps the same guard in
// scripts/tests/test_renovate_managers.py.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { repoPath } = require('./lib/paths');

const config = JSON.parse(fs.readFileSync(repoPath('renovate.json'), 'utf8'));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoPath(), encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// Renovate writes a file pattern as `/regex/`.
function filePattern(p) {
  const m = /^\/(.*)\/$/.exec(p);
  assert.ok(m, `managerFilePatterns entry is not a /regex/: ${p}`);
  return new RegExp(m[1]);
}

// Every dependency one manager extracts from one file's text, with the offset its match starts at.
function extract(manager, text) {
  return manager.matchStrings.flatMap((s) =>
    [...text.matchAll(new RegExp(s, 'g'))].map((m) => ({ index: m.index, ...m.groups })));
}

// The annotations in a file that no manager consumed. An annotation counts as consumed when a
// match starts on it, since every matchString here opens on the `# renovate:` line.
const ANNOTATION = /^# renovate: datasource=\S+ depName=\S+$/gm;
function unconsumed(managers, file, text) {
  const starts = new Set(
    managers
      .filter((mgr) => mgr.managerFilePatterns.some((p) => filePattern(p).test(file)))
      .flatMap((mgr) => extract(mgr, text).map((d) => d.index)));
  return [...text.matchAll(ANNOTATION)]
    .filter((m) => !starts.has(m.index))
    .map((m) => `${file}: ${m[0]}`);
}

const managers = config.customManagers;
const read = (f) => fs.readFileSync(repoPath(f), 'utf8');

test('every custom manager finds at least one file and one pin', () => {
  assert.ok(managers.length >= 4, `expected the four annotated files' managers, found ${managers.length}`);
  for (const mgr of managers) {
    const files = tracked.filter((f) => mgr.managerFilePatterns.some((p) => filePattern(p).test(f)));
    assert.ok(files.length > 0, `no tracked file matches ${mgr.managerFilePatterns}`);
    const deps = files.flatMap((f) => extract(mgr, read(f)));
    assert.ok(deps.length > 0, `${mgr.managerFilePatterns} matches files but no pin in them`);
  }
});

test('every # renovate: annotation in the tree is consumed by a manager', () => {
  const annotated = tracked.filter((f) => {
    try {
      return /^# renovate: datasource=/m.test(read(f));
    } catch {
      return false; // a tracked symlink to a path outside the checkout
    }
  });
  // Non-vacuity: name the files the census must find, so a moved file fails by name.
  for (const f of ['home/.chezmoidata/tools.toml', 'home/.chezmoidata/packages.toml',
    'home/private_dot_claude/sandbox/Dockerfile.base',
    'home/private_dot_claude/sandbox/executable_sandbox-image.sh']) {
    assert.ok(annotated.includes(f), `the census no longer finds ${f}`);
  }
  const missed = annotated.flatMap((f) => unconsumed(managers, f, read(f)));
  assert.deepStrictEqual(missed, [], 'annotations no manager reads (the pin below each ages silently)');
});

test('the managers extract the pin value, not a neighbouring string', () => {
  // tools.toml's [releases] lines hold two quoted strings, `repo` then `tag`, and the manager
  // relies on the tag being the last one. Each named member is checked against its own line.
  const deps = managers.flatMap((mgr) => tracked
    .filter((f) => mgr.managerFilePatterns.some((p) => filePattern(p).test(f)))
    .flatMap((f) => extract(mgr, read(f))));
  const want = {
    'eza-community/eza': /^v\d+\.\d+\.\d+$/,
    prek: /^\d+\.\d+\.\d+$/,
    '@vtsls/language-server': /^\d+\.\d+\.\d+$/,
    'Genymobile/scrcpy': /^v\d/,
    '@anthropic-ai/claude-code': /^\d+\.\d+\.\d+$/,
    'rust-lang/rust': /^\d+\.\d+\.\d+$/,
  };
  for (const [name, shape] of Object.entries(want)) {
    const dep = deps.find((d) => d.depName === name);
    assert.ok(dep, `no manager extracts ${name}`);
    assert.match(dep.currentValue, shape, `${name} extracted as ${dep.currentValue}`);
  }
});

test('an annotation above a pin shape no manager knows is reported', () => {
  const tools = managers.find((m) => m.managerFilePatterns.some((p) => filePattern(p).test('home/.chezmoidata/tools.toml')));
  const file = 'home/.chezmoidata/tools.toml';
  const known = '# renovate: datasource=pypi depName=prek\nprek = "0.5.3"\n';
  // A version written unquoted is a shape the manager does not read.
  const unknown = '# renovate: datasource=pypi depName=prek\nprek = 0.5.3\n';
  assert.deepStrictEqual(unconsumed([tools], file, known), []);
  assert.deepStrictEqual(unconsumed([tools], file, unknown),
    [`${file}: # renovate: datasource=pypi depName=prek`]);
});

test('the pre-commit manager is switched on', () => {
  // Renovate ships it disabled, and listing it in enabledManagers alone does not enable it.
  assert.ok(config.enabledManagers.includes('pre-commit'));
  assert.strictEqual(config['pre-commit']?.enabled, true,
    'without this the gitleaks and ruff-pre-commit revs are never read');
});

// --- gitleaks lockstep with the homelab repo -------------------------------------------------
//
// .pre-commit-config.yaml pins gitleaks to the rev the homelab repo's prek.toml runs, so the two
// repos scan with the same rules. Each repo's Renovate bumps its own copy, on its own schedule.
//
// The oracle is the homelab checkout itself, read where one exists, and the test skips where
// none does (CI has no checkout of that repo). A committed copy of the homelab's rev would be an
// oracle this repo supplies about itself: Renovate bumps it along with the pin, and the test
// would then pass with the two repos apart.
const HOMELAB_CANDIDATES = [
  process.env.HOMELAB_REPO,
  path.join(os.homedir(), 'server'),
  path.join(os.homedir(), 'dev', 'server'),
].filter(Boolean);

// The rev on the line after `repo = ".../gitleaks/gitleaks"` in a prek.toml.
function prekGitleaksRev(text) {
  const m = /^repo = "https:\/\/github\.com\/gitleaks\/gitleaks"\nrev = "([^"]+)"$/m.exec(text);
  return m ? m[1] : null;
}

// The rev under `- repo: https://github.com/gitleaks/gitleaks` in a .pre-commit-config.yaml.
function preCommitGitleaksRev(text) {
  const m = /^\s*- repo: https:\/\/github\.com\/gitleaks\/gitleaks\n\s*rev: (\S+)$/m.exec(text);
  return m ? m[1] : null;
}

test('the rev parsers find a gitleaks pin and nothing else', () => {
  assert.strictEqual(prekGitleaksRev('[[repos]]\nrepo = "https://github.com/gitleaks/gitleaks"\nrev = "v8.30.1"\n'), 'v8.30.1');
  assert.strictEqual(prekGitleaksRev('[[repos]]\nrepo = "https://github.com/astral-sh/ruff-pre-commit"\nrev = "v0.16.0"\n'), null);
  assert.strictEqual(preCommitGitleaksRev('  - repo: https://github.com/astral-sh/ruff-pre-commit\n    rev: v0.16.0\n'), null);
  // This repo's own pin is always present, so this half runs in CI too.
  assert.match(preCommitGitleaksRev(read('.pre-commit-config.yaml')) || '', /^v\d+\.\d+\.\d+$/);
});

// Why the two files disagree, or null when they agree. A prek.toml the parser cannot read is a
// disagreement too, so a reshaped homelab file cannot pass by yielding nothing to compare.
function lockstepProblem(preCommitText, prekText) {
  const theirs = prekGitleaksRev(prekText);
  if (!theirs) return 'the homelab prek.toml no longer pins gitleaks in the shape this test reads';
  const ours = preCommitGitleaksRev(preCommitText);
  return ours === theirs ? null : `gitleaks is ${ours} here and ${theirs} in the homelab prek.toml`;
}

test('the lockstep check accepts equal revs and reports different ones', () => {
  const ours = '  - repo: https://github.com/gitleaks/gitleaks\n    rev: v8.30.1\n';
  const prek = (rev) => `repo = "https://github.com/gitleaks/gitleaks"\nrev = "${rev}"\n`;
  assert.strictEqual(lockstepProblem(ours, prek('v8.30.1')), null);
  assert.match(lockstepProblem(ours, prek('v8.31.0')), /v8\.30\.1 here and v8\.31\.0/);
  assert.match(lockstepProblem(ours, 'rev = "v8.30.1"\n'), /no longer pins gitleaks/);
});

const homelab = HOMELAB_CANDIDATES.find((d) => fs.existsSync(path.join(d, 'prek.toml')));
test('the gitleaks rev matches the homelab repo',
  { skip: homelab ? false : `no homelab checkout with a prek.toml at ${HOMELAB_CANDIDATES.join(', ')}` },
  () => {
    const problem = lockstepProblem(read('.pre-commit-config.yaml'),
      fs.readFileSync(path.join(homelab, 'prek.toml'), 'utf8'));
    assert.strictEqual(problem, null, `${problem} (${homelab}); bump the one that is behind`);
  });

// --- The sandbox base image ------------------------------------------------------------------
//
// A floating `FROM debian:stable-slim` gives two builds of one commit different bases, and no
// Renovate manager can bump a tag that names no version. The pin is the tag plus the index
// digest, which the dockerfile manager moves each time Debian republishes the tag.

const DIGEST_FROM = /^FROM [\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/;

test('the digest-pin shape rejects a floating or tagless FROM', () => {
  assert.match('FROM debian:stable-slim@sha256:' + 'a'.repeat(64), DIGEST_FROM);
  assert.doesNotMatch('FROM debian:stable-slim', DIGEST_FROM);
  assert.doesNotMatch('FROM debian@sha256:' + 'a'.repeat(64), DIGEST_FROM,
    'a digest with no tag leaves Renovate nothing to follow');
});

test('the sandbox base image is digest-pinned and Renovate reads it', () => {
  const file = 'home/private_dot_claude/sandbox/Dockerfile.base';
  const froms = read(file).split('\n').filter((l) => /^FROM /.test(l));
  assert.ok(froms.length > 0, `${file} has no FROM line`);
  for (const from of froms) assert.match(from, DIGEST_FROM);
  assert.ok(config.enabledManagers.includes('dockerfile'),
    'enabledManagers is a closed list, so without dockerfile the digest never moves');
  assert.ok(config.dockerfile.managerFilePatterns.some((p) => filePattern(p).test(file)));
});
