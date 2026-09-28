#!/usr/bin/env node
'use strict';
// trim-logos — derive the Windows fastfetch logo set from the shared one.
//
//   node trim-logos.js <source-dir> <output-dir>
//
// Windows draws the logo through the iTerm image protocol into a fixed 24x12-cell box, so
// each shape has to fill the box the same way. For every *.png in <source-dir> this crops to
// the non-transparent bounding box, then centres the crop on a transparent square canvas
// whose side is the crop's longer edge. Nothing is scaled, so nothing goes grainy.
//
// The run_onchange script under home/.chezmoiscripts/os-windows/ runs this from the source
// tree at apply time. Until #694 the output was committed as a second set of 21 PNGs.
//
// Pixel mapping, kept so the generated set is pixel-identical to the committed set it
// replaced: a source pixel (grey g, alpha a) becomes (g*a/255, g*a/255, g*a/255, a*a/255),
// each rounded. That is the source premultiplied by its own alpha with alpha applied twice,
// which is what the tool that produced the committed set did. It darkens the antialiased
// edge slightly; changing it is a visible change to the Windows logo, not a refactor.
//
// Handles what the source set is: 8-bit, non-interlaced PNG in grey, grey+alpha, RGB or
// RGBA. Anything else is refused rather than guessed at. No dependencies beyond node itself.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// PNG bytes -> { width, height, rgba } with rgba a Buffer of width*height*4.
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  let hdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      hdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], ctype: data[9], interlace: data[12] };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!hdr) throw new Error('no IHDR chunk');
  const ch = CHANNELS[hdr.ctype];
  if (hdr.depth !== 8 || hdr.interlace !== 0 || !ch) {
    throw new Error(`unsupported PNG: depth ${hdr.depth}, colour type ${hdr.ctype}, interlace ${hdr.interlace}`);
  }
  const { width, height } = hdr;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let p;
      switch (filter) {
        case 0: p = 0; break;
        case 1: p = a; break;
        case 2: p = b; break;
        case 3: p = (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad filter type ${filter} on row ${y}`);
      }
      cur[x] = (raw[base + 1 + x] + p) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * ch;
      if (ch <= 2) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[s];
        rgba[o + 3] = ch === 2 ? cur[s + 1] : 255;
      } else {
        rgba[o] = cur[s]; rgba[o + 1] = cur[s + 1]; rgba[o + 2] = cur[s + 2];
        rgba[o + 3] = ch === 4 ? cur[s + 3] : 255;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// { width, height, rgba } -> 8-bit RGBA PNG bytes, filter 0 on every row.
function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Crop to the alpha>0 bounding box, centre on a square transparent canvas, map each pixel.
function trimToSquare({ width, height, rgba }) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('image is fully transparent');
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const side = Math.max(w, h);
  const dx = Math.floor((side - w) / 2);
  const dy = Math.floor((side - h) / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y + y0) * width + (x + x0)) * 4;
      const o = ((y + dy) * side + (x + dx)) * 4;
      const a = rgba[s + 3];
      for (let k = 0; k < 3; k++) out[o + k] = Math.round((rgba[s + k] * a) / 255);
      out[o + 3] = Math.round((a * a) / 255);
    }
  }
  return { width: side, height: side, rgba: out };
}

function main(argv) {
  const [srcDir, outDir] = argv;
  if (!srcDir || !outDir) {
    process.stderr.write('usage: trim-logos.js <source-dir> <output-dir>\n');
    return 2;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const names = fs.readdirSync(srcDir).filter((f) => f.endsWith('.png')).sort();
  for (const name of names) {
    const img = trimToSquare(decodePng(fs.readFileSync(path.join(srcDir, name))));
    fs.writeFileSync(path.join(outDir, name), encodePng(img));
  }
  process.stdout.write(`trim-logos: wrote ${names.length} logo(s) to ${outDir}\n`);
  return 0;
}

module.exports = { decodePng, encodePng, trimToSquare };

if (require.main === module) process.exit(main(process.argv.slice(2)));
