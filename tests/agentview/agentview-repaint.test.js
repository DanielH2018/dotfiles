// The picker's argv (--with-nth, --id-nth) is fixed at launch, but its rows come from a
// later `--body` process reading the script off disk. These cover the fingerprint that
// tells the two apart. The end-to-end proof -- that a picker actually restarts rather
// than rendering skewed columns -- is in agentview-ui.test.js, through a real pty.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin', 'executable_agentview');
const LIB = path.join(__dirname, '..', '..', 'home', 'dot_local', 'share', 'agentview');

const dirs = [];
const scratch = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A self-contained copy of launcher + modules, so a test may rewrite a module without
// touching the checkout the suite is running from.
function copyTree() {
  const root = scratch('av-fp-');
  const bin = path.join(root, 'bin');
  const lib = path.join(root, 'share', 'agentview');
  fs.mkdirSync(bin, { recursive: true });
  fs.cpSync(LIB, lib, { recursive: true });
  const self = path.join(bin, 'agentview');
  fs.copyFileSync(SRC, self);
  fs.chmodSync(self, 0o755);
  return { self, lib };
}

const run = (t, args, env = {}) => execFileSync('bash', [t.self, ...args], {
  encoding: 'utf8',
  env: { ...process.env, AGENTVIEW_SELF: t.self, AGENTVIEW_LIB: t.lib, ...env },
}).trim();

test('--fingerprint is stable across calls when nothing changed', () => {
  const t = copyTree();
  assert.strictEqual(run(t, ['--fingerprint']), run(t, ['--fingerprint']));
});

test('--fingerprint is non-empty', () => {
  const t = copyTree();
  assert.ok(run(t, ['--fingerprint']).length > 0, 'an empty fingerprint would compare equal forever');
});

test('--fingerprint changes when a module changes', () => {
  const t = copyTree();
  const before = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  assert.notStrictEqual(run(t, ['--fingerprint']), before);
});

test('--fingerprint changes when the launcher itself changes', () => {
  const t = copyTree();
  const before = run(t, ['--fingerprint']);
  fs.appendFileSync(t.self, '\n# nudge\n');
  assert.notStrictEqual(run(t, ['--fingerprint']), before);
});

test('--repaint asks for a reload when the fingerprint matches', () => {
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  const out = run(t, ['--repaint', ''], { AV_SCRIPT_FP: fp });
  assert.match(out, /^reload\(/, `expected a reload action, got: ${out}`);
  assert.doesNotMatch(out, /become/);
});

test('--repaint asks fzf to replace itself when a module changed underneath it', () => {
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  const out = run(t, ['--repaint', ''], { AV_SCRIPT_FP: fp });
  assert.match(out, /^become\(/, `expected a become action, got: ${out}`);
});

test('--repaint carries the typed query into the restart', () => {
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  const out = run(t, ['--repaint', 'chez'], { AV_SCRIPT_FP: fp });
  assert.match(out, /--query 'chez'/, `query must survive the restart, got: ${out}`);
});

test('--repaint quotes a query that would otherwise break out of the become string', () => {
  // become() hands its argument to a shell, so an apostrophe in the filter is a
  // quoting hole, not a cosmetic issue.
  const t = copyTree();
  const fp = run(t, ['--fingerprint']);
  fs.appendFileSync(path.join(t.lib, 'render.sh'), '\n# nudge\n');
  const out = run(t, ['--repaint', "it's"], { AV_SCRIPT_FP: fp });
  assert.match(out, /--query 'it'\\''s'/, `expected a shell-safe query, got: ${out}`);
});

test('--repaint with no exported fingerprint does not restart in a loop', () => {
  // A missing AV_SCRIPT_FP means "launched by something that never set it" -- an old
  // picker, or a direct call. Restarting on that would replace the picker on every
  // keypress forever, which is worse than the skew being fixed.
  const t = copyTree();
  const out = run(t, ['--repaint', '']);
  assert.match(out, /^reload\(/, `expected reload when no baseline was exported, got: ${out}`);
});

test('--fingerprint is unchanged when a module is rewritten with identical bytes', () => {
  // chezmoi apply rewrites files whether or not their content moved; a stat-based
  // fingerprint would restart the picker on every apply, including no-op ones.
  const t = copyTree();
  const before = run(t, ['--fingerprint']);
  const p = path.join(t.lib, 'render.sh');
  const body = fs.readFileSync(p);
  fs.writeFileSync(p, body);
  assert.strictEqual(run(t, ['--fingerprint']), before);
});
