// bin/gen-hooks renders the `hooks` block of settings.base.json from the `# gen-hooks:`
// block each hook file carries. Before it, the block was hand-written JSON and nothing
// asserted that every hook on disk was registered in it (#528). The lib tests below pin the
// grammar (one opener, no closing delimiter), the three verdicts the census must reach — an
// undeclared executable is an ERROR, a library-marked one is accepted, a malformed block is
// an error — and the comma scheme that keeps a chezmoi-gated group valid JSON. The
// end-to-end trio runs the real binary green against the committed tree, red against a
// hand-edited template, and red against a tree with one undeclared hook more.
const { test } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../bin/gen-hooks-lib.js');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'gen-hooks');
const HOOKS_DIR = path.join(REPO_ROOT, 'home', 'private_dot_claude', 'hooks');
const TEMPLATE = path.join(REPO_ROOT, 'home', '.chezmoitemplates', 'settings.base.json');

const REG = (body) => `#!/bin/bash\n# gen-hooks: register\n${body}\necho hi\n`;

// --- lib.parseHookFile ----------------------------------------------------------------------

test('parseHookFile reads a register block, derives the command, and stops at the first non-field line', () => {
  const text = REG('#   event: SessionStart\n#   matcher: startup|resume\n#   timeout: 5\n#   order: 20\n#   args: start\n#   when: ne .chezmoi.os "windows"\n#   async: true\n#   statusMessage: Seeding...\n# prose that follows the block is not a field');
  const { registrations, library } = lib.parseHookFile('executable_warp.sh', text);
  assert.strictEqual(library, null);
  assert.deepStrictEqual(registrations, [{
    file: 'executable_warp.sh', event: 'SessionStart', matcher: 'startup|resume', timeout: 5, order: 20,
    when: 'ne .chezmoi.os "windows"', async: true, statusMessage: 'Seeding...',
    command: '~/.claude/hooks/warp.sh start',
  }]);
});

test('parseHookFile keeps a command: override verbatim so a chezmoi action inside it survives', () => {
  const cmd = '{{ if eq .chezmoi.os "windows" }}py -3 ~/.claude/hooks/x.py{{ else }}~/.claude/hooks/x.sh{{ end }}';
  const [r] = lib.parseHookFile('executable_x.sh', REG(`#   event: PreToolUse\n#   timeout: 10\n#   order: 10\n#   command: ${cmd}`)).registrations;
  assert.strictEqual(r.command, cmd);
  assert.match(lib.renderHooksBlock([r]), new RegExp(`"command": "${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",`));
});

test('parseHookFile accepts a library block with a reason', () => {
  const { registrations, library } = lib.parseHookFile('executable_lib.sh',
    '#!/bin/bash\n# gen-hooks: library\n#   reason: sourced by notify.sh\n');
  assert.deepStrictEqual(registrations, []);
  assert.deepStrictEqual(library, { reason: 'sourced by notify.sh' });
});

test('parseHookFile rejects a malformed block', () => {
  const cases = [
    ['unknown opener', '#!/bin/bash\n# gen-hooks: registr\n#   event: Stop\n', /unknown block/],
    ['unknown key', REG('#   event: Stop\n#   timeout: 5\n#   order: 10\n#   timeot: 5'), /unknown key 'timeot'/],
    ['missing timeout', REG('#   event: Stop\n#   order: 10'), /missing timeout:/],
    ['unknown event', REG('#   event: OnStop\n#   timeout: 5\n#   order: 10'), /unknown event 'OnStop'/],
    ['non-integer order', REG('#   event: Stop\n#   timeout: 5\n#   order: first'), /order must be a non-negative integer/],
    ['library without reason', '#!/bin/bash\n# gen-hooks: library\n', /needs a reason:/],
    ['library and register in one file', `#!/bin/bash\n# gen-hooks: library\n#   reason: x\n${REG('#   event: Stop\n#   timeout: 5\n#   order: 10')}`, /marked library but also/],
  ];
  for (const [label, text, re] of cases) {
    assert.throws(() => lib.parseHookFile('executable_bad.sh', text), re, label);
  }
});

// --- lib.census: the verdict the generator exists for ---------------------------------------

const DECLARED = REG('#   event: Stop\n#   timeout: 5\n#   order: 10');

test('census errors on an executable that declares nothing, naming it', () => {
  assert.throws(() => lib.census({
    'executable_declared.sh': DECLARED,
    'executable_silent.sh': '#!/bin/bash\necho nothing declared\n',
  }), /1 hook file\(s\) declare no registration.*executable_silent\.sh/);
});

test('census accepts a library-marked executable and ignores non-executable siblings', () => {
  const { registrations, libraries } = lib.census({
    'executable_declared.sh': DECLARED,
    'executable_helper.sh': '#!/bin/bash\n# gen-hooks: library\n#   reason: sourced by declared.sh\n',
    'hook-input.sh': '# sourced, never executed, declares nothing',
    'test_declared.py': 'def test(): pass',
  });
  assert.deepStrictEqual(libraries, [{ file: 'executable_helper.sh', reason: 'sourced by declared.sh' }]);
  assert.deepStrictEqual(registrations.map((r) => r.file), ['executable_declared.sh', ...lib.INLINE_REGISTRATIONS.map((r) => r.file)]);
});

// --- lib.renderHooksBlock: grouping and the comma scheme ------------------------------------

function reg(file, event, order, extra = {}) {
  return { file, event, order, timeout: 5, command: `~/.claude/hooks/${file}`, ...extra };
}

test('renderHooksBlock folds consecutive same-matcher entries into one group, in order:', () => {
  const block = lib.renderHooksBlock([
    reg('b.sh', 'PreToolUse', 20, { matcher: 'Bash' }),
    reg('a.sh', 'PreToolUse', 10, { matcher: 'Bash' }),
    reg('c.sh', 'PreToolUse', 30, { matcher: 'Edit' }),
    reg('d.sh', 'PreToolUse', 40, { matcher: 'Bash' }),
  ], '');
  const parsed = JSON.parse(`{${block}}`);
  assert.deepStrictEqual(parsed.PreToolUse.map((g) => [g.matcher, g.hooks.map((h) => h.command)]), [
    ['Bash', ['~/.claude/hooks/a.sh', '~/.claude/hooks/b.sh']],
    ['Edit', ['~/.claude/hooks/c.sh']],
    ['Bash', ['~/.claude/hooks/d.sh']],
  ]);
});

test('renderHooksBlock wraps a conditional group so the JSON stays valid whether the gate is open or shut', () => {
  const block = lib.renderHooksBlock([
    reg('a.sh', 'SessionStart', 10, { matcher: 'startup' }),
    reg('b.sh', 'SessionStart', 20, { matcher: 'startup', when: 'ne .chezmoi.os "windows"' }),
    reg('c.sh', 'SessionStart', 30, { matcher: 'startup|resume' }),
  ], '');
  assert.match(block, /\}\{\{ if ne \.chezmoi\.os "windows" \}\},\n/);
  assert.match(block, /\}\{\{ end \}\},\n/);
  const open = block.replace(/\{\{ if [^}]*\}\}/g, '').replace(/\{\{ end \}\}/g, '');
  const shut = block.replace(/\{\{ if [^}]*\}\}[\s\S]*?\{\{ end \}\}/g, '');
  assert.deepStrictEqual(JSON.parse(`{${open}}`).SessionStart.map((g) => g.hooks[0].command),
    ['~/.claude/hooks/a.sh', '~/.claude/hooks/b.sh', '~/.claude/hooks/c.sh']);
  assert.deepStrictEqual(JSON.parse(`{${shut}}`).SessionStart.map((g) => g.hooks[0].command),
    ['~/.claude/hooks/a.sh', '~/.claude/hooks/c.sh']);
});

test('renderHooksBlock rejects a duplicate order and a conditional first entry', () => {
  assert.throws(() => lib.renderHooksBlock([reg('a.sh', 'Stop', 10), reg('b.sh', 'Stop', 10)]),
    /a\.sh and b\.sh both declare order: 10/);
  assert.throws(() => lib.renderHooksBlock([reg('a.sh', 'Stop', 10, { when: 'eq .chezmoi.os "linux"' }), reg('b.sh', 'Stop', 20)]),
    /first entry \(a\.sh\) is conditional/);
});

test('renderHooksBlock carries statusMessage and async through, in the template\'s key order', () => {
  const block = lib.renderHooksBlock([reg('a.sh', 'Stop', 10, { statusMessage: 'Working...', async: true })], '');
  assert.match(block, /"timeout": 5,\n\s*"statusMessage": "Working...",\n\s*"async": true\n/);
  assert.doesNotThrow(() => JSON.parse(`{${block}}`));
});

// --- lib.injectHooksBlock --------------------------------------------------------------------

test('injectHooksBlock rewrites only the lines between the markers', () => {
  const tmpl = '{\n  "hooks": {\n    {{/* gen-hooks:begin */}}\n    "Stop": [ stale ]\n    {{/* gen-hooks:end */}}\n  },\n  "other": 1\n}\n';
  const out = lib.injectHooksBlock(tmpl, [reg('a.sh', 'Stop', 10)]);
  assert.match(out, /^\{\n {2}"hooks": \{\n {4}\{\{\/\* gen-hooks:begin \*\/\}\}\n {4}"Stop": \[\n/);
  assert.match(out, /\n {4}\{\{\/\* gen-hooks:end \*\/\}\}\n {2}\},\n {2}"other": 1\n\}\n$/);
  assert.doesNotMatch(out, /stale/);
});

test('injectHooksBlock throws when a marker is missing', () => {
  assert.throws(() => lib.injectHooksBlock('{\n  "hooks": {\n  }\n}\n', []), /expected exactly one .*found 0 and 0/);
});

// --- End-to-end: the real tree, then two ways for it to drift -------------------------------

test('gen-hooks --check passes against the committed tree right now', () => {
  const out = execFileSync('node', [BIN, '--check'], { encoding: 'utf8' });
  assert.match(out, /settings\.base\.json is up to date/);
});

// A copy of the generator, the hooks directory and the template in a temp dir, so the two
// red cases below can break things without touching this tree.
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-hooks-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const f of ['gen-hooks', 'gen-hooks-lib.js']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'bin', f), path.join(dir, 'bin', f));
  }
  fs.mkdirSync(path.join(dir, 'home', '.chezmoitemplates'), { recursive: true });
  fs.copyFileSync(TEMPLATE, path.join(dir, 'home', '.chezmoitemplates', 'settings.base.json'));
  fs.cpSync(HOOKS_DIR, path.join(dir, 'home', 'private_dot_claude', 'hooks'), { recursive: true });
  return dir;
}

test('gen-hooks --check fails on a hand edit inside the generated block', () => {
  const dir = stage();
  const tmpl = path.join(dir, 'home', '.chezmoitemplates', 'settings.base.json');
  fs.writeFileSync(tmpl, fs.readFileSync(tmpl, 'utf8').replace('"timeout": 10\n', '"timeout": 11\n'));
  const r = spawnSync('node', [path.join(dir, 'bin', 'gen-hooks'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /settings\.base\.json is out of date/);
  assert.match(r.stderr, /committed: .*"timeout": 11/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gen-hooks --check fails when the hooks directory gains an executable that declares nothing', () => {
  const dir = stage();
  fs.writeFileSync(path.join(dir, 'home', 'private_dot_claude', 'hooks', 'executable_brand-new.sh'), '#!/bin/bash\nexit 0\n');
  const r = spawnSync('node', [path.join(dir, 'bin', 'gen-hooks'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /declare no registration.*executable_brand-new\.sh/);
  fs.rmSync(dir, { recursive: true, force: true });
});
