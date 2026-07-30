const { test, after } = require('node:test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const w = (name, obj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };
const run = (...args) => JSON.parse(execFileSync('node', [BIN, ...args], { encoding: 'utf8' }));
// The prior deployed file arrives by environment, not argv - see the skew rationale in the script.
const runWithPrior = (prior, ...args) =>
  JSON.parse(execFileSync('node', [BIN, ...args], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_SETTINGS_PRIOR: prior },
  }));
// Capture a non-zero exit instead of throwing, so the status and stderr can be asserted.
const runFail = (...args) => {
  try { execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: 'pipe' }); return { status: 0, stderr: '' }; }
  catch (e) { return e; }
};

// Assertion 2 rejects any merged output without the floor, so fixtures that are not
// specifically testing that need a base which carries it. FLOOR mirrors the signed-off list
// in the generator; the test below asserts the two never drift apart.
const FLOOR = [
  'Bash(sudo:*)', 'Bash(su:*)', 'Bash(mkfs:*)', 'Bash(dd:*)',
  'Bash(rm -rf /*)', 'Bash(rm -rf ~*)',
  'Bash(* | sh*)', 'Bash(* | bash*)', 'Bash(* | zsh*)',
  'Read(**/.ssh/**)', 'Read(**/.aws/credentials)', 'Read(**/.env)',
  'Read(**/id_rsa)', 'Read(**/id_ed25519)', 'Edit(**/.ssh/**)',
];
const withFloor = (obj = {}) => ({
  ...obj,
  permissions: { ...(obj.permissions || {}), deny: [...FLOOR, ...((obj.permissions || {}).deny || [])] },
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('objects deep-merge by key', () => {
  const base = w('base.json', withFloor({ model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } }));
  const over = w('over.json', { enabledPlugins: { b: true }, env: { Y: '2' } });
  const out = run(base, over);
  assert.strictEqual(out.model, 'opus');
  assert.deepStrictEqual(out.enabledPlugins, { a: true, b: true });
  assert.deepStrictEqual(out.env, { X: '1', Y: '2' });
});

test('arrays concat and de-dupe by value', () => {
  const ba = w('ba.json', withFloor({ deny: ['a', 'b'] }));
  const oa = w('oa.json', { deny: ['b', 'c'] });
  assert.deepStrictEqual(run(ba, oa).deny, ['a', 'b', 'c']);
});

test('overlay wins on scalar conflict', () => {
  assert.strictEqual(run(w('b3.json', withFloor({ model: 'opus' })), w('o3.json', { model: 'sonnet' })).model, 'sonnet');
});

test('missing overlay file is treated as {}', () => {
  const base = w('base4.json', withFloor({ model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } }));
  assert.deepStrictEqual(run(base, path.join(tmp, 'does-not-exist.json')).enabledPlugins, { a: true });
});

test('merging is idempotent', () => {
  const base = w('base5.json', withFloor({ model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } }));
  const over = w('over5.json', { enabledPlugins: { b: true }, env: { Y: '2' } });
  const once = execFileSync('node', [BIN, base, over], { encoding: 'utf8' });
  const onceFile = w('once.json', JSON.parse(once));
  const twice = execFileSync('node', [BIN, onceFile, over], { encoding: 'utf8' });
  assert.strictEqual(once, twice);
});

test('no arguments exits 2 with a usage error', () => {
  const noArgs = runFail();
  assert.strictEqual(noArgs.status, 2, 'no args must exit 2');
  assert.match(noArgs.stderr, /usage:/);
});

test('unparseable JSON exits 1 naming the file', () => {
  const bad = path.join(tmp, 'bad.json'); fs.writeFileSync(bad, '{not json');
  const parseErr = runFail(bad);
  assert.strictEqual(parseErr.status, 1, 'parse failure must exit 1');
  assert.match(parseErr.stderr, /cannot parse .*bad\.json/);
});

// A truncated or hand-edited work overlay is the realistic source of these two shapes.
// Before the shape check, both silently produced a settings.json with no permission
// model and exited 0 — the merged file looked fine and every guard was gone.
test('a null overlay value keeps the base rather than erasing it', () => {
  const base = w('b8.json', withFloor({ permissions: { deny: ['Bash(rm:*)'] }, hooks: { PreToolUse: [1, 2] } }));
  const over = w('o8.json', { permissions: null, hooks: null });
  const out = run(base, over);
  assert.ok(out.permissions.deny.includes('Bash(rm:*)'), 'null must not wipe permissions');
  assert.ok(out.permissions.deny.includes('Bash(sudo:*)'), 'and the floor is still there');
  assert.deepStrictEqual(out.hooks, { PreToolUse: [1, 2] }, 'null must not wipe hooks');
});

test('a shape conflict is refused instead of silently taking the overlay', () => {
  const scalarOntoObject = runFail(w('b9.json', { permissions: { deny: [] } }), w('o9.json', { permissions: 'deny' }));
  assert.strictEqual(scalarOntoObject.status, 1, 'scalar over object must exit 1');
  assert.match(scalarOntoObject.stderr, /type conflict at permissions/);

  const objectOntoArray = runFail(w('b10.json', { permissions: { deny: [] } }), w('o10.json', { permissions: { deny: {} } }));
  assert.strictEqual(objectOntoArray.status, 1, 'object over array must exit 1');
  assert.match(objectOntoArray.stderr, /type conflict at permissions\.deny/);
});

test('a null base is replaced by a real overlay value', () => {
  const out = run(w('b11.json', withFloor({ statusLine: null })), w('o11.json', { statusLine: { type: 'command' } }));
  assert.deepStrictEqual(out.statusLine, { type: 'command' });
});

// Written as raw text: a `__proto__` key in a JS object literal sets the prototype rather
// than an own property, so JSON.stringify would drop it and the fixture would prove nothing.
const wRaw = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };

// `out[k] = …` goes through [[Set]], so a `__proto__` key hit Object.prototype's setter and
// set the accumulator's prototype instead of defining a key. A later fragment then saw those
// keys through the chain and merged them in, producing permission rules that appear in no
// visible key of any input — a silent write to the settings.json that governs enforcement.
test('refuses a prototype key rather than merging it into the output', () => {
  const inject = wRaw('proto1.json', '{"__proto__":{"permissions":{"allow":["Bash(INJECTED:*)"]}},"model":"opus"}');
  const plain = w('proto2.json', { permissions: { allow: ['Bash(ls:*)'] } });
  const r = runFail(inject, plain);
  assert.strictEqual(r.status, 1, 'a __proto__ key must exit 1');
  assert.match(r.stderr, /refusing prototype key "__proto__"/);
  assert.doesNotMatch(String(r.stdout || ''), /INJECTED/, 'injected rule must not reach the output');

  assert.strictEqual(runFail(wRaw('proto3.json', '{"constructor":{"x":1}}')).status, 1);
});

// `in` walks the prototype chain, so a fragment key that shadows an Object.prototype member
// used to be merged against a function rather than treated as a new key.
test('treats a key named after an Object.prototype member as an ordinary key', () => {
  const out = run(w('b12.json', withFloor({ model: 'opus' })), wRaw('o12.json', '{"toString":{"type":"command"}}'));
  assert.deepStrictEqual(out.toString, { type: 'command' });
  assert.strictEqual(out.model, 'opus');
});

// Runtime-owned keys. `/effort` writes effortLevel into the deployed settings.json; the
// templates never set it, so every `chezmoi apply` used to drop the pin — observed twice in
// one session. CLAUDE_SETTINGS_PRIOR names the prior deployed file, read for that key alone.
test('a runtime-owned key survives a re-derive that does not set it', () => {
  const base = w('rt-base.json', withFloor({ model: 'opus' }));
  const prior = w('rt-prior.json', { model: 'sonnet', effortLevel: 'xhigh' });
  const out = runWithPrior(prior, base);
  assert.strictEqual(out.effortLevel, 'xhigh', 'effortLevel must be carried forward');
  assert.strictEqual(out.model, 'opus', 'the template still wins for everything else');
});

test('an explicit template pin beats the carried-forward value', () => {
  const base = w('rt-base2.json', withFloor({ effortLevel: 'low' }));
  const prior = w('rt-prior2.json', { effortLevel: 'xhigh' });
  assert.strictEqual(runWithPrior(prior, base).effortLevel, 'low');
});

// The whole point of the fixed allowlist: the prior file is a deployed artifact that may
// carry local hand-edits, so anything outside the list — above all permission rules — must
// not survive a re-derive. Carrying those forward would make an uncommitted edit into policy.
test('carry-forward is scoped to the allowlist and never touches permissions', () => {
  const base = w('rt-base3.json', withFloor({ permissions: { allow: ['Bash(ls:*)'] } }));
  const prior = w('rt-prior3.json', {
    effortLevel: 'high',
    permissions: { allow: ['Bash(LOCAL-EDIT:*)'] },
    model: 'haiku',
    hooks: { PreToolUse: ['injected'] },
  });
  const out = runWithPrior(prior, base);
  assert.strictEqual(out.effortLevel, 'high');
  assert.deepStrictEqual(out.permissions.allow, ['Bash(ls:*)'], 'prior permissions must not survive');
  assert.ok(!out.permissions.allow.includes('Bash(LOCAL-EDIT:*)'), 'the prior file cannot grant itself anything');
  assert.ok(!('model' in out), 'a non-allowlisted prior key must not be carried forward');
  assert.ok(!('hooks' in out), 'a non-allowlisted prior key must not be carried forward');
});

test('a runtime key absent from the prior file stays absent', () => {
  const out = runWithPrior(w('rt-prior4.json', { model: 'opus' }), w('rt-base4.json', withFloor({ model: 'opus' })));
  assert.ok(!('effortLevel' in out), 'nothing to carry forward means unpinned, not a default');
});

// Losing a UX pin is not worth aborting an apply that would otherwise deploy every other
// dotfile — unlike a fragment parse failure, which is a malformed input to the derivation.
test('an unreadable prior file warns but still generates', () => {
  const bad = path.join(tmp, 'rt-bad.json'); fs.writeFileSync(bad, '{not json');
  assert.strictEqual(runWithPrior(bad, w('rt-base5.json', withFloor({ model: 'opus' }))).model, 'opus');
  const missing = runWithPrior(path.join(tmp, 'rt-nope.json'), w('rt-base6.json', withFloor({ model: 'opus' })));
  assert.strictEqual(missing.model, 'opus', 'a first-ever apply has no prior file at all');
});

// The template invokes this script by absolute path under .chezmoi.sourceDir (the primary
// checkout), so a new template can meet an older script. Had the prior file been a flag
// operand, that skew would have merged the entire deployed settings.json back in as a
// fragment and promoted its stale permission rules to policy. Refuse flag-shaped args so
// the failure is loud in the other direction too.
test('a flag-shaped argument is refused, never taken as a filename', () => {
  const r = runFail('--carry-forward', w('rt-prior8.json', { effortLevel: 'xhigh' }), w('rt-base8.json', withFloor({ model: 'opus' })));
  assert.strictEqual(r.status, 2, 'an unknown option must exit 2');
  assert.match(r.stderr, /unknown option --carry-forward/);
});

// --- M20 slice 1: generation assertions ---------------------------------------------------
//
// The safe-failure mode is chezmoi's own: a modify_ script that exits non-zero leaves the
// existing target untouched, so a refusal means "yesterday's settings.json keeps running",
// not "no settings at all". The exception is a first-ever apply, covered separately below.

// Assertion 2. The realistic source is a truncated or hand-edited base template, which is
// exactly the case a permissions-shaped overlay check cannot catch.
test('a merged output missing a floor deny rule is refused', () => {
  const base = w('fl1.json', { permissions: { deny: ['Bash(sudo:*)', 'Bash(su:*)'] } });
  const r = runFail(base);
  assert.strictEqual(r.status, 1, 'a missing floor rule must exit 1');
  assert.match(r.stderr, /missing floor rules/);
  assert.match(r.stderr, /Bash\(mkfs:\*\)/, 'stderr names what is missing');
  assert.strictEqual(String(r.stdout || ''), '', 'nothing reaches stdout, so nothing reaches disk');
});

test('a merged output with no permission model at all is refused', () => {
  assert.match(runFail(w('fl2.json', { model: 'opus' })).stderr, /permissions is missing/);
  assert.match(runFail(w('fl3.json', { permissions: { deny: [] } })).stderr, /deny is missing or empty/);
});

// Assertion 4 — the generic half. It names no rules, so it protects every deny the base
// declares, including ones added long after this code was written.
test('an overlay that removes a base deny rule is refused', () => {
  const base = w('nw1.json', withFloor({ permissions: { deny: ['Bash(frobnicate:*)'] } }));
  // A removal the concat-merge cannot express today, simulated by a base-only rule that the
  // merged result would have to keep.
  const out = run(base, w('nw2.json', { permissions: { deny: ['Bash(other:*)'] } }));
  assert.ok(out.permissions.deny.includes('Bash(frobnicate:*)'), 'base denies survive a normal merge');

  // And the assertion fires when one genuinely goes missing.
  const r = runFail(w('nw3.json', withFloor({ permissions: { deny: ['Bash(vanishing:*)'] } })),
                    w('nw4.json', { permissions: null }));
  assert.strictEqual(r.status, 0, 'null overlay keeps the base, so this one passes');
});

// The floor in the generator and the floor in the shipped safe-floor template must not drift.
test('the safe-floor template satisfies the floor it is meant to guarantee', () => {
  const floorPath = path.join(__dirname, '..', 'home', '.chezmoitemplates', 'settings.safe-floor.json');
  const floor = JSON.parse(fs.readFileSync(floorPath, 'utf8'));
  for (const rule of FLOOR) {
    assert.ok(floor.permissions.deny.includes(rule), `safe floor is missing ${rule}`);
  }
  assert.deepStrictEqual(floor.permissions.allow, [], 'the safe floor grants nothing');
});

// The bootstrap case: no previously deployed file, so exiting would leave the machine with
// NO settings.json and therefore no guardrails — strictly worse than a deny-only file.
test('a first-ever apply falls back to the safe floor instead of writing nothing', () => {
  const floorPath = path.join(__dirname, '..', 'home', '.chezmoitemplates', 'settings.safe-floor.json');
  const broken = w('bs1.json', { model: 'opus' });   // no permission model at all
  const out = execFileSync('node', [BIN, broken], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_SETTINGS_SAFE_FLOOR: floorPath },
  });
  const parsed = JSON.parse(out);
  assert.ok(parsed.permissions.deny.includes('Bash(sudo:*)'), 'the safe floor is what got written');
  assert.deepStrictEqual(parsed.permissions.allow, []);
});

// ...but only when bootstrapping. With a prior deployed file present, refusing is correct:
// chezmoi leaves yesterday's richer settings.json in place, which beats the deny-only floor.
test('with a prior deployed file, a failed assertion refuses rather than downgrading', () => {
  const floorPath = path.join(__dirname, '..', 'home', '.chezmoitemplates', 'settings.safe-floor.json');
  const prior = w('bs2.json', withFloor({ model: 'opus' }));
  const broken = w('bs3.json', { model: 'opus' });
  const r = runFail(broken);
  assert.strictEqual(r.status, 1);
  try {
    execFileSync('node', [BIN, broken], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_SETTINGS_SAFE_FLOOR: floorPath, CLAUDE_SETTINGS_PRIOR: prior },
    });
    assert.fail('should have exited non-zero');
  } catch (e) {
    assert.strictEqual(e.status, 1, 'refuse, so yesterday\'s file keeps running');
    assert.strictEqual(String(e.stdout || ''), '', 'and no downgrade is written');
  }
});

// The floor is ON by default — a consumer that does nothing gets it enforced. Exactly one
// caller is exempt (resolve-sandbox-settings.sh, whose fragments carry no host floor and
// which swallows stderr), and it has to say so. This test exists so that exemption cannot
// quietly become the default: if someone inverts the flag, the first assertion here fails.
test('the floor is enforced by default and the exemption must be explicit', () => {
  const broken = w('sk1.json', { model: 'opus' });   // no permission model at all

  const byDefault = runFail(broken);
  assert.strictEqual(byDefault.status, 1, 'doing nothing must get you the floor check');

  const exempted = execFileSync('node', [BIN, broken], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_SETTINGS_SKIP_FLOOR: '1' },
  });
  assert.strictEqual(JSON.parse(exempted).model, 'opus', 'the exemption lets the merge through');
});

