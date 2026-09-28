'use strict';
// Tests for home/dot_config/fastfetch/trim-logos.js, which derives the Windows fastfetch logo
// set at apply time, and for the run_onchange script that calls it. Until #694 that set was
// committed; the generator was checked pixel-identical to it, 21 of 21, before it was deleted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { srcPath } = require('./lib/paths');
const { renderTemplate, chezmoiAvailable } = require('./lib/render');
const { scratch } = require('./lib/tmp');

const { decodePng, encodePng, trimToSquare } = require(srcPath('dot_config', 'fastfetch', 'trim-logos.js'));
const LOGOS = srcPath('dot_config', 'fastfetch', 'logos');
const SCRIPT = srcPath('.chezmoiscripts', 'os-windows', 'run_onchange_after_fastfetch-trim-logos.sh.tmpl');

function image(width, height, paint) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = paint(x, y);
      if (px) Buffer.from(px).copy(rgba, (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

function bbox({ width, height, rgba }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

test('crops to the content, centres it on a square of the longer edge, and never scales', () => {
  // A 4x2 opaque block inside a 10x6 transparent canvas.
  const src = image(10, 6, (x, y) => (x >= 2 && x <= 5 && y >= 1 && y <= 2 ? [255, 255, 255, 255] : null));
  const out = trimToSquare(src);
  assert.strictEqual(out.width, 4);
  assert.strictEqual(out.height, 4);
  assert.deepStrictEqual(bbox(out), { x0: 0, y0: 1, w: 4, h: 2 });
});

test('maps a pixel to itself premultiplied, with alpha applied twice', () => {
  const out = trimToSquare(image(1, 1, () => [255, 255, 255, 128]));
  assert.deepStrictEqual([...out.rgba], [128, 128, 128, 64]);
});

test('encodePng output decodes back to the same pixels', () => {
  const img = image(3, 2, (x, y) => [x * 40, y * 90, 7, 255 - x]);
  const back = decodePng(encodePng(img));
  assert.strictEqual(back.width, 3);
  assert.strictEqual(back.height, 2);
  assert.ok(back.rgba.equals(img.rgba));
});

test('every committed logo trims to a square that keeps its content extent', () => {
  const names = fs.readdirSync(LOGOS).filter((f) => f.endsWith('.png'));
  assert.ok(names.length >= 20, `expected the logo set, found ${names.length}`);
  for (const name of names) {
    const src = decodePng(fs.readFileSync(path.join(LOGOS, name)));
    const out = trimToSquare(src);
    const b = bbox(src);
    assert.strictEqual(out.width, out.height, `${name}: not square`);
    assert.strictEqual(out.width, Math.max(b.w, b.h), `${name}: side is not the content's longer edge`);
  }
});

const skip = chezmoiAvailable ? false : 'chezmoi not on PATH';

test('the Windows run script writes one trimmed logo per source logo', { skip }, () => {
  // The os gate renders the script empty off Windows, so render the body inside it.
  const body = fs.readFileSync(SCRIPT, 'utf8')
    .replace(/^\{\{ if eq \.chezmoi\.os "windows" -\}\}\n/, '')
    .replace(/\{\{ end -\}\}\n$/, '');
  const rendered = renderTemplate(body);
  assert.match(rendered, /^# generator: [0-9a-f]{64}$/m, 'the generator hash drives re-runs');
  assert.match(rendered, /^# Shape 1-white\.png: [0-9a-f]{64}$/m, 'each source logo hash drives re-runs');
  const home = scratch(os.tmpdir(), 'fastfetch-trim-');
  try {
    const res = spawnSync('bash', ['-c', rendered], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
    const out = path.join(home, '.config', 'fastfetch', 'logos-trimmed');
    const want = fs.readdirSync(LOGOS).filter((f) => f.endsWith('.png')).sort();
    assert.deepStrictEqual(fs.readdirSync(out).sort(), want);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
