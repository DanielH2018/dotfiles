const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'private_dot_claude', 'modify_settings.json');
// Execute the script directly so its shebang (#!/bin/sh) picks the interpreter — running it
// as `node SCRIPT` would mis-handle the .json extension.
const run = (input) => execFileSync(SCRIPT, [], { input, encoding: 'utf8' });

// 1. Empty input (new machine, no settings.json yet) -> creates both keys.
let out = JSON.parse(run(''));
assert.strictEqual(out.enabledPlugins['claude-permission-audit@daniel-tools'], true);
assert.deepStrictEqual(out.extraKnownMarketplaces['daniel-tools'].source,
  { source: 'github', repo: 'DanielH2018/claude-permission-audit' });

// 2. Existing keys preserved, additions made.
const existing = JSON.stringify({ model: 'opus', enabledPlugins: { 'foo@bar': true } });
out = JSON.parse(run(existing));
assert.strictEqual(out.model, 'opus');
assert.strictEqual(out.enabledPlugins['foo@bar'], true);
assert.strictEqual(out.enabledPlugins['claude-permission-audit@daniel-tools'], true);

// 3. Idempotent: running twice yields identical output.
const once = run(existing);
const twice = run(once);
assert.strictEqual(once, twice);

// 4. Unparseable input is echoed unchanged (never destroy a file we can't parse).
const junk = '{ this is not json';
assert.strictEqual(run(junk), junk);

console.log('ALL PASS');
