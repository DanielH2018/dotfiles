// settings.json is generated from a set of templates, and three separate gates have to
// know that set. None of them discovers it — each carries its own copy:
//
//   1. modify_settings.json.sh.tmpl refuses to generate from an uncommitted tree, so an
//      unreviewable edit cannot become live policy;
//   2. bin/config-soak requires review + `config-soak land` before a change ships;
//   3. tests/allow-compound-bash.test.js and tests/secret-registry.test.js parse the
//      permission rules out of the template text.
//
// Splitting the permission model out of settings.base.json turned that set from one file
// into three, and every one of those gates fails SILENTLY when it stops seeing a file:
// a dirty tree deploys, a change ships unreviewed, an assertion runs against text that no
// longer holds rules. The enumeration in gate 1 was already wrong before the split — it
// named settings.base.json only, and settings.safe-floor.json has been spliced into the
// output unguarded the whole time.
//
// So: the set is defined here, once, by what is on disk, and the gates are checked against
// it. Adding a fourth settings template fails this file until it is wired into both.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const TMPL_DIR = path.join(REPO, 'home', '.chezmoitemplates');
const GUARD = path.join(REPO, 'home', 'private_dot_claude', 'modify_settings.json.sh.tmpl');
const SOAK = path.join(REPO, 'bin', 'config-soak');

// Every settings template on disk, repo-relative. Not "every template referenced by an
// includeTemplate": a file that is present but referenced by nothing is the more dangerous
// case, since it looks live to a reader and is covered by nothing.
const templates = fs.readdirSync(TMPL_DIR)
  .filter((f) => /^settings\..+\.json$/.test(f))
  .sort();

test('the settings templates are found at all', () => {
  assert.ok(templates.includes('settings.base.json'),
    `expected settings.base.json in ${TMPL_DIR}, saw ${JSON.stringify(templates)}`);
  assert.ok(templates.length >= 2,
    'expected the base template plus at least the safe floor');
});

// The guard passes its paths to `git status --porcelain --`, where a quoted pathspec is a
// wildmatch. `*` there crosses `/` — verified: `git ls-files -- "home/*settings.base.json"`
// returns both .chezmoitemplates/settings.base.json and the sandbox's own copy. This uses
// `[^/]*`, which is deliberately STRICTER: it can only report a template as uncovered that
// git would in fact cover, never the reverse, so the failure mode is a false alarm a human
// reads rather than a gap that ships. A pathspec needing more than one `*` should be read
// by a human anyway, not matched here.
function pathspecMatches(spec, rel) {
  const re = new RegExp(`^${spec.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  return re.test(rel);
}

test('the dirty-tree guard covers every settings template', () => {
  const src = fs.readFileSync(GUARD, 'utf8');
  const block = src.slice(src.indexOf('status --porcelain --'), src.indexOf('if [ -n "$DIRTY" ]'));
  assert.ok(block.includes('status --porcelain'), 'located the guard pathspec block');
  const specs = [...block.matchAll(/"([^"$]+)"/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, `parsed no pathspecs out of the guard: ${block}`);

  // Pathspecs are relative to the source dir (`git -C "$SRC"`, SRC = .chezmoi.sourceDir),
  // which is the repo's home/ — so drop that prefix before comparing.
  const uncovered = templates.filter(
    (f) => !specs.some((s) => pathspecMatches(s, `.chezmoitemplates/${f}`)));
  assert.deepStrictEqual(uncovered, [],
    'these templates are spliced into settings.json but are not in the guard\'s pathspec, '
    + 'so an uncommitted edit to one silently becomes live policy. Keep the pathspec a '
    + `wildcard (.chezmoitemplates/settings.*.json) rather than a list. Guard has: ${specs}`);
});

test('config-soak tracks every settings template', () => {
  const src = fs.readFileSync(SOAK, 'utf8');
  const start = src.indexOf('const TRACKED = [');
  assert.ok(start > -1, 'located the TRACKED list');
  const block = src.slice(start, src.indexOf('];', start));
  const uncovered = templates.filter(
    (f) => !block.includes(`home/.chezmoitemplates/${f}`));
  assert.deepStrictEqual(uncovered, [],
    'these templates decide the generated settings.json but are outside the config-soak '
    + 'review surface, so a change to one ships without ever being acknowledged. Add a '
    + "{ type: 'file', path: ... } entry for each.");
});

// The permission rules moved out of settings.base.json, and the two tests that parse them
// read a path constant. A constant still pointing at the base template would not error — it
// would parse a file with no allow array in it. Both tests anchor on finding the array
// first, so they fail loudly rather than passing vacuously; this states the requirement
// directly so the reason those anchors matter is not left implicit.
test('the rule-parsing tests read the template that actually holds the rules', () => {
  const holds = (f) => {
    const body = fs.readFileSync(path.join(TMPL_DIR, f), 'utf8');
    return body.includes('"allow": [') && body.includes('"deny": [');
  };
  // The safe floor carries its own minimal allow/deny pair by design — it is the bootstrap
  // fallback, not the enforced model — so this is not "exactly one holder".
  assert.ok(holds('settings.permissions.json'),
    'settings.permissions.json no longer carries the allow and deny arrays');
  assert.ok(!holds('settings.base.json'),
    'settings.base.json carries permission rules inline again. It is meant to splice them '
    + 'in by includeTemplate; rules in two places means the tests below check only one set.');

  // Named by path rather than searched for: if one of them moves, this should fail and be
  // repointed, not quietly find nothing to check.
  for (const t of ['hooks/allow-compound-bash.test.js', 'secret-registry.test.js']) {
    const abs = path.join(__dirname, t);
    assert.ok(fs.existsSync(abs), `${t} has moved — repoint this test at it`);
    assert.match(fs.readFileSync(abs, 'utf8'), /settings\.permissions\.json/,
      `${t} parses permission rules but does not name settings.permissions.json, `
      + 'so it is reading a template the rules no longer live in');
  }
});
