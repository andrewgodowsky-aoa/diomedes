// Draws the Diomedes mark (client/console/Mark.tsx) as the Windows app icon,
// desktop/diomedes.ico, which scripts/package-desktop.mjs embeds in Diomedes.exe.
//
// No dependencies: every size is drawn from the mark's own geometry with distance-based
// anti-aliasing, so 16 and 24 px stay legible instead of being shrunk from one large
// bitmap. Run `node scripts/app-icon.mjs` after changing the mark or the palette;
// tests/app-icon.test.ts fails while the committed icon differs from this drawing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

/** The mark as Mark.tsx and wake.css draw it, in its 24-unit viewBox. */
export const MARK = {
  line: [5, 3, 5, 21],
  path: 'M5 3 C 14 3, 18 7.5, 18 12 C 18 16.5, 14 20.2, 9 21',
  point: [20.5, 12, 1.6],
  stroke: 1.6,
};

/** The default `field` package: chrome behind the mark, t1 strokes, t2 point. */
export const PALETTE = { chrome: '#121417', t1: '#e6e9ed', t2: '#a4acb6' };

/** Sizes the Windows shell asks for across display scales, up to Explorer's 256 px. */
export const ICON_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];

const hex = (color) => {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

function parseCubics(d) {
  const tokens = d.match(/[MC]|-?\d*\.?\d+/g) ?? [];
  const pair = (index) => [Number(tokens[index]), Number(tokens[index + 1])];
  const cubics = [];
  let current = null;
  for (let index = 0; index < tokens.length; ) {
    if (tokens[index] === 'M') {
      current = pair(index + 1);
      index += 3;
    } else if (tokens[index] === 'C' && current) {
      const cubic = [current, pair(index + 1), pair(index + 3), pair(index + 5)];
      cubics.push(cubic);
      current = cubic[3];
      index += 7;
    } else {
      throw new Error(`The mark path uses an unsupported command: ${tokens[index]}`);
    }
  }
  return cubics;
}

function flatten(cubics, steps = 64) {
  const points = [cubics[0][0]];
  for (const [p0, p1, p2, p3] of cubics) {
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      points.push([
        w[0] * p0[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * p3[0],
        w[0] * p0[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * p3[1],
      ]);
    }
  }
  return points;
}

const CURVE = flatten(parseCubics(MARK.path));

/** Where the mark lands on a `size` px canvas, with its stroke weighted for that size. */
function iconLayout(size) {
  const [shaftX, shaftTop, , shaftBottom] = MARK.line;
  const [uiPointX, pointY, uiRadius] = MARK.point;
  // Heavier than the UI's 1.6 of 24 so the mark survives 16 px; the share of the
  // canvas the mark fills shrinks as the canvas grows.
  const stroke = 0.8 + size * 0.058;
  const heightShare = Math.min(0.68, Math.max(0.58, 0.58 + (64 - size) / 480));
  const scale = (heightShare * size - stroke) / (shaftBottom - shaftTop);
  const grow = stroke / scale / MARK.stroke;
  const strokeUnits = MARK.stroke * grow;
  // Keep the UI's relation between the D and its point as the stroke grows: the
  // radius tracks the stroke and the point sits the same scaled gap ahead of the curve.
  const curveRight = Math.max(...CURVE.map(([x]) => x));
  const uiGap = uiPointX - uiRadius - (curveRight + MARK.stroke / 2);
  const radiusUnits = uiRadius * grow;
  const pointX = curveRight + strokeUnits / 2 + uiGap * grow + radiusUnits;
  const left = shaftX - strokeUnits / 2;
  const top = shaftTop - strokeUnits / 2;
  let originX = size / 2 - ((left + pointX + radiusUnits) / 2) * scale;
  let originY = size / 2 - ((top + shaftBottom + strokeUnits / 2) / 2) * scale;
  if (size <= 48) {
    // Put the shaft's outer edge and the D's top on whole pixels at small sizes.
    originX += Math.round(originX + left * scale) - (originX + left * scale);
    originY += Math.round(originY + top * scale) - (originY + top * scale);
  }
  const toPixels = ([x, y]) => [originX + x * scale, originY + y * scale];
  const margin = size <= 24 ? 0 : Math.round(size * 0.03);
  return {
    stroke,
    shaft: [toPixels([shaftX, shaftTop]), toPixels([shaftX, shaftBottom])],
    curve: CURVE.map(toPixels),
    point: [...toPixels([pointX, pointY]), radiusUnits * scale],
    tile: {
      half: size / 2 - margin,
      radius: (size / 2 - margin) * 0.44,
      border: Math.max(1, size / 128),
    },
  };
}

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

function roundedSquareDistance(px, py, center, half, radius) {
  const qx = Math.abs(px - center) - half + radius;
  const qy = Math.abs(py - center) - half + radius;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

// A one-pixel linear ramp across the signed edge distance.
const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Straight-alpha RGBA pixels of the icon at `size` px, row by row from the top. */
export function renderIcon(size) {
  const layout = iconLayout(size);
  const chrome = hex(PALETTE.chrome);
  const t1 = hex(PALETTE.t1);
  const t2 = hex(PALETTE.t2);
  const [cx, cy, radius] = layout.point;
  const { half, radius: corner, border } = layout.tile;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Premultiplied source-over: the tile, its faint rim, the strokes, then the point.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const over = ([cr, cg, cb], alpha) => {
        if (alpha <= 0) return;
        r = cr * alpha + r * (1 - alpha);
        g = cg * alpha + g * (1 - alpha);
        b = cb * alpha + b * (1 - alpha);
        a = alpha + a * (1 - alpha);
      };
      const edge = roundedSquareDistance(px, py, size / 2, half, corner);
      const inside = coverage(edge);
      over(chrome, inside);
      over(t1, coverage(Math.abs(edge + border / 2) - border / 2) * inside * 0.12);
      let distance = segmentDistance(px, py, layout.shaft[0], layout.shaft[1]);
      for (let index = 1; index < layout.curve.length; index += 1)
        distance = Math.min(
          distance,
          segmentDistance(px, py, layout.curve[index - 1], layout.curve[index]),
        );
      over(t1, coverage(distance - layout.stroke / 2));
      const dx = px - cx;
      const dy = py - cy;
      over(t2, coverage(Math.sqrt(dx * dx + dy * dy) - radius));
      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.min(255, Math.round(r / a));
        rgba[offset + 1] = Math.min(255, Math.round(g / a));
        rgba[offset + 2] = Math.min(255, Math.round(b / a));
      }
      rgba[offset + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const frame = Buffer.alloc(8);
  frame.writeUInt32BE(data.length, 0);
  frame.writeUInt32BE(crc32(body), 4);
  return Buffer.concat([frame.subarray(0, 4), body, frame.subarray(4)]);
}

/** An 8-bit RGBA PNG with no scanline filtering. */
function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 32-bit bottom-up DIB with its AND mask, as ICO entries below 256 px expect. */
function encodeDib(rgba, size) {
  const maskStride = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4 + maskStride * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y += 1) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = (row * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

/** Every size in ICON_SIZES: DIB entries below 256 px, PNG at 256 px. */
export function buildIco() {
  const images = ICON_SIZES.map((size) => {
    const rgba = renderIcon(size);
    return { size, data: size >= 256 ? encodePng(rgba, size) : encodeDib(rgba, size) };
  });
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    directory[entry] = size >= 256 ? 0 : size;
    directory[entry + 1] = size >= 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...images.map(({ data }) => data)]);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const out = fileURLToPath(new URL('../desktop/diomedes.ico', import.meta.url));
  await fs.writeFile(out, buildIco());
  console.log(`Wrote ${out}`);
}
