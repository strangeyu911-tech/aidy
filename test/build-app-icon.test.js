"use strict";

const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const test = require("node:test");

const {
  rasterizeIcon,
  encodePNG,
  encodeICO,
  crc32,
  pngChunk,
} = require("../scripts/build-app-icon");

const SIZE = 256;

function pixelAt(rgba, x, y) {
  const i = (y * SIZE + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

test("rasterizer returns exactly width*height*4 bytes", () => {
  const buf = rasterizeIcon(SIZE, 4);
  assert.equal(buf.length, SIZE * SIZE * 4);
  assert.equal(buf.length, 256 * 256 * 4);
});

test("four corners are fully transparent (rounded corner r=9/32 stays clear)", () => {
  const buf = rasterizeIcon(SIZE, 4);
  for (const [x, y] of [[0, 0], [SIZE - 1, 0], [0, SIZE - 1], [SIZE - 1, SIZE - 1]]) {
    const [r, g, b, a] = pixelAt(buf, x, y);
    assert.equal(a, 0, `corner (${x},${y}) should be transparent, got alpha ${a}`);
    assert.deepEqual([r, g, b, a], [0, 0, 0, 0], `corner (${x},${y}) must be fully transparent`);
  }
});

test("centre pixel is opaque cat-head yellow #f7d98b", () => {
  const buf = rasterizeIcon(SIZE, 4);
  const [r, g, b, a] = pixelAt(buf, SIZE >> 1, SIZE >> 1);
  assert.equal(a, 255, "centre must be opaque");
  assert.deepEqual([r, g, b], [0xf7, 0xd9, 0x8b], "centre must be cat-head yellow #f7d98b");
});

test("a pixel inside the green surround near the top edge is #315d52", () => {
  const buf = rasterizeIcon(SIZE, 4);
  // Near the top edge centre, clearly inside the outer green rounded rect but
  // outside the cat-head square.
  const [r, g, b, a] = pixelAt(buf, SIZE >> 1, 4);
  assert.equal(a, 255, "green surround must be opaque");
  assert.deepEqual([r, g, b], [0x31, 0x5d, 0x52], "surround must be green #315d52");
});

test("PNG output has the signature and an IHDR declaring 256x256 bd8 ct6", () => {
  const png = encodePNG(rasterizeIcon(SIZE, 4), SIZE, SIZE);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.subarray(0, 8).equals(sig), "must start with the 8-byte PNG signature");
  // First chunk is IHDR at offset 8: length(4) + type(4) + 13 data bytes.
  assert.equal(png.readUInt32BE(8), 13, "IHDR length must be 13");
  assert.equal(png.toString("ascii", 12, 16), "IHDR", "first chunk must be IHDR");
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  assert.equal(w, 256, "IHDR width must be 256");
  assert.equal(h, 256, "IHDR height must be 256");
  assert.equal(bitDepth, 8, "IHDR bit depth must be 8");
  assert.equal(colorType, 6, "IHDR colour type must be 6 (RGBA)");
});

test("ICO declares type 1 and exactly 6 entries; the 256px entry uses width byte 0", () => {
  const ico = encodeICO([16, 32, 48, 64, 128, 256], 4);
  assert.equal(ico.readUInt16LE(0), 0, "ICONDIR reserved must be 0");
  assert.equal(ico.readUInt16LE(2), 1, "ICONDIR type must be 1 (icon)");
  assert.equal(ico.readUInt16LE(4), 6, "ICONDIR must declare 6 images");

  const widthBytes = [];
  let zeroWidthEntry = null;
  for (let i = 0; i < 6; i++) {
    const off = 6 + i * 16;
    const bWidth = ico[off];
    const bytesInRes = ico.readUInt32LE(off + 8);
    const imageOffset = ico.readUInt32LE(off + 12);
    widthBytes.push(bWidth);
    if (bWidth === 0) {
      zeroWidthEntry = { bytesInRes, imageOffset };
    }
    assert.ok(bytesInRes > 0, `entry ${i} must have non-zero size`);
    assert.ok(imageOffset > 0, `entry ${i} must have non-zero offset`);
  }
  // The 256px entry is encoded with a width byte of 0.
  assert.ok(zeroWidthEntry, "exactly one entry should use width byte 0 (=> 256px)");
  assert.equal(zeroWidthEntry.bytesInRes > 0, true);
  assert.equal(zeroWidthEntry.imageOffset > 0, true);
  assert.deepEqual(widthBytes.filter((b) => b === 0).length, 1, "only the 256 entry uses byte 0");
});

test("PNG round-trips back to the original pixels through inflate + CRC32", () => {
  const original = rasterizeIcon(SIZE, 4);
  const png = encodePNG(original, SIZE, SIZE);

  // Walk chunks, find IHDR and IDAT.
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    const storedCrc = png.readUInt32BE(off + 8 + len);
    assert.equal(crc32(Buffer.concat([png.subarray(off + 4, off + 8), data])), storedCrc, `CRC mismatch for chunk ${type}`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off = off + 8 + len + 4; // length + type + data + crc
  }

  assert.equal(width, SIZE);
  assert.equal(height, SIZE);
  assert.equal(colorType, 6);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  // Raw scanlines: one filter byte (0) per row, then width*4 RGBA bytes.
  const stride = width * 4 + 1;
  assert.equal(raw.length, stride * height);
  const decoded = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, "filter byte must be 0 (None)");
    raw.copy(decoded, y * width * 4, y * stride + 1, y * stride + 1 + width * 4);
  }
  assert.ok(decoded.equals(original), "decoded pixels must match the rasterized buffer exactly");
});

// Guard against silent CRC32 regressions.
test("crc32 is correct for a known vector", () => {
  // CRC-32 of "IEND" (type-only, no data) used by the IEND chunk body is
  // 0xAE426082. Verify our implementation matches the well-known CRC of "123456789".
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

// Ensure the chunk helper is exported and self-consistent (used by the ICO-less path).
test("pngChunk helper produces length+type+data+crc", () => {
  const chunk = pngChunk("tEXt", Buffer.from("hi"));
  assert.equal(chunk.readUInt32BE(0), 2);
  assert.equal(chunk.toString("ascii", 4, 8), "tEXt");
  assert.ok(chunk.subarray(8, 10).equals(Buffer.from("hi")));
  assert.equal(chunk.length, 4 + 4 + 2 + 4);
});

module.exports = { pixelAt };
