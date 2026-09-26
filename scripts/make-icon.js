'use strict';

/**
 * Generates the app icon: a document dissolving into pixel blocks on the
 * brand gradient. Pure JS (pngjs), anti-aliased by supersampling.
 *
 *   node scripts/make-icon.js
 *
 * Writes build/icon.png (1024², used by electron-builder for .ico/.icns/Linux)
 * and src/assets/icon.png (512², window/taskbar icon and in-app logo).
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SIZE = 1024;
const SS = 4; // 4×4 supersampling

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const GRAD_A = hex('#7c6cff'); // top-left
const GRAD_B = hex('#3fc6e8'); // bottom-right
const PAPER = [1, 1, 1];

// Signed distance to a rounded rectangle (negative inside).
function sdRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - r;
  const hh = (y1 - y0) / 2 - r;
  const dx = Math.abs(x - cx) - hw;
  const dy = Math.abs(y - cy) - hh;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

// Background tile (macOS-style padding so it doesn't look oversized in the Dock).
const BG = { x0: 100, y0: 100, x1: 924, y1: 924, r: 185 };

// Document + pixel grid geometry.
const CELL = 88;
const GAP = 12;
const DOC_W = 4 * CELL + 3 * GAP; // 388
const DX0 = 512 - DOC_W / 2;
const DX1 = DX0 + DOC_W;
const DY0 = 196;
const DY1 = 536;
const FOLD = 118;
const DOC_R = 30;

// Pixel blocks below the page: [col, row, opacity]. Dissolves downward.
const BLOCKS = [
  [0, 0, 1], [1, 0, 1], [2, 0, 1], [3, 0, 0.92],
  [0, 1, 0.82], [2, 1, 0.78], [3, 1, 0.6],
  [1, 2, 0.5], [3, 2, 0.32],
];

function sample(x, y) {
  // Returns premultiplied [r, g, b, a].
  if (sdRoundRect(x, y, BG.x0, BG.y0, BG.x1, BG.y1, BG.r) > 0) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, ((x - BG.x0) + (y - BG.y0)) / (2 * (BG.x1 - BG.x0))));
  let c = GRAD_A.map((a, i) => a + (GRAD_B[i] - a) * t);
  // Soft top highlight.
  const hl = Math.max(0, 1 - (y - BG.y0) / 500) * 0.08;
  c = c.map((v) => v + (1 - v) * hl);

  const over = (col, alpha) => {
    c = c.map((v, i) => v * (1 - alpha) + col[i] * alpha);
  };

  // Drop shadow under the page.
  const sh = sdRoundRect(x, y - 14, DX0, DY0, DX1, DY1, DOC_R);
  const shCut = (x - (DX1 - FOLD)) - (y - 14 - DY0); // same fold cut as the page
  if (sh < 30 && shCut < 0) over([0.1, 0.08, 0.3], 0.18 * Math.min(1, (30 - sh) / 30, -shCut / 30));

  // Page with folded top-right corner.
  const inPage = sdRoundRect(x, y, DX0, DY0, DX1, DY1, DOC_R) <= 0;
  const cutLine = (x - (DX1 - FOLD)) - (y - DY0); // > 0 beyond the fold diagonal
  if (inPage && cutLine <= 0) over(PAPER, 1);
  // Fold flap: triangle below the diagonal inside the corner square.
  if (x >= DX1 - FOLD && y <= DY0 + FOLD && cutLine <= 0 && x - (DX1 - FOLD) >= 0) {
    const fx = x - (DX1 - FOLD);
    const fy = y - DY0;
    if (fy >= fx - 0.5) over([0.84, 0.86, 0.95], 1);
  }

  // Pixel blocks.
  for (const [col, row, a] of BLOCKS) {
    const bx0 = DX0 + col * (CELL + GAP);
    const by0 = DY1 + GAP + row * (CELL + GAP);
    if (sdRoundRect(x, y, bx0, by0, bx0 + CELL, by0 + CELL, 14) <= 0) over(PAPER, a);
  }
  return [c[0], c[1], c[2], 1];
}

function render(size) {
  const png = new PNG({ width: size, height: size });
  const scale = SIZE / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = sample((px + (sx + 0.5) / SS) * scale, (py + (sy + 0.5) / SS) * scale);
          r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
        }
      }
      const i = (py * size + px) * 4;
      const n = SS * SS;
      png.data[i] = a ? Math.round((r / a) * 255) : 0;
      png.data[i + 1] = a ? Math.round((g / a) * 255) : 0;
      png.data[i + 2] = a ? Math.round((b / a) * 255) : 0;
      png.data[i + 3] = Math.round((a / n) * 255);
    }
  }
  return PNG.sync.write(png);
}

const root = path.join(__dirname, '..');
for (const [file, size] of [['build/icon.png', 1024], ['src/assets/icon.png', 512]]) {
  const out = path.join(root, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, render(size));
  console.log(`wrote ${file} (${size}×${size})`);
}
