// Regression guard for the xclip/xsel clipboard shims and the wl-bmp2png
// converter in home/dot_local/bin. xclip and xsel forward to WSLg's
// wl-copy/wl-paste (not directly to a Windows exe — see the comments in each
// script); this drives the REAL scripts against stub wl-copy/wl-paste/wl-bmp2png
// placed first on PATH, so no real clipboard is touched. Offline. Skips cleanly
// if bash (or, for the converter, python3) is unavailable.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN_DIR = path.join(__dirname, '..', '..', 'home', 'dot_local', 'bin');
const XCLIP = path.join(BIN_DIR, 'executable_xclip');
const XSEL = path.join(BIN_DIR, 'executable_xsel');
const WLBMP2PNG = path.join(BIN_DIR, 'executable_wl-bmp2png');

// Resolve bash by absolute path so spawning it doesn't depend on (and isn't broken
// by) the deliberately-stripped-down PATH we hand to the scripts under test.
const BASH = ['/usr/bin/bash', '/bin/bash'].find((p) => fs.existsSync(p));
const skip = BASH ? false : 'bash unavailable';
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3'].find((p) => fs.existsSync(p));
const skipPy = BASH ? (PYTHON ? false : 'python3 unavailable') : skip;

// Minimal 1x1 24-bit BI_RGB BMP with a known BGR pixel (bottom-up, row padded to 4B).
function makeBmp1x1(b, g, r) {
  const buf = Buffer.alloc(58);
  buf.write('BM', 0);
  buf.writeUInt32LE(58, 2);   // file size
  buf.writeUInt32LE(54, 10);  // pixel data offset
  buf.writeUInt32LE(40, 14);  // BITMAPINFOHEADER size
  buf.writeInt32LE(1, 18);    // width
  buf.writeInt32LE(1, 22);    // height
  buf.writeUInt16LE(1, 26);   // planes
  buf.writeUInt16LE(24, 28);  // bpp
  buf.writeUInt32LE(0, 30);   // BI_RGB
  buf.writeUInt32LE(4, 34);   // image size
  buf[54] = b; buf[55] = g; buf[56] = r; buf[57] = 0;
  return buf;
}

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

// The shims gate themselves to WSL and hand off to the real xclip/xsel anywhere else,
// so every test claims to be WSL. Without that the whole file fails off WSL, testing
// the guard instead of the behaviour it guards. `wsl: false` opts back out, for the
// one test that is about the guard.
function run(script, args, opts = {}) {
  const { wsl = true, ...rest } = opts;
  const env = { ...(rest.env || process.env) };
  if (wsl) env.WSL_DISTRO_NAME = 'test';
  else delete env.WSL_DISTRO_NAME;
  try {
    const out = execFileSync(BASH, [script, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...rest, env,
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// --- the WSL guard itself ---
// Untested until now, which is how it came to break this file: the shims grew the
// guard and every test here kept asserting the behaviour behind it. Asserted as
// "never reaches wl-copy" rather than a specific exit code, because the shim execs a
// real xclip/xsel where one exists and only fails with 127 where one doesn't.
// Unreachable on WSL, where /proc/version satisfies the guard no matter the env.
const onWsl = /microsoft/i.test(
  fs.existsSync('/proc/version') ? fs.readFileSync('/proc/version', 'utf8') : '',
);
const skipGuard = skip || (onWsl ? 'the guard cannot be exercised on WSL' : false);

for (const [label, script] of [['xclip', XCLIP], ['xsel', XSEL]]) {
  test(`${label} refuses to reach wl-copy off WSL`, { skip: skipGuard }, () => {
    const dir = scratch();
    const argvFile = path.join(dir, 'argv.txt');
    makeStub(dir, 'wl-copy', `printf '%s' "$*" > ${JSON.stringify(argvFile)}`);
    run(script, [], { env: { ...process.env, PATH: dir }, wsl: false, input: 'x' });
    assert.ok(!fs.existsSync(argvFile), `${label} must not forward to wl-copy off WSL`);
  });
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

// --- xclip: TARGETS probe + typed reads (what Claude Code uses to paste images) ---
test('xclip -t TARGETS -o answers with the type list from wl-paste -l', { skip }, () => {
  // The old shim ignored -t and dumped raw clipboard bytes here, so Claude's
  // `... | grep image/png|image/bmp` saw pixels, matched nothing, and concluded
  // no image was pasteable. wl-paste -l is the type list that probe expects.
  const dir = scratch();
  const argvFile = path.join(dir, 'argv.txt');
  makeStub(dir, 'wl-paste', `printf '%s' "$*" > ${JSON.stringify(argvFile)}\nprintf 'image/bmp\\ntext/plain\\n'`);
  const r = run(XCLIP, ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /image\/bmp/);
  assert.strictEqual(fs.readFileSync(argvFile, 'utf8'), '-l', 'TARGETS maps to wl-paste -l, not a raw paste');
});

test('xclip -t image/png -o forwards the type so binary reads stay intact', { skip }, () => {
  const dir = scratch();
  const argvFile = path.join(dir, 'argv.txt');
  makeStub(dir, 'wl-paste', `printf '%s' "$*" > ${JSON.stringify(argvFile)}\nprintf 'PNGBYTES'`);
  const r = run(XCLIP, ['-selection', 'clipboard', '-t', 'image/png', '-o'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'PNGBYTES');
  assert.strictEqual(fs.readFileSync(argvFile, 'utf8'), '--no-newline --type image/png');
});

test('xclip -t <type> on the copy path forwards the type to wl-copy', { skip }, () => {
  const dir = scratch();
  const argvFile = path.join(dir, 'argv.txt');
  makeStub(dir, 'wl-copy', `printf '%s' "$*" > ${JSON.stringify(argvFile)}`);
  const r = run(XCLIP, ['-selection', 'clipboard', '-t', 'image/png'], { env: { ...process.env, PATH: dir }, input: 'x' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(fs.readFileSync(argvFile, 'utf8'), '--type image/png');
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

// --- xclip: BMP->PNG conversion (WSLg gives only image/bmp; Claude needs png) ---
test('xclip -t TARGETS -o advertises image/png when only a bmp is present', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'wl-paste', `[ "$*" = "-l" ] && printf 'image/bmp\\n'`);
  const r = run(XCLIP, ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /image\/bmp/);
  assert.match(r.stdout, /image\/png/, 'a synthesized png target is offered so Claude sees a supported type');
});

test('xclip -t image/png -o converts the bmp via wl-bmp2png when no native png exists', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'wl-paste', `case "$*" in "-l") printf 'image/bmp\\n';; *"--type image/bmp"*) printf 'RAWBMP';; esac`);
  makeStub(dir, 'wl-bmp2png', `IFS= read -r -d '' _body <&0 || true\nprintf 'PNG(%s)' "$_body"`);
  const r = run(XCLIP, ['-selection', 'clipboard', '-t', 'image/png', '-o'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'PNG(RAWBMP)', 'the bmp is piped through wl-bmp2png');
});

test('xclip -t image/png -o passes a native png straight through (no conversion)', { skip }, () => {
  const dir = scratch();
  makeStub(dir, 'wl-paste', `case "$*" in "-l") printf 'image/png\\n';; *) printf 'NATIVEPNG';; esac`);
  makeStub(dir, 'wl-bmp2png', `exit 1`); // must NOT be called
  const r = run(XCLIP, ['-selection', 'clipboard', '-t', 'image/png', '-o'], { env: { ...process.env, PATH: dir } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, 'NATIVEPNG');
});

// --- wl-bmp2png: real converter, stdlib only ---
test('wl-bmp2png turns a BMP on stdin into a valid PNG of the same size', { skip: skipPy }, () => {
  const png = execFileSync(PYTHON, [WLBMP2PNG], { input: makeBmp1x1(10, 20, 30) });
  assert.strictEqual(png.subarray(0, 8).toString('latin1'), '\x89PNG\r\n\x1a\n', 'PNG signature');
  assert.strictEqual(png.readUInt32BE(16), 1, 'IHDR width');
  assert.strictEqual(png.readUInt32BE(20), 1, 'IHDR height');
});

test('wl-bmp2png exits non-zero on non-BMP input so the shim can fall back', { skip: skipPy }, () => {
  assert.throws(() => execFileSync(PYTHON, [WLBMP2PNG], { input: Buffer.from('not a bitmap'), stdio: ['pipe', 'pipe', 'pipe'] }));
});

process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
