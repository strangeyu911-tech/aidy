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

const BRAND_ICON_UNITS = 32;

// Colours as [R, G, B, A] (logical order); the output buffer is written BGRA.
const GREEN = [0x31, 0x5d, 0x52, 255]; // #315d52
const YELLOW = [0xf7, 0xd9, 0x8b, 255]; // #f7d98b
const TRANSPARENT = [0, 0, 0, 0];

// Smile: cubic Bezier in absolute user coordinates, `M12 19 c2.7 1.7 5.3 1.7 8 0`.
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
  if (roundRectContains(ux, uy, 0, 0, BRAND_ICON_UNITS, BRAND_ICON_UNITS, 9)) color = GREEN;
  if (roundRectContains(ux, uy, 8, 8, 16, 16, 3.5)) color = YELLOW; // cat head
  if (circleContains(ux, uy, 13, 15, 1.6)) color = GREEN; // left eye
  if (circleContains(ux, uy, 19, 15, 1.6)) color = GREEN; // right eye
  if (smileContains(ux, uy)) color = GREEN; // smile
  return color || TRANSPARENT;
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
  SMILE,
  buildSmilePoints,
  roundRectContains,
  circleContains,
  distanceToSegment,
  smileContains,
  paintPoint,
  rasterizeBrandIcon,
};
