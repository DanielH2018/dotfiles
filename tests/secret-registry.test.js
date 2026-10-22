// Which paths count as secret is declared once, in claude-guard's
// claude_guard/secret_paths.json, and rendered into three dialects: the Bash deny rules
// (claude_guard.deny builds SECRET_PATHS from the table at import), the case arms in
// protect-secrets.sh, and the Read()/Edit() denies in settings.permissions.json. The last
// two are generated blocks; claude-guard's tests/test_secret_table.py fails when either has
// drifted from the table. This file checks what those blocks become once deployed: the
// RENDERED settings deny every glob the table names, and the hook denies the conformance
// corpus. `~/.claude/.credentials.json`, the live OAuth token on Linux and WSL, was missing
// from every dialect independently before the table existed (BDB-01, PS-01, A1-01, A1-18).
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');
const { renderFile, chezmoiAvailable } = require('./lib/render');

const TABLE = srcPath('dot_local', 'share', 'claude-guard', 'claude_guard', 'secret_paths.json');
const PS = srcPath('private_dot_claude', 'hooks', 'executable_protect-secrets.sh');
const BASE = srcPath('.chezmoitemplates', 'settings.base.json');

const { entries, cases } = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
const skipHook = skipUnless('bash', 'jq');
const skipRender = chezmoiAvailable ? false : 'chezmoi unavailable';

let renderedDeny = null;
function settingsDeny() {
  renderedDeny ??= new Set(JSON.parse(renderFile(BASE)).permissions.deny);
  return renderedDeny;
}

function hookDecision(file_path) {
  const payload = JSON.stringify({ tool_name: 'Read', tool_input: { file_path } });
  const out = execFileSync('bash', [PS], { input: payload, encoding: 'utf8' });
  return out.trim() === '' ? 'none' : JSON.parse(out).hookSpecificOutput?.permissionDecision ?? 'none';
}

test('the table parses, and every entry names itself, says why, and is refused somewhere', () => {
  assert.ok(entries.length >= 10, `expected entries, got ${entries.length}`);
  assert.strictEqual(new Set(entries.map((e) => e.id)).size, entries.length, 'ids are unique');
  for (const e of entries) {
    assert.ok(e.id && e.why, `${e.id} has an id and a why`);
    const dialects = [e.bash_re, e.case_arms ?? [], e.read_globs, e.edit_globs];
    assert.ok(dialects.some((d) => d.length > 0), `${e.id} is refused by no dialect`);
  }
});

test('the rendered settings deny every glob the table names, to its tool', { skip: skipRender }, () => {
  const deny = settingsDeny();
  const missing = entries.flatMap((e) => [
    ...e.read_globs.map((g) => `Read(${g})`),
    ...e.edit_globs.map((g) => `Edit(${g})`),
  ]).filter((rule) => !deny.has(rule));
  assert.deepStrictEqual(missing, [], 'table rules absent from the rendered settings');
});

test('the OAuth token store is refused by all three dialects', { skip: skipHook || skipRender }, () => {
  // The finding that motivated the table, asserted directly so a refactor that loosens the
  // generic checks above still cannot drop this one.
  const e = entries.find((x) => x.id === 'claude-oauth-credentials');
  assert.ok(e && e.bash_re.length > 0 && e.case_arms.length > 0, 'the table carries it');
  assert.ok(settingsDeny().has('Read(~/.claude/.credentials.json)'));
  assert.ok(settingsDeny().has('Edit(~/.claude/.credentials.json)'));
  assert.strictEqual(hookDecision('/home/u/.claude/.credentials.json'), 'deny');
});

test('protect-secrets denies every conformance case', { skip: skipHook }, () => {
  assert.ok(cases.length > 0, 'the conformance corpus is not empty');
  for (const c of cases) {
    assert.strictEqual(hookDecision(c.input), 'deny', `${c.input} (${c.entry}) must be denied`);
  }
});
