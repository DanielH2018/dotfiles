const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const w = (name, obj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };
const run = (...args) => JSON.parse(execFileSync('node', [BIN, ...args], { encoding: 'utf8' }));

// 1. Objects deep-merge by key.
const base = w('base.json', { model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } });
const over = w('over.json', { enabledPlugins: { b: true }, env: { Y: '2' } });
let out = run(base, over);
assert.strictEqual(out.model, 'opus');
assert.deepStrictEqual(out.enabledPlugins, { a: true, b: true });
assert.deepStrictEqual(out.env, { X: '1', Y: '2' });

// 2. Arrays concat + de-dupe by value.
const ba = w('ba.json', { deny: ['a', 'b'] });
const oa = w('oa.json', { deny: ['b', 'c'] });
assert.deepStrictEqual(run(ba, oa).deny, ['a', 'b', 'c']);

// 3. Overlay wins on scalar conflict.
assert.strictEqual(run(w('b3.json', { model: 'opus' }), w('o3.json', { model: 'sonnet' })).model, 'sonnet');

// 4. Missing overlay file is treated as {} (base returned unchanged).
assert.deepStrictEqual(run(base, path.join(tmp, 'does-not-exist.json')).enabledPlugins, { a: true });

// 5. Idempotent: merging the output with the same overlay is stable.
const once = execFileSync('node', [BIN, base, over], { encoding: 'utf8' });
const onceFile = w('once.json', JSON.parse(once));
const twice = execFileSync('node', [BIN, onceFile, over], { encoding: 'utf8' });
assert.strictEqual(once, twice);

// 6. No arguments -> usage error on stderr, exit 2.
const noArgs = (() => { try { execFileSync('node', [BIN], { encoding: 'utf8', stdio: 'pipe' }); return { status: 0 }; } catch (e) { return e; } })();
assert.strictEqual(noArgs.status, 2, 'no args must exit 2');
assert.match(noArgs.stderr, /usage:/);

// 7. Unparseable JSON -> error on stderr naming the file, exit 1.
const bad = path.join(tmp, 'bad.json'); fs.writeFileSync(bad, '{not json');
const parseErr = (() => { try { execFileSync('node', [BIN, bad], { encoding: 'utf8', stdio: 'pipe' }); return { status: 0 }; } catch (e) { return e; } })();
assert.strictEqual(parseErr.status, 1, 'parse failure must exit 1');
assert.match(parseErr.stderr, /cannot parse .*bad\.json/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ALL PASS');
