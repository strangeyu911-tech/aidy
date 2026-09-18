"use strict";

// Dependency-free Aidy app-icon generator.
//
// The brand mark lives only as inline SVG strings in code (see
// src/desktop/main.js createTrayIcon()). To ship a real Windows executable
// icon we rasterize that same geometry to a 256x256 PNG and a multi-size ICO
// with a hand-rolled, deterministic rasterizer + PNG/ICO encoders. No image
// library is used (sharp/png-to-ico/jimp/etc. are intentionally not added).

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Brand geometry (canonical, mirrors createTrayIcon() in src/desktop/main.js)
// Drawn in a 32x32 user-unit coordinate space; shapes paint in table order.
// ---------------------------------------------------------------------------
const USER_SPACE = 32;
const GREEN = [0x31, 0x5d, 0x52, 255]; // #315d52
const YELLOW = [0xf7, 0xd9, 0x8b, 255]; // #f7d98b
const TRANSPARENT = [0, 0, 0, 0];

// Cubic Bezier for the smile, in absolute user coordinates:
//   M12 19 c2.7 1.7 5.3 1.7 8 0
const SMILE = {
  p0: [12, 19],
  p1: [14.7, 20.7],
  p2: [17.3, 20.7],
  p3: [20, 19],
  halfWidth: 0.75, // stroke-width 1.5 / 2
};

function buildSmilePoints(segments = 64) {
  const { p0, p1, p2, p3 } = SMILE;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    pts.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return pts;
}

const SMILE_POINTS = buildSmilePoints(64);

function roundRectContains(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function circleContains(px, py, cx, cy, r) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.min(Math.max(t, 0), 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function smileContains(ux, uy) {
  // Tight bounding box rejects the vast majority of samples cheaply.
  if (ux < 11 || ux > 21 || uy < 18 || uy > 21.5) return false;
  let best = Infinity;
  for (let i = 0; i < SMILE_POINTS.length - 1; i++) {
    const p = SMILE_POINTS[i];
    const q = SMILE_POINTS[i + 1];
    const d = distanceToSegment(ux, uy, p[0], p[1], q[0], q[1]);
    if (d < best) best = d;
    if (best <= SMILE.halfWidth) return true;
  }
  return best <= SMILE.halfWidth;
}

// Paint a single user-space point; returns the topmost covering shape's RGBA.
function paintPoint(ux, uy) {
  let color = null;
  if (roundRectContains(ux, uy, 0, 0, USER_SPACE, USER_SPACE, 9)) color = GREEN;
  if (roundRectContains(ux, uy, 8, 8, 16, 16, 3.5)) color = YELLOW; // cat head
  if (circleContains(ux, uy, 13, 15, 1.6)) color = GREEN; // left eye
  if (circleContains(ux, uy, 19, 15, 1.6)) color = GREEN; // right eye
  if (smileContains(ux, uy)) color = GREEN; // smile
  return color || TRANSPARENT;
}

// ---------------------------------------------------------------------------
// Rasterizer: supersample `supersample` x `supersample` per output pixel and
// average per-sample RGBA so edges anti-alias and rounded corners stay clear.
// Returns a Buffer of size*size*4 bytes (RGBA, top-left origin).
// ---------------------------------------------------------------------------
function rasterizeIcon(size, supersample = 4) {
  const out = Buffer.alloc(size * size * 4);
  const total = supersample * supersample;
  const scale = USER_SPACE / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < supersample; sy++) {
        const uy = (py + (sy + 0.5) / supersample) * scale;
        for (let sx = 0; sx < supersample; sx++) {
          const ux = (px + (sx + 0.5) / supersample) * scale;
          const c = paintPoint(ux, uy);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
        }
      }
      const idx = (py * size + px) * 4;
      out[idx] = Math.round(r / total);
      out[idx + 1] = Math.round(g / total);
      out[idx + 2] = Math.round(b / total);
      out[idx + 3] = Math.round(a / total);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG encoder (filter byte 0 per row, zlib.deflateSync for IDAT).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    raw[off] = 0; // filter: none
    rgba.copy(raw, off + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO encoder: classic 32bpp BMP entries (BITMAPINFOHEADER with
// biHeight = 2*height, BGRA rows stored bottom-up, plus an all-zero 1bpp AND
// mask whose rows are padded to 4 bytes). The alpha channel carries
// transparency, which is why an all-zero AND mask is acceptable.
// ---------------------------------------------------------------------------
function buildBMP(width, height, rgba) {
  const xor = Buffer.alloc(width * height * 4);
  // Store bottom-up: row y (top origin) lands at (height-1-y).
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 4;
    const dstRow = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const andRowBytes = Math.ceil(width / 32) * 4;
  const andMask = Buffer.alloc(andRowBytes * height, 0); // all zero => opaque

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4); // biWidth
  header.writeInt32LE(height * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(0, 20); // biSizeImage
  header.writeUInt32LE(0, 24); // biXPelsPerMeter
  header.writeUInt32LE(0, 28); // biYPelsPerMeter
  header.writeUInt32LE(0, 32); // biClrUsed
  header.writeUInt32LE(0, 36); // biClrImportant

  return Buffer.concat([header, xor, andMask]);
}

function encodeICO(sizes, supersample = 4) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(sizes.length, 4); // count

  const entries = [];
  const images = [];
  let offset = 6 + sizes.length * 16;

  for (const size of sizes) {
    const rgba = rasterizeIcon(size, supersample);
    const bmp = buildBMP(size, size, rgba);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // bWidth (0 means 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // bHeight
    entry.writeUInt8(0, 2); // bColorCount
    entry.writeUInt8(0, 3); // bReserved
    entry.writeUInt16LE(1, 4); // wPlanes
    entry.writeUInt16LE(32, 6); // wBitCount
    entry.writeUInt32LE(bmp.length, 8); // dwBytesInRes
    entry.writeUInt32LE(offset, 12); // dwImageOffset
    entries.push(entry);
    images.push(bmp);
    offset += bmp.length;
  }

  return Buffer.concat([dir, ...entries, ...images]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function buildAssets({ pngPath, icoPath, sizes, supersample, size } = {}) {
  const assetsDir = path.join(__dirname, "..", "assets");
  pngPath = pngPath || path.join(assetsDir, "icon.png");
  icoPath = icoPath || path.join(assetsDir, "icon.ico");
  sizes = sizes || [16, 32, 48, 64, 128, 256];
  supersample = supersample || 4;
  size = size || 256;

  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  const png = encodePNG(rasterizeIcon(size, supersample), size, size);
  const ico = encodeICO(sizes, supersample);
  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(icoPath, ico);

  return { pngPath, pngBytes: png.length, icoPath, icoBytes: ico.length, sizes };
}

if (require.main === module) {
  const result = buildAssets();
  console.log(`Aidy app icon generated`);
  console.log(`  PNG : ${result.pngPath} (${result.pngBytes} bytes, 256x256 RGBA)`);
  console.log(`  ICO : ${result.icoPath} (${result.icoBytes} bytes)`);
  console.log(`  ICO entry sizes (px): ${result.sizes.join(", ")}`);
}

module.exports = {
  USER_SPACE,
  GREEN,
  YELLOW,
  TRANSPARENT,
  buildSmilePoints,
  roundRectContains,
  circleContains,
  distanceToSegment,
  smileContains,
  paintPoint,
  rasterizeIcon,
  crc32,
  pngChunk,
  encodePNG,
  buildBMP,
  encodeICO,
  buildAssets,
};
