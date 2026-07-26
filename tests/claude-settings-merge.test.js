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
// Capture a non-zero exit instead of throwing, so the status and stderr can be asserted.
const runFail = (...args) => {
  try { execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: 'pipe' }); return { status: 0, stderr: '' }; }
  catch (e) { return e; }
};

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('objects deep-merge by key', () => {
  const base = w('base.json', { model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } });
  const over = w('over.json', { enabledPlugins: { b: true }, env: { Y: '2' } });
  const out = run(base, over);
  assert.strictEqual(out.model, 'opus');
  assert.deepStrictEqual(out.enabledPlugins, { a: true, b: true });
  assert.deepStrictEqual(out.env, { X: '1', Y: '2' });
});

test('arrays concat and de-dupe by value', () => {
  const ba = w('ba.json', { deny: ['a', 'b'] });
  const oa = w('oa.json', { deny: ['b', 'c'] });
  assert.deepStrictEqual(run(ba, oa).deny, ['a', 'b', 'c']);
});

test('overlay wins on scalar conflict', () => {
  assert.strictEqual(run(w('b3.json', { model: 'opus' }), w('o3.json', { model: 'sonnet' })).model, 'sonnet');
});

test('missing overlay file is treated as {}', () => {
  const base = w('base4.json', { model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } });
  assert.deepStrictEqual(run(base, path.join(tmp, 'does-not-exist.json')).enabledPlugins, { a: true });
});

test('merging is idempotent', () => {
  const base = w('base5.json', { model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } });
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
  const base = w('b8.json', { permissions: { deny: ['Bash(rm:*)'] }, hooks: { PreToolUse: [1, 2] } });
  const over = w('o8.json', { permissions: null, hooks: null });
  const out = run(base, over);
  assert.deepStrictEqual(out.permissions, { deny: ['Bash(rm:*)'] }, 'null must not wipe permissions');
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
  const out = run(w('b11.json', { statusLine: null }), w('o11.json', { statusLine: { type: 'command' } }));
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
  const out = run(w('b12.json', { model: 'opus' }), wRaw('o12.json', '{"toString":{"type":"command"}}'));
  assert.deepStrictEqual(out.toString, { type: 'command' });
  assert.strictEqual(out.model, 'opus');
});
