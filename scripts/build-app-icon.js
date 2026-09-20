"use strict";

// Dependency-free Aidy app-icon generator.
//
// The brand geometry/rasterizer lives in src/desktop/brand-icon.js (the single
// source of truth, also used by the runtime tray icon in main.js). This file
// owns only the RGBA view, the PNG and ICO encoders, and the CLI. The
// rasterizer there returns BGRA; the encoders need RGBA, so we swap the
// channels once here. That keeps the emitted assets/icon.png and
// assets/icon.ico identical to what the tray icon draws at runtime.

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const { rasterizeBrandIcon } = require("../src/desktop/brand-icon");

// Swap BGRA (rasterizer native) to RGBA (what the PNG/ICO encoders expect).
function bgraToRgba(bgra) {
  const rgba = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
  }
  return rgba;
}

// RGBA view of the brand mark, matching the encoder contract. Mirrors the
// rasterizer's output (the channel swap is a bijection, so pixels are identical
// to the runtime tray raster).
function rasterizeIcon(size, supersample = 4) {
  return bgraToRgba(rasterizeBrandIcon(size, supersample));
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
  bgraToRgba,
  rasterizeIcon,
  rasterizeBrandIcon,
  crc32,
  pngChunk,
  encodePNG,
  buildBMP,
  encodeICO,
  buildAssets,
};
