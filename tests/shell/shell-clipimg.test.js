// Behavior check for the clipimg() clipboard-image helper in shell/common.sh.
//
// clipimg used to shell out to `powershell.exe Get-Clipboard -Format Image` plus clip.exe.
// Launching a Windows binary from WSL leaks a permanently spinning CPU thread per call
// (microsoft/WSL#41173), so it now goes through WSLg's wl-paste/wl-copy and converts WSLg's
// bmp-only image mirror with wl-bmp2png. The conversion is the part worth pinning: WSLg
// offers a screenshot ONLY as image/bmp and Claude rejects bmp, so a clipimg that forwarded
// the raw bytes would look like it worked and hand Claude an unreadable file.
//
// Drives the REAL function by sourcing common.sh against stub wl-paste/wl-copy/wl-bmp2png on
// a stripped PATH, in both shells that source it. No real clipboard is touched. Offline.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scratch } = require('../lib/tmp');

const COMMON = path.join(__dirname, '..', '..', 'home', 'dot_config', 'shell', 'common.sh');

function have(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
}
// common.sh is sourced by both .bashrc and .zshrc and its header requires it to parse in
// both, so run every case under each shell that is present.
const SHELLS = ['bash', 'zsh'].filter(have);
const skip = SHELLS.length ? false : 'no bash or zsh available';

// A hermetic sandbox: stub bin first on PATH, a scratch HOME so the PNG lands somewhere
// disposable. `types` is what the stub wl-paste reports for `-l`; omitting wl-bmp2png
// exercises the converter-missing branch.
function sandbox({ types, bmp2png = true }) {
  const dir = scratch(os.tmpdir(), 'clipimg-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'home'));

  const write = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, body, { mode: 0o755 });
  };

  // Answers `-l` with the offered type list, and `--type X` with a marker payload so the
  // test can tell which branch produced the file.
  write('wl-paste', [
    '#!/bin/sh',
    // One printf argument per type, so the list really is newline-separated — the whole
    // point of the helper's line-anchored match.
    `[ "$1" = "-l" ] && { printf '%s\\n' ${types.map((t) => `'${t}'`).join(' ')}; exit 0; }`,
    'for a in "$@"; do',
    '  [ "$a" = "image/bmp" ] && { printf BMPDATA; exit 0; }',
    '  [ "$a" = "image/png" ] && { printf REALPNG; exit 0; }',
    'done',
    'exit 1',
  ].join('\n') + '\n');

  // Refuses anything that isn't the bmp payload, mirroring the real converter's non-zero
  // exit on a bmp it can't read.
  write('wl-bmp2png', [
    '#!/bin/sh',
    'd=$(cat)',
    '[ "$d" = "BMPDATA" ] || exit 1',
    'printf CONVERTEDPNG',
  ].join('\n') + '\n');
  if (!bmp2png) fs.rmSync(path.join(bin, 'wl-bmp2png'));

  write('wl-copy', '#!/bin/sh\ncat > "$CLIP_LOG"\n');

  return { dir, bin, home: path.join(dir, 'home'), clipLog: path.join(dir, 'clip.log') };
}

function runClipimg(shell, sb) {
  const res = execFileSync(shell, ['-c', `. "${COMMON}" 2>/dev/null; clipimg; echo "rc=$?"`], {
    encoding: 'utf8',
    env: {
      // env -i equivalent: common.sh guards every integration on `command -v`, so a stripped
      // PATH leaves the stubs as the only reachable version of the tools clipimg calls.
      // It does NOT make the rest of the file inert — /usr/bin stays on PATH, so anything
      // shipped by the OS still resolves. The ssh-agent block used to spawn a detached agent
      // here on every case (no SSH_AUTH_SOCK inherited, throwaway HOME) and leak it; that is
      // now gated on an interactive shell, and pinned by shell-ssh-agent-guard.test.js.
      HOME: sb.home, PATH: `${sb.bin}:/usr/bin:/bin`, CLIP_LOG: sb.clipLog, SHELL: shell,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rc = Number((res.match(/rc=(\d+)\s*$/) || [])[1]);
  const pngs = [];
  const cache = path.join(sb.home, '.cache', 'clipimg');
  if (fs.existsSync(cache)) {
    for (const f of fs.readdirSync(cache)) pngs.push({ name: f, body: fs.readFileSync(path.join(cache, f), 'utf8') });
  }
  const clip = fs.existsSync(sb.clipLog) ? fs.readFileSync(sb.clipLog, 'utf8') : null;
  return { stdout: res, rc, pngs, clip };
}

for (const shell of SHELLS) {
  test(`[${shell}] a WSLg bmp is converted to PNG and its @path goes on the clipboard`, { skip }, () => {
    const sb = sandbox({ types: ['text/plain', 'image/bmp', 'STRING'] });
    const { rc, pngs, clip, stdout } = runClipimg(shell, sb);
    assert.strictEqual(rc, 0);
    assert.strictEqual(pngs.length, 1, 'exactly one PNG written');
    assert.strictEqual(pngs[0].body, 'CONVERTEDPNG', 'went through wl-bmp2png, not forwarded raw');
    assert.match(pngs[0].name, /^clip-\d{8}-\d{6}\.png$/);
    // The whole point of the helper: a path Claude can be handed with @.
    assert.strictEqual(clip, `@${path.join(sb.home, '.cache', 'clipimg', pngs[0].name)}`);
    assert.match(stdout, /Ctrl\+Shift\+V/, 'tells you how to paste it');
  });

  test(`[${shell}] a real image/png is taken as-is, without the bmp converter`, { skip }, () => {
    const sb = sandbox({ types: ['image/png', 'image/bmp'] });
    const { rc, pngs } = runClipimg(shell, sb);
    assert.strictEqual(rc, 0);
    assert.strictEqual(pngs[0].body, 'REALPNG', 'png is preferred over the bmp mirror');
  });

  test(`[${shell}] a text-only clipboard fails cleanly and leaves no file behind`, { skip }, () => {
    const sb = sandbox({ types: ['text/plain', 'STRING'] });
    const { rc, pngs, clip } = runClipimg(shell, sb);
    assert.strictEqual(rc, 1);
    assert.deepStrictEqual(pngs, [], 'no stub file left for Claude to choke on');
    assert.strictEqual(clip, null, 'clipboard untouched');
  });

  test(`[${shell}] a failed conversion is an error, not an empty PNG`, { skip }, () => {
    // wl-bmp2png absent: the redirection still creates the file, so the emptiness check is
    // the only thing standing between a failed convert and a 0-byte @path handed to Claude.
    const sb = sandbox({ types: ['image/bmp'], bmp2png: false });
    const { rc, pngs } = runClipimg(shell, sb);
    assert.strictEqual(rc, 1);
    assert.deepStrictEqual(pngs, [], 'the empty file is cleaned up');
  });
}

test('clipimg never launches a Windows binary', { skip }, () => {
  // The regression this guards: reintroducing powershell.exe/clip.exe would leak a spinning
  // CPU thread per call. Comments may still name them — the history is the reason the code
  // looks the way it does — so only executable lines are checked.
  const code = fs.readFileSync(COMMON, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'));
  const offenders = code.filter((l) => /\.exe\b/.test(l));
  assert.deepStrictEqual(offenders, [], 'no executable line in common.sh names a .exe');
});

