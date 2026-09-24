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
