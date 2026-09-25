// Draws the Nectovia mark as the Windows app icon, desktop/diomedes.ico. The file keeps its
// old name because scripts/package-desktop.mjs embeds it in nectovia.exe by that name, and
// the installer that scripts/build-windows-installer.mjs writes shows it for itself and its
// uninstaller.
//
// The drawing is the site's 24-unit favicon (diomedes-site public/favicon.svg): an ink tile
// under NectoviaMark.tsx's three plates and cyan lead seam, with the violet trail seam added
// once the mark is drawn larger than 18 px, as NectoviaMark.tsx adds it. A seam is a line,
// not a plate: at every size it is 1.2 to 3 px wide, the rule the site's own icon rasters
// follow (diomedes-site scripts/og.mjs), so it neither fades at 16 px nor swells at 256 px.
//
// No dependencies: every size is drawn from that geometry with supersampled coverage, so 16
// and 24 px stay legible instead of being shrunk from one large bitmap. Run
// `node scripts/app-icon.mjs` after changing the mark or the palette; tests/app-icon.test.ts
// fails while the committed icon differs from this drawing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

/** The mark in its 24-unit viewBox: the favicon's tile, NectoviaMark.tsx's plates and seams. */
export const MARK = {
  tile: { size: 24, radius: 5 },
  plates: [
    {
      tone: 'bone',
      points: [
        [3, 3],
        [7.6, 3],
        [7.6, 21],
        [3, 21],
      ],
    },
    {
      tone: 'graphite',
      points: [
        [8.9, 3],
        [12.9, 3],
        [15.3, 21],
        [11.3, 21],
      ],
    },
    {
      tone: 'bone',
      points: [
        [16.5, 3],
        [21, 3],
        [21, 21],
        [16.5, 21],
      ],
    },
  ],
  lead: [8.5, 3.4, 9.8, 12.6],
  trail: [21.9, 15.5, 21.9, 21],
  /** At this size and below the trail seam is left out, as NectoviaMark.tsx leaves it out. */
  trailMinSize: 18,
};

/** The favicon's paint: the ink tile, bone and graphite plates, the cyan lead, the violet trail. */
export const PALETTE = {
  ink: '#08080c',
  bone: '#f2f0ea',
  graphite: '#808b97',
  lead: '#44d2c9',
  trail: '#b569fb',
};

/** Sizes the Windows shell asks for across display scales, up to Explorer's 256 px. */
export const ICON_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];

/** A seam's width in pixels where the 24-unit mark is drawn `size` px wide. */
export const seamPixels = (size) => Math.min(3, Math.max(1.2, size * 0.022));

const hex = (color) => {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/**
 * A convex polygon as the signed distance to its nearest edge line: negative inside. Outside
 * it never exceeds the true distance, so it can only under-report how far away a pixel is.
 */
function convexShape(points, color) {
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const edges = points.map(([ax, ay], index) => {
    const [bx, by] = points[(index + 1) % points.length];
    const length = Math.hypot(bx - ax, by - ay);
    let nx = (by - ay) / length;
    let ny = (ax - bx) / length;
    // Every normal points away from the centre, whichever way the points wind.
    if (nx * (cx - ax) + ny * (cy - ay) > 0) [nx, ny] = [-nx, -ny];
    return [nx, ny, nx * ax + ny * ay];
  });
  return {
    color,
    distance: (x, y) => {
      let distance = -Infinity;
      for (const [nx, ny, offset] of edges) distance = Math.max(distance, nx * x + ny * y - offset);
      return distance;
    },
  };
}

/** A stroked line with butt caps, as SVG draws `<line>`: the rectangle around the segment. */
function seamShape([x1, y1, x2, y2], width, color) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const nx = ((y2 - y1) / length) * (width / 2);
  const ny = ((x1 - x2) / length) * (width / 2);
  return convexShape(
    [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ],
    color,
  );
}

/** The rounded square tile, as an exact signed distance. */
function tileShape(size, radius, color) {
  const half = size / 2;
  return {
    color,
    distance: (x, y) => {
      const qx = Math.abs(x - half) - half + radius;
      const qy = Math.abs(y - half) - half + radius;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    },
  };
}

/** Where every shape lands on a `size` px canvas, in paint order. */
function iconShapes(size) {
  // Units times size over 24, in that order, so a half-pixel lands exactly on .5.
  const pixels = (units) => (units * size) / MARK.tile.size;
  // At 48 px and below the plates' outer left and top edges sit on whole pixels, rounding a
  // half down, so the small sizes keep crisp plate edges; the tile never moves.
  let shift = 0;
  if (size <= 48) {
    const edge = pixels(MARK.plates[0].points[0][0]);
    shift = Math.ceil(edge - 0.5) - edge;
  }
  const at = ([x, y]) => [pixels(x) + shift, pixels(y) + shift];
  const seam = ([x1, y1, x2, y2], color) =>
    seamShape([...at([x1, y1]), ...at([x2, y2])], seamPixels(size), hex(color));
  const shapes = [
    tileShape(size, pixels(MARK.tile.radius), hex(PALETTE.ink)),
    ...MARK.plates.map(({ tone, points }) => convexShape(points.map(at), hex(PALETTE[tone]))),
    seam(MARK.lead, PALETTE.lead),
  ];
  if (size > MARK.trailMinSize) shapes.push(seam(MARK.trail, PALETTE.trail));
  return shapes;
}

// Coverage from a 16 by 16 grid of samples in the pixel. A pixel whose centre is farther
// than half its diagonal from an edge is wholly inside or outside and is not sampled.
const SAMPLES = 16;
const HALF_DIAGONAL = Math.SQRT1_2;
function coverage(shape, x, y) {
  const centre = shape.distance(x + 0.5, y + 0.5);
  if (centre >= HALF_DIAGONAL) return 0;
  if (centre <= -HALF_DIAGONAL) return 1;
  let inside = 0;
  for (let j = 0; j < SAMPLES; j += 1)
    for (let i = 0; i < SAMPLES; i += 1)
      if (shape.distance(x + (i + 0.5) / SAMPLES, y + (j + 0.5) / SAMPLES) <= 0) inside += 1;
  return inside / (SAMPLES * SAMPLES);
}

/** Straight-alpha RGBA pixels of the icon at `size` px, row by row from the top. */
export function renderIcon(size) {
  const shapes = iconShapes(size);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Premultiplied source-over in document order: the tile, the plates, then the seams.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const shape of shapes) {
        const alpha = coverage(shape, x, y);
        if (alpha <= 0) continue;
        const [cr, cg, cb] = shape.color;
        r = cr * alpha + r * (1 - alpha);
        g = cg * alpha + g * (1 - alpha);
        b = cb * alpha + b * (1 - alpha);
        a = alpha + a * (1 - alpha);
      }
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
