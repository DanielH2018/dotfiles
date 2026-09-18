// Regression guard for home/dot_local/bin/executable_prompt-friction.
// Drives the ACTUAL script. Hermetic: --from-file replays a fixture corpus and the
// hook chain is pointed at stub hooks in a temp dir, so nothing here needs Loki, the
// real ~/.claude/settings.json, or a network.
//
// The load-bearing property is that the tool cannot flatter itself. It exists to say
// whether an auto-approver change helped, so a bug that over-counts "answered" would
// silently bless a fix that did nothing -- which is exactly the failure it was built
// to catch (the 2026-08-14 curl host fix looked like ~104 recovered prompts and
// actually recovered 1). Hence: a chain of hooks that allow nothing must report 0.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('./lib/tmp');
const { skipUnless } = require('./lib/probe');
const { srcPath } = require('./lib/paths');

const TOOL = srcPath('dot_local', 'bin', 'executable_prompt-friction');

const skip = skipUnless('python3');

const DIR = scratch(os.tmpdir(), 'pf-');

// A hook that allows only the commands whose text contains ALLOWME, so the expected
// count is a property of the fixture rather than of any real allowlist.
const YES = path.join(DIR, 'yes-hook.sh');
fs.writeFileSync(YES, [
  '#!/usr/bin/env bash',
  'input=$(cat)',
  'case $input in',
  '  *ALLOWME*) printf \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\\n\' ;;',
  'esac',
  'exit 0',
].join('\n'));
const NO = path.join(DIR, 'no-hook.sh');
fs.writeFileSync(NO, '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n');

function settingsWith(hooks) {
  const home = scratch(os.tmpdir(), 'pf-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: hooks.map(c => ({ type: 'command', command: c })) }] },
  }));
  return home;
}

const CORPUS = path.join(DIR, 'corpus.jsonl');
fs.writeFileSync(CORPUS, [
  { command: 'curl -s http://127.0.0.1:9090/metrics ALLOWME' },
  { command: 'curl -X POST http://example.com/x' },
  { command: 'ssh daniel-server uptime ALLOWME' },
  { command: 'ssh daniel-server rm -rf /tmp/x' },
  { command: 'git push origin main' },
  { command: 'uv run ansible-playbook ansible/deploy.yml' },
].map(o => JSON.stringify(o)).join('\n') + '\n');

function run(args, home) {
  return execFileSync('python3', [TOOL, '--from-file', CORPUS, '--json', ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home },
  });
}

test('counts each bucket and credits the hook that answered', { skip }, () => {
  const out = JSON.parse(run([], settingsWith([NO, YES])));
  assert.strictEqual(out.total_prompted, 6);
  assert.strictEqual(out.total_answered, 2);
  assert.deepStrictEqual(out.prompted, { curl: 2, ssh: 2, other: 2 });
  assert.deepStrictEqual(out.answered, { curl: 1, ssh: 1 });
  // Credited to the hook that actually decided, not the first one consulted:
  // no-hook.sh runs first on both and must not appear.
  assert.deepStrictEqual(out.by_hook, { 'yes-hook.sh': 2 });
});

test('a chain that allows nothing reports nothing recovered', { skip }, () => {
  const out = JSON.parse(run([], settingsWith([NO])));
  assert.strictEqual(out.total_answered, 0);
  assert.deepStrictEqual(out.by_hook, {});
  // ...and still accounts for every command, so a silent drop is visible.
  assert.strictEqual(out.total_prompted, 6);
});

test('residual groups name the leading command, not the whole line', { skip }, () => {
  const out = JSON.parse(run([], settingsWith([NO])));
  assert.strictEqual(out.residual['other:git'], 1);
  assert.strictEqual(out.residual['other:uv'], 1);
  assert.strictEqual(out.residual['curl:curl'], 2);
});

test('the hook chain comes from settings, so a removed hook stops counting', { skip }, () => {
  const before = JSON.parse(run([], settingsWith([YES])));
  const after = JSON.parse(run([], settingsWith([NO])));
  assert.strictEqual(before.total_answered, 2);
  assert.strictEqual(after.total_answered, 0);
});

test('every prompted call is either answered or residual', { skip }, () => {
  for (const home of [settingsWith([NO, YES]), settingsWith([NO])]) {
    const out = JSON.parse(run([], home));
    const residual = Object.values(out.residual).reduce((a, b) => a + b, 0);
    assert.strictEqual(out.total_answered + residual, out.total_prompted);
  }
});

test('--save round-trips a corpus that replays identically', { skip }, () => {
  const home = settingsWith([NO, YES]);
  const copy = path.join(DIR, 'copy.jsonl');
  execFileSync('python3', [TOOL, '--from-file', CORPUS, '--save', copy],
    { encoding: 'utf8', env: { ...process.env, HOME: home } });
  const out = JSON.parse(execFileSync('python3', [TOOL, '--from-file', copy, '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: home } }));
  assert.strictEqual(out.total_prompted, 6);
  assert.strictEqual(out.total_answered, 2);
});

test('a settings file with no PermissionRequest:Bash hooks fails loudly', { skip }, () => {
  const home = scratch(os.tmpdir(), 'pf-bare-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
  assert.throws(() => run([], home), /no PermissionRequest:Bash hooks/);
});

