import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';

// Diomedes.exe and its installer carry the Nectovia mark as their icon: scripts/app-icon.mjs
// draws it, desktop/diomedes.ico holds the drawing, scripts/package-desktop.mjs embeds it in
// the executable and scripts/build-windows-installer.mjs in the installer and its uninstaller.
// Entries are compared as decoded pixels, so a different zlib cannot fail the check.
const appIcon = await import(new URL('../scripts/app-icon.mjs', import.meta.url).href);
const installer = await import(
  new URL('../scripts/build-windows-installer.mjs', import.meta.url).href
);
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

it('draws the Nectovia mark with the Console geometry and the favicon palette', async () => {
  const mark = (await readText('client/console/NectoviaMark.tsx')).replace(/\s+/g, ' ');
  for (const { tone, points } of appIcon.MARK.plates as { tone: string; points: number[][] }[])
    expect(mark).toContain(
      `<polygon className="dm-nmark-plate${tone === 'graphite' ? ' dim' : ''}" points="${points
        .map((point) => point.join(','))
        .join(' ')}" />`,
    );
  for (const seam of ['lead', 'trail']) {
    const [x1, y1, x2, y2] = appIcon.MARK[seam];
    expect(mark).toContain(
      `<line className="dm-nmark-seam ${seam}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`,
    );
  }
  expect(mark).toContain(`export const TRAIL_MIN_SIZE = ${appIcon.MARK.trailMinSize};`);
  // A seam stays a line: 1.2 px at the small sizes, never over 3 px at the large ones.
  expect(appIcon.ICON_SIZES.map(appIcon.seamPixels)).toEqual(
    appIcon.ICON_SIZES.map((size: number) => Math.min(3, Math.max(1.2, size * 0.022))),
  );
  // The ink tile and both seams are the Nectovia scheme's own colours.
  const nectovia = (await readText('client/styles.css')).split(
    "html[data-package='nectovia'] {",
  )[1];
  const block = nectovia?.slice(0, nectovia.indexOf('}')) ?? '';
  expect(block).toContain(`--chrome: ${appIcon.PALETTE.ink};`);
  expect(block).toContain(`--light: ${appIcon.PALETTE.lead};`);
  expect(await readText('client/console/nectovia.css')).toContain(
    `--seam-trail: ${appIcon.PALETTE.trail};`,
  );
  // The tile's shape and the plates' bone and graphite are the favicon's (diomedes-site
  // public/favicon.svg), so the icon matches the site; the Console's own mark paints its
  // plates with the active scheme's --t1 and --t3 instead.
  expect(appIcon.MARK.tile).toEqual({ size: 24, radius: 5 });
  expect(appIcon.PALETTE).toMatchObject({ bone: '#f2f0ea', graphite: '#808b97' });
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
  // The packager is called through an injectable name so tests can substitute it.
  expect(script).toMatch(/packageApp\(\{[^}]*\bicon\b/);
});

it('shows the icon on the installer and its uninstaller', () => {
  const icon = fileURLToPath(new URL('../desktop/diomedes.ico', import.meta.url));
  const nsi: string = installer.generateNsis({
    outputPath: 'C:\\out\\setup.exe',
    version: '1.2.3',
    payload: { files: [], directories: [] },
  });
  expect(nsi).toContain(`!define MUI_ICON "${icon}"`);
  expect(nsi).toContain(`!define MUI_UNICON "${icon}"`);
  // MUI reads its icons when the first page is inserted, so both come before the pages.
  expect(nsi.indexOf('!define MUI_UNICON')).toBeLessThan(nsi.indexOf('!insertmacro MUI_PAGE_'));
  // Installed apps shows the icon Diomedes.exe carries.
  expect(nsi).toContain('"DisplayIcon" "$INSTDIR\\app\\Diomedes.exe"');
});
