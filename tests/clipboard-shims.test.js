// Regression guard for the xclip/xsel/wsl-clip-bridge clipboard shims in
// home/dot_local/bin. xclip and xsel forward to WSLg's wl-copy/wl-paste
// (not directly to a Windows exe — see the comments in each script); this
// drives the REAL scripts against stub wl-copy/wl-paste/tasklist.exe/taskkill.exe
// placed first on PATH, so no real clipboard or Windows interop is touched.
// Offline. Skips cleanly if bash is unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN_DIR = path.join(__dirname, '..', 'home', 'dot_local', 'bin');
const XCLIP = path.join(BIN_DIR, 'executable_xclip');
const XSEL = path.join(BIN_DIR, 'executable_xsel');
const BRIDGE = path.join(BIN_DIR, 'executable_wsl-clip-bridge');

// Resolve bash by absolute path so spawning it doesn't depend on (and isn't broken
// by) the deliberately-stripped-down PATH we hand to the scripts under test.
const BASH = ['/usr/bin/bash', '/bin/bash'].find((p) => fs.existsSync(p));
const skip = BASH ? false : 'bash unavailable';

const dirs = [];
function scratch() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-shim-')); dirs.push(d); return d; }

// Slurp all of stdin into a file using only bash builtins (`cat` is an
// external command, and PATH is deliberately narrowed to just our stubs).
function slurpStdinTo(fileExpr) {
  return `IFS= read -r -d '' _body <&0 || true\nprintf '%s' "$_body" > ${fileExpr}`;
}

function makeStub(dir, name, body) {
  // Absolute-path shebang: the shim's `exec <name>` inherits the deliberately
  // narrow PATH we hand it, so an env-lookup shebang (`/usr/bin/env bash`)
  // would itself fail to resolve bash.
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!${BASH}\n${body}\n`, { mode: 0o755 });
  return p;
}

function run(script, args, opts = {}) {
  try {
    const out = execFileSync(BASH, [script, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts,
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// --- xclip: copy path ---
test('xclip with no args pipes stdin verbatim into wl-copy (copy path)', { skip }, () => {
  const dir = scratch();
  const argvFile = path.join(dir, 'argv.txt');
  const stdinFile = path.join(dir, 'stdin.txt');
  makeStub(dir, 'wl-copy', `printf '%s' "$*" > ${JSON.stringify(argvFile)}\n${slurpStdinTo(JSON.stringify(stdinFile))}`);
  const r = run(XCLIP, [], { env: { ...process.env, PATH: dir }, input: 'copied via xclip' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(stdinFile, 'utf8'), 'copied via xclip');
  assert.strictEqual(fs.readFileSync(argvFile, 'utf8'), '', 'wl-copy is called with no extra args');
});

// --- xclip: paste path ---
test('xclip -o calls wl-paste --no-newline and returns its output (paste path)', { skip }, () => {
  const dir = scratch();
  const argvFile = path.join(dir, 'argv.txt');
  makeStub(dir, 'wl-paste', `printf '%s' "$*" > ${JSON.stringify(argvFile)}\nprintf 'canned paste text'`);
  const r = run(XCLIP, ['-o'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'canned paste text');
  assert.strictEqual(fs.readFileSync(argvFile, 'utf8'), '--no-newline');
});

test('xclip -out (long alias) also routes to the paste path', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'wl-paste', `printf 'out'`);
  const r = run(XCLIP, ['-out'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'out');
});

// --- xclip: missing backend ---
test('xclip fails loudly when wl-copy is missing from PATH', { skip }, () => {
  const dir = scratch(); // empty — no wl-copy/wl-paste stub
  const r = run(XCLIP, [], { env: { ...process.env, PATH: dir }, input: 'x' });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /wl-copy/);
});

// --- xsel: write path (simple -i, combined cluster, long --input) ---
test('xsel -i pipes stdin into wl-copy (write path)', { skip }, () => {
  const dir = scratch();
  const stdinFile = path.join(dir, 'stdin.txt');
  makeStub(dir, 'wl-copy', slurpStdinTo(JSON.stringify(stdinFile)));
  const r = run(XSEL, ['-i'], { env: { ...process.env, PATH: dir }, input: 'written via xsel' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(stdinFile, 'utf8'), 'written via xsel');
});

test('xsel -ib (combined short-flag cluster) is treated as a write', { skip }, () => {
  const dir = scratch();
  const stdinFile = path.join(dir, 'stdin.txt');
  makeStub(dir, 'wl-copy', slurpStdinTo(JSON.stringify(stdinFile)));
  const r = run(XSEL, ['-ib'], { env: { ...process.env, PATH: dir }, input: 'clustered' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(stdinFile, 'utf8'), 'clustered');
});

test('xsel --input (long flag) is treated as a write', { skip }, () => {
  const dir = scratch();
  const stdinFile = path.join(dir, 'stdin.txt');
  makeStub(dir, 'wl-copy', slurpStdinTo(JSON.stringify(stdinFile)));
  const r = run(XSEL, ['--input'], { env: { ...process.env, PATH: dir }, input: 'long flag' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(stdinFile, 'utf8'), 'long flag');
});

// --- xsel: read/paste path (default, and a cluster with no i/a) ---
test('xsel with no args reads via wl-paste --no-newline (paste path)', { skip }, () => {
  const dir = scratch();
  const argvFile = path.join(dir, 'argv.txt');
  makeStub(dir, 'wl-paste', `printf '%s' "$*" > ${JSON.stringify(argvFile)}\nprintf 'canned selection'`);
  const r = run(XSEL, [], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'canned selection');
  assert.strictEqual(fs.readFileSync(argvFile, 'utf8'), '--no-newline');
});

test('xsel -b (cluster without i or a) still reads, does not write', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'wl-paste', `printf 'read-path'`);
  const r = run(XSEL, ['-b'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'read-path');
});

// --- wsl-clip-bridge: --status / --stop argument routing, and missing backend ---
test('wsl-clip-bridge --status reports "running" when tasklist.exe lists the listener', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'tasklist.exe', `printf 'Image Name\\nclip-listener.exe  1234 Console  1  10,000 K\\n'`);
  const r = run(BRIDGE, ['--status'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'running');
});

test('wsl-clip-bridge --status reports "stopped" when tasklist.exe has no match', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'tasklist.exe', `printf 'INFO: No tasks running.\\n'`);
  const r = run(BRIDGE, ['--status'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'stopped');
});

test('wsl-clip-bridge --stop reports "stopped" when taskkill.exe succeeds', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'taskkill.exe', `exit 0`);
  const r = run(BRIDGE, ['--stop'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'stopped');
});

test('wsl-clip-bridge --stop reports nothing-running when taskkill.exe fails', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'taskkill.exe', `exit 1`);
  const r = run(BRIDGE, ['--stop'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /no clip-listener\.exe running/);
});

test('wsl-clip-bridge --status errors when tasklist.exe (the backend) is missing', { skip }, () => {
  const dir = scratch(); // empty — no tasklist.exe stub
  const r = run(BRIDGE, ['--status'], { env: { ...process.env, PATH: dir } });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /tasklist\.exe not found/);
});

test('wsl-clip-bridge --stop errors when taskkill.exe (the backend) is missing', { skip }, () => {
  const dir = scratch(); // empty — no taskkill.exe stub
  const r = run(BRIDGE, ['--stop'], { env: { ...process.env, PATH: dir } });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /taskkill\.exe not found/);
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
