/**
 * The `.diomedes-theme` v1 container.
 *
 * A theme package is one JSON document: `{ manifest, pack, assets }`, where
 * `assets` maps each SHA-256 hash to the base64 of exactly those bytes. There
 * is no zip, no archive format and no image library — a theme is data, and the
 * container is the same data with its bytes carried alongside.
 *
 * `checksum(pack)` is CONTENT IDENTITY ONLY. It says two packs are byte-for-
 * byte the same design. It is not a signature, not proof of authorship and not
 * proof of purchase; anyone can compute it over anyone's pack.
 *
 * Self-contained by design — see the note at the top of types.ts. SHA-256 and
 * base64 are implemented here rather than imported so the bundle runs in a
 * browser, in Node and in the Astro site with no dependencies at all.
 */

import {
  ASSET_MIME_TYPES,
  THEME_PACK_LIMITS,
  type AssetMimeType,
  type ThemePackLimits,
  type ThemePackV1,
} from './types.js';
import { validateThemePack } from './validate.js';

export const THEME_PACKAGE_FORMAT = 'diomedes-theme';
export const THEME_PACKAGE_FORMAT_VERSION = 1;
export const THEME_PACKAGE_EXTENSION = '.diomedes-theme';

export interface ThemePackageManifest {
  format: typeof THEME_PACKAGE_FORMAT;
  formatVersion: typeof THEME_PACKAGE_FORMAT_VERSION;
  packId: string;
  revision: number;
  /** Content identity of `pack`. Not authorship, not payment. */
  checksum: string;
  assetCount: number;
  totalAssetBytes: number;
}

export interface ThemePackage {
  manifest: ThemePackageManifest;
  pack: ThemePackV1;
  /** sha-256 hex → base64 of exactly those bytes. */
  assets: Record<string, string>;
}

export type ExportResult = { ok: true; package: ThemePackage } | { ok: false; errors: string[] };

export type ImportResult =
  | { ok: true; pack: ThemePackV1; assets: Record<string, Uint8Array> }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), synchronous and dependency-free
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map((value) => value.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REVERSE = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const chunk =
      (bytes[i] << 16) |
      ((remaining > 1 ? bytes[i + 1] : 0) << 8) |
      (remaining > 2 ? bytes[i + 2] : 0);
    out += ALPHABET[(chunk >> 18) & 63] + ALPHABET[(chunk >> 12) & 63];
    out += remaining > 1 ? ALPHABET[(chunk >> 6) & 63] : '=';
    out += remaining > 2 ? ALPHABET[chunk & 63] : '=';
  }
  return out;
}

/** Strict: padding must be right, and no character outside the alphabet. */
export function fromBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0) return undefined;
  const body = value.replace(/=+$/, '');
  if (value.length - body.length > 2) return undefined;
  const bytes = new Uint8Array((body.length * 3) >> 2);
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of body) {
    const index = REVERSE.get(char);
    if (index === undefined) return undefined;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Image headers
//
// Enough of PNG, JPEG and WebP to read the type and the real pixel dimensions.
// Nothing is decoded and nothing is rendered: these read a fixed handful of
// bytes so a package cannot declare a small image and carry a huge one.
// ---------------------------------------------------------------------------

export interface ImageHeader {
  mime: AssetMimeType;
  width: number;
  height: number;
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1];
const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Start-of-frame markers that carry the frame size. C4, C8 and CC do not. */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readPng(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.length < 24) return undefined;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return undefined;
  if (!ascii(bytes, 12, 'IHDR')) return undefined;
  return { mime: 'image/png', width: u32(bytes, 16), height: u32(bytes, 20) };
}

function readJpeg(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    // Padding, and the standalone markers that carry no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    const length = u16(bytes, at + 2);
    if (length < 2) return undefined;
    if (JPEG_SOF.has(marker)) {
      if (at + 9 > bytes.length) return undefined;
      return { mime: 'image/jpeg', height: u16(bytes, at + 5), width: u16(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

function readWebp(bytes: Uint8Array): ImageHeader | undefined {
  if (bytes.length < 30 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return undefined;
  const size = (width: number, height: number): ImageHeader => ({
    mime: 'image/webp',
    width,
    height,
  });
  if (ascii(bytes, 12, 'VP8X'))
    return size(
      1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    );
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return size(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  if (ascii(bytes, 12, 'VP8 ')) {
    // The lossy keyframe header: a 3-byte start code, then the sync code.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
    return size((bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
  }
  return undefined;
}

/**
 * The type and pixel dimensions an image's own bytes declare, or `undefined`
 * if these bytes are not a supported image.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/** JSON with every object's keys sorted, so identity does not depend on order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Content identity of a pack: the SHA-256 of its canonical JSON.
 *
 * Two packs with the same checksum are the same design. That is all it claims:
 * it is not a signature, not authorship and not a payment receipt.
 */
export function checksum(pack: ThemePackV1): string {
  return sha256Hex(new TextEncoder().encode(canonical(pack)));
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

function checkAssetBytes(
  pack: ThemePackV1,
  bytes: Record<string, Uint8Array>,
  limits: ThemePackLimits,
  errors: string[],
): number {
  let total = 0;
  for (const [hash, record] of Object.entries(pack.assets)) {
    const data = bytes[hash];
    if (!data) {
      errors.push(`asset ${hash} is declared by the pack but its bytes are missing`);
      continue;
    }
    if (data.length !== record.bytes)
      errors.push(`asset ${hash} declares ${record.bytes} bytes but carries ${data.length} bytes`);
    if (sha256Hex(data) !== hash)
      errors.push(`asset ${hash} does not hash to its key: the bytes are not the asset`);
    if (data.length > limits.assetBytes)
      errors.push(`asset ${hash} is larger than the per-asset limit of ${limits.assetBytes} bytes`);

    // The pixel cap is measured from the image itself. A record could claim
    // 1×1 for a 20000×20000 plate, and only the bytes can say otherwise.
    const measured = readImageHeader(data);
    if (!measured) {
      errors.push(
        `asset ${hash} is not a readable ${ASSET_MIME_TYPES.join(', ')} image: its dimensions cannot be verified`,
      );
    } else {
      if (measured.mime !== record.mime)
        errors.push(`asset ${hash} declares ${record.mime} but its bytes are ${measured.mime}`);
      if (measured.width !== record.width || measured.height !== record.height)
        errors.push(
          `asset ${hash} declares ${record.width}×${record.height} but its bytes are ${measured.width}×${measured.height}`,
        );
      if (measured.width * measured.height > limits.assetPixels)
        errors.push(
          `asset ${hash} is ${measured.width}×${measured.height}, over the ${limits.assetPixels} pixel limit`,
        );
    }
    total += data.length;
  }
  for (const hash of Object.keys(bytes))
    if (!(hash in pack.assets))
      errors.push(`asset ${hash} is carried but the pack never declared it`);
  if (total > limits.totalAssetBytes)
    errors.push(`total asset bytes ${total} exceed the package limit of ${limits.totalAssetBytes}`);
  return total;
}

/** Build a `.diomedes-theme` container from a pack and its asset bytes. */
export function exportThemePackage(
  pack: ThemePackV1,
  assetBytes: Record<string, Uint8Array>,
  limits: ThemePackLimits = THEME_PACK_LIMITS,
): ExportResult {
  const validation = validateThemePack(pack);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const errors: string[] = [];
  const total = checkAssetBytes(pack, assetBytes, limits, errors);
  if (errors.length > 0) return { ok: false, errors };

  const assets: Record<string, string> = {};
  for (const hash of Object.keys(pack.assets)) assets[hash] = toBase64(assetBytes[hash]);

  return {
    ok: true,
    package: {
      manifest: {
        format: THEME_PACKAGE_FORMAT,
        formatVersion: THEME_PACKAGE_FORMAT_VERSION,
        packId: pack.id,
        revision: pack.revision,
        checksum: checksum(pack),
        assetCount: Object.keys(pack.assets).length,
        totalAssetBytes: total,
      },
      pack,
      assets,
    },
  };
}

/**
 * Read a `.diomedes-theme` container.
 *
 * Nothing is trusted: the format and version, the pack, every asset's base64,
 * every asset's hash against its own bytes, the manifest's checksum against the
 * pack, and every size cap are all checked before anything is returned.
 */
export function importThemePackage(
  value: unknown,
  limits: ThemePackLimits = THEME_PACK_LIMITS,
): ImportResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, errors: ['a theme package must be an object'] };
  const container = value as Record<string, unknown>;
  for (const key of Object.keys(container))
    if (!['manifest', 'pack', 'assets'].includes(key))
      return { ok: false, errors: [`unknown key in the package container: ${key}`] };

  const manifest = container.manifest;
  if (typeof manifest !== 'object' || manifest === null)
    return { ok: false, errors: ['the package has no manifest'] };
  const head = manifest as Record<string, unknown>;
  if (head.format !== THEME_PACKAGE_FORMAT)
    return { ok: false, errors: [`not a ${THEME_PACKAGE_FORMAT} package`] };
  if (head.formatVersion !== THEME_PACKAGE_FORMAT_VERSION)
    return {
      ok: false,
      errors: [
        `unsupported version: this build reads ${THEME_PACKAGE_FORMAT} v${THEME_PACKAGE_FORMAT_VERSION}, the file declares ${JSON.stringify(head.formatVersion)}`,
      ],
    };

  const validation = validateThemePack(container.pack);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const pack = validation.pack;

  if (head.checksum !== checksum(pack))
    return { ok: false, errors: ['the manifest checksum does not match the pack it carries'] };

  const raw = container.assets;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, errors: ['the package assets must be an object'] };

  const errors: string[] = [];
  const decoded: Record<string, Uint8Array> = {};
  for (const [hash, encoded] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof encoded !== 'string') {
      errors.push(`asset ${hash} is not base64 text`);
      continue;
    }
    const bytes = fromBase64(encoded);
    if (!bytes) {
      errors.push(`asset ${hash} is not valid base64`);
      continue;
    }
    decoded[hash] = bytes;
  }
  if (errors.length > 0) return { ok: false, errors };

  checkAssetBytes(pack, decoded, limits, errors);
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, pack, assets: decoded };
}
