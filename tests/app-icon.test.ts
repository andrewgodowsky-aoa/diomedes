import fs from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';

// Diomedes.exe carries the Console mark as its icon: scripts/app-icon.mjs draws it,
// desktop/diomedes.ico holds the drawing and scripts/package-desktop.mjs embeds it.
// Entries are compared as decoded pixels, so a different zlib cannot fail the check.
const appIcon = await import(new URL('../scripts/app-icon.mjs', import.meta.url).href);
const readText = (relative: string) =>
  fs.readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodeEntry(data: Buffer, size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const stride = size * 4;
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const idat: Buffer[] = [];
    for (let offset = 8; offset < data.length; ) {
      const length = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      const body = data.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR')
        expect([body.readUInt32BE(0), body.readUInt32BE(4), body[8], body[9]]).toEqual([
          size,
          size,
          8,
          6,
        ]);
      if (type === 'IDAT') idat.push(body);
      offset += length + 12;
    }
    // Every scanline is written unfiltered, so each row is one filter byte and its pixels.
    const raw = inflateSync(Buffer.concat(idat));
    for (let y = 0; y < size; y += 1)
      raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    return rgba;
  }
  expect([
    data.readUInt32LE(0),
    data.readInt32LE(4),
    data.readInt32LE(8),
    data.readUInt16LE(14),
  ]).toEqual([40, size, size * 2, 32]);
  for (let y = 0; y < size; y += 1) {
    // DIB rows run bottom-up in BGRA order.
    const row = 40 + (size - 1 - y) * stride;
    for (let x = 0; x < stride; x += 4) {
      rgba[y * stride + x] = data[row + x + 2];
      rgba[y * stride + x + 1] = data[row + x + 1];
      rgba[y * stride + x + 2] = data[row + x];
      rgba[y * stride + x + 3] = data[row + x + 3];
    }
  }
  return rgba;
}

it('draws the mark with the Console geometry and the field palette', async () => {
  const mark = (await readText('client/console/Mark.tsx')).replace(/\s+/g, ' ');
  const [x1, y1, x2, y2] = appIcon.MARK.line;
  const [cx, cy, r] = appIcon.MARK.point;
  expect(mark).toContain(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`);
  expect(mark).toContain(`<path d="${appIcon.MARK.path}" />`);
  expect(mark).toContain(`<circle cx="${cx}" cy="${cy}" r="${r}"`);
  expect(await readText('client/console/wake.css')).toContain(
    `stroke-width: ${appIcon.MARK.stroke};`,
  );
  const field = (await readText('client/styles.css')).split("html[data-package='field'] {")[1];
  const block = field?.slice(0, field.indexOf('}')) ?? '';
  for (const [token, value] of Object.entries(appIcon.PALETTE))
    expect(block).toContain(`--${token}: ${value};`);
});

it('keeps the committed icon identical to the drawing at every size', async () => {
  const ico = await fs.readFile(new URL('../desktop/diomedes.ico', import.meta.url));
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
  const sizes: number[] = [];
  for (let index = 0; index < ico.readUInt16LE(4); index += 1) {
    const entry = 6 + 16 * index;
    const size = ico[entry] || 256;
    const start = ico.readUInt32LE(entry + 12);
    const data = ico.subarray(start, start + ico.readUInt32LE(entry + 8));
    sizes.push(size);
    expect(data.subarray(0, 8).equals(PNG_SIGNATURE), `${size} px format`).toBe(size === 256);
    expect(decodeEntry(data, size).equals(appIcon.renderIcon(size)), `${size} px pixels`).toBe(
      true,
    );
  }
  expect(sizes).toEqual(appIcon.ICON_SIZES);
});

it('embeds the icon when packaging Diomedes.exe', async () => {
  const script = await readText('scripts/package-desktop.mjs');
  expect(script).toContain("path.join(root, 'desktop/diomedes.ico')");
  expect(script).toMatch(/packager\(\{[^}]*\bicon\b/);
});
