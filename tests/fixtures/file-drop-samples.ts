import { deflateRawSync } from 'node:zlib';
/** Tiny real pictures and a PDF, owned by these tests: 1×1 pixels, no personal data. */
const b64 = (value: string) => Uint8Array.from(Buffer.from(value, 'base64'));
export const PNG_1X1 = b64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
);
export const GIF_1X1 = b64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
export const WEBP_1X1 = b64('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==');
export const JPEG_1X1 = b64(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
);
export const PDF_SMALL = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
/** A PNG header that claims 20000×20000 pixels: refused before any window decodes it. */
export function pngClaiming(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
/** The local headers of a workbook ZIP, enough for the sniff; never opened as a workbook. */
export const XLSX_HEAD = new TextEncoder().encode(
  'PK\u0003\u0004\u0014\u0000\u0000\u0000\u0000\u0000[Content_Types].xml<Types/>PK\u0003\u0004xl/workbook.xml<workbook/>',
);
export const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#3a6"/></svg>';
export const SCRIPTED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

/**
 * A minimal workbook ZIP written here, so the preview is proven on real ZIP
 * structure (deflated parts, a central directory) without a binary fixture.
 * `lieAboutSize` makes the sheet part claim a small size but inflate far larger.
 */
export function buildXlsx(
  sheetXml: string,
  { shared = [] as string[], sheetName = 'Stock', lieAboutSize = false } = {},
): Uint8Array {
  const parts: [string, string][] = [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    [
      'xl/workbook.xml',
      `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    ],
    [
      'xl/sharedStrings.xml',
      `<sst>${shared.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`,
    ],
    ['xl/worksheets/sheet1.xml', sheetXml],
  ];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of parts) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const size = lieAboutSize && name.endsWith('sheet1.xml') ? 100 : raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, directory, end]));
}
