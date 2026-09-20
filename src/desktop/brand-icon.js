"use strict";

// Pure, dependency-free Aidy brand-icon rasterizer.
//
// This is the single source of truth for the brand mark geometry. It is
// required by both:
//   - scripts/build-app-icon.js (build time, to emit assets/icon.png + .ico),
//   - src/desktop/main.js (runtime, to raster the tray icon from a bitmap when
//     nativeImage cannot decode the inline SVG).
//
// It must stay free of `fs`, `electron`, and any other runtime-only module so
// it can be required from a plain Node build script AND shipped inside the
// packaged asar (build.files ships src/**/*).
//
// rasterizeBrandIcon() returns raw BGRA, which is exactly the channel order
// nativeImage.createFromBitmap expects. Callers that need RGBA (the PNG/ICO
// encoders) swap the channels themselves.
//
// The brand mark is a solid rounded-rectangle in the Aidy brand green
// (#315d52) with reverse (yellow #f7d98b) "AD" letters drawn geometrically as
// supersampled strokes/arcs, so it is crisp at both 16x16 and 256x256.

const BRAND_ICON_UNITS = 32;

// Colours as [R, G, B, A] (logical order); the output buffer is written BGRA.
const GREEN = [0x31, 0x5d, 0x52, 255]; // #315d52
const YELLOW = [0xf7, 0xd9, 0x8b, 255]; // #f7d98b
const TRANSPARENT = [0, 0, 0, 0];

const STROKE = 1.6; // half stroke width in user units (~1.6px at 16px, ~12.8px at 256px)
const RADIUS = 9; // rounded-rect corner radius in user units

// Letter geometry, in user-space coordinates (origin top-left, 0..32).
// "A": two legs meeting near the top plus a crossbar.
// "D": a vertical stem plus a right-facing elliptical bowl.
const STROKES = [
  // A left leg
  [8.0, 25.5, 11.0, 7.0],
  // A right leg
  [15.0, 25.5, 12.0, 7.0],
  // A crossbar
  [9.4, 17.0, 13.6, 17.0],
  // D stem
  [19.5, 7.0, 19.5, 25.5],
];

// D bowl: right half of an ellipse, sampled as a polyline.
const BOWL = (() => {
  const cx = 19.5;
  const cy = 16.25;
  const rx = 7.0;
  const ry = 9.25;
  const pts = [];
  const N = 64;
  for (let i = 0; i <= N; i++) {
    const t = -Math.PI / 2 + Math.PI * (i / N); // -90deg .. +90deg
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
})();

function roundRectContains(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
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

function inLetter(ux, uy) {
  for (let i = 0; i < STROKES.length; i++) {
    const s = STROKES[i];
    if (distanceToSegment(ux, uy, s[0], s[1], s[2], s[3]) <= STROKE) return true;
  }
  for (let i = 0; i < BOWL.length - 1; i++) {
    const p = BOWL[i];
    const q = BOWL[i + 1];
    if (distanceToSegment(ux, uy, p[0], p[1], q[0], q[1]) <= STROKE) return true;
  }
  return false;
}

// Paint a single user-space point; returns the topmost covering shape's RGBA.
function paintPoint(ux, uy) {
  if (!roundRectContains(ux, uy, 0, 0, BRAND_ICON_UNITS, BRAND_ICON_UNITS, RADIUS)) {
    return TRANSPARENT;
  }
  if (inLetter(ux, uy)) return YELLOW;
  return GREEN;
}

// Supersample `supersample` x `supersample` per output pixel and average
// per-sample RGBA so edges anti-alias and the rounded corners stay clear.
// Returns a raw BGRA Buffer of size*size*4 bytes (top-left origin).
function rasterizeBrandIcon(size, supersample = 4) {
  const out = Buffer.alloc(size * size * 4);
  const total = supersample * supersample;
  const scale = BRAND_ICON_UNITS / size;
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
      // BGRA: blue channel first, as nativeImage.createFromBitmap expects.
      out[idx] = Math.round(b / total);
      out[idx + 1] = Math.round(g / total);
      out[idx + 2] = Math.round(r / total);
      out[idx + 3] = Math.round(a / total);
    }
  }
  return out;
}

module.exports = {
  BRAND_ICON_UNITS,
  GREEN,
  YELLOW,
  TRANSPARENT,
  STROKE,
  RADIUS,
  STROKES,
  BOWL,
  roundRectContains,
  distanceToSegment,
  inLetter,
  paintPoint,
  rasterizeBrandIcon,
};
