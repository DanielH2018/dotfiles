// Which paths count as secret is declared once, in .chezmoidata/secrets.toml, and
// re-expressed in four dialects that share no source: a regex in claude_guard.deny
// (block-dangerous-bash.sh's SECRET_PATHS, ported there; that hook is unregistered on
// the host as of the claude-guard slice 4 cutover, so deny.py is the host's live
// decision-maker), `case` arms in protect-secrets.sh, Read/Edit globs in the settings
// template, and (later) dotsync's ignore list. `~/.claude/.credentials.json` — the live
// OAuth token on Linux and WSL — was missing from every one of them independently
// (BDB-01, PS-01, A1-01, A1-18).
//
// Until the dialects are generated from the registry, this is what holds them together:
// an entry that is not carried by every dialect it declares fails the suite.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { skipUnless } = require('./lib/probe');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(ROOT, 'home', '.chezmoidata', 'secrets.toml');
const DENY_PY = path.join(
  ROOT, 'home', 'dot_local', 'share', 'claude-guard', 'claude_guard', 'deny.py',
);
const PS = path.join(ROOT, 'home', 'private_dot_claude', 'hooks', 'executable_protect-secrets.sh');
// The deny rules moved out of settings.base.json when the permission model was split into
// its own template; base now only splices it in. The assertion below requires each rule to
// be PRESENT, so a stale path here fails loudly rather than finding nothing to complain about.
const SETTINGS = path.join(ROOT, 'home', '.chezmoitemplates', 'settings.permissions.json');

// Minimal reader for the shape this file uses: [[secretPaths.entries]] tables of
// scalars and string arrays. Avoids adding a TOML dependency for one fixture.
function parseEntries(src, table) {
  const out = [];
  let cur = null;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    if (line === `[[${table}]]`) { cur = {}; out.push(cur); continue; }
    if (line.startsWith('[')) { cur = null; continue; }
    if (!cur) continue;
    const m = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!m) continue;
    const [, key, rhs] = m;
    cur[key] = rhs.startsWith('[')
      ? [...rhs.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2])
      : (rhs.match(/^"([^"]*)"$|^'([^']*)'$/) || [rhs, rhs])[1] ?? rhs.replace(/^'|'$/g, '');
  }
  return out;
}

const registry = fs.readFileSync(REGISTRY, 'utf8');
const entries = parseEntries(registry, 'secretPaths.entries');
const cases = parseEntries(registry, 'secretPaths.cases');
const denyPy = fs.readFileSync(DENY_PY, 'utf8');
const ps = fs.readFileSync(PS, 'utf8');
const settings = fs.readFileSync(SETTINGS, 'utf8');
// deny.py spells SECRET_PATHS as a parenthesised Python string concatenation
// (r"..." per line), not a single shell-quoted line -- join it back into one
// string, the same shape secretPathsLine[1] used to be when it came from bash.
const denySecretPathsBlock = denyPy.match(/^SECRET_PATHS = \(\n([\s\S]*?)^\)$/m);
const secretPathsLine = denySecretPathsBlock
  ? [null, [...denySecretPathsBlock[1].matchAll(/r"([^"]*)"/g)].map((m) => m[1]).join('')]
  : null;

const skip = skipUnless('bash', 'jq');

test('the registry parses and is not empty', () => {
  assert.ok(entries.length >= 5, `expected entries, got ${entries.length}`);
  for (const e of entries) {
    assert.ok(e.id, 'every entry has an id');
    assert.ok(e.why, `${e.id} explains why it is secret`);
  }
});

test('every entry appears in claude_guard.deny SECRET_PATHS', () => {
  assert.ok(secretPathsLine, 'located SECRET_PATHS');
  const missing = entries.filter((e) => e.bash_re && !secretPathsLine[1].includes(e.bash_re));
  assert.deepStrictEqual(missing.map((e) => e.id), [], 'entries absent from the deny guard');
});

test('every entry appears in protect-secrets case arms', () => {
  const missing = [];
  for (const e of entries) {
    for (const arm of e.case_arms || []) {
      if (!ps.includes(arm)) missing.push(`${e.id}:${arm}`);
    }
  }
  assert.deepStrictEqual(missing, [], 'case arms absent from protect-secrets.sh');
});

test('every entry is denied to both Read and Edit in the settings template', () => {
  const missing = [];
  for (const e of entries) {
    for (const glob of e.tool_globs || []) {
      for (const tool of ['Read', 'Edit']) {
        if (!settings.includes(`"${tool}(${glob})"`)) missing.push(`${e.id}:${tool}(${glob})`);
      }
    }
  }
  assert.deepStrictEqual(missing, [], 'deny rules absent from settings.permissions.json');
});

test('the OAuth token store is covered by all four dialects', () => {
  // The finding that motivated the registry, asserted directly so a refactor that
  // loosens the generic checks above still cannot drop this one.
  assert.match(secretPathsLine[1], /\\\.claude\/\\\.credentials\\\.json/);
  assert.match(ps, /\.credentials\.json\)/);
  assert.ok(settings.includes('"Read(~/.claude/.credentials.json)"'));
  assert.ok(settings.includes('"Edit(~/.claude/.credentials.json)"'));
});

test('protect-secrets denies every conformance case', { skip }, () => {
  for (const c of cases) {
    const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: c.input } });
    const out = execFileSync('bash', [PS], { input: payload, encoding: 'utf8' });
    const decision = out.trim() === '' ? 'none'
      : JSON.parse(out).hookSpecificOutput?.permissionDecision ?? 'none';
    assert.strictEqual(decision, 'deny', `${c.input} (${c.entry}) must be denied, got ${decision}`);
  }
});
