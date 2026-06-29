const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// modify_settings.json.tmpl is a chezmoi modify_ script written as a template. Render it
// with `chezmoi execute-template` (resolves `includeTemplate "settings.base.json"` and
// `.chezmoi.sourceDir`), then exec the rendered /bin/sh script. The script regenerates
// ~/.claude/settings.json as merge(general base, work overlay-if-present), FULLY DERIVED —
// stdin (the current target content) is intentionally ignored.
const TEMPLATE = path.join(__dirname, '..', 'home', 'private_dot_claude', 'modify_settings.json.tmpl');
const rendered = execFileSync('chezmoi', ['execute-template'], {
  input: fs.readFileSync(TEMPLATE, 'utf8'),
  encoding: 'utf8',
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modset-'));
const script = path.join(tmp, 'modify_settings.sh');
fs.writeFileSync(script, rendered, { mode: 0o755 });
const run = (input) => execFileSync(script, [], { input, encoding: 'utf8' });

// 1. Output is valid JSON carrying the base structure (the base always defines permissions).
const out = JSON.parse(run(''));
assert.ok(out.permissions && typeof out.permissions === 'object', 'output has a permissions object');

// 2. Fully derived: stdin is IGNORED. Different stdin yields identical output, and a key that
//    exists only in stdin never appears in the result (the file is not merged with stdin).
const withJunk = run(JSON.stringify({ model: 'sonnet', __stdin_only_key__: true }));
assert.strictEqual(withJunk, run(''), 'output is independent of stdin');
assert.ok(!withJunk.includes('__stdin_only_key__'), 'stdin content is not merged into the output');

// 3. Idempotent: feeding the output back in yields identical output.
const once = run('');
assert.strictEqual(run(once), once, 'modify script is idempotent');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ALL PASS');
