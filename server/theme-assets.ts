/**
 * The pictures a theme carries.
 *
 * An asset is bytes on disk under the theme's own scope, named by the SHA-256
 * of exactly those bytes:
 *
 *   <data>/themes/<scope>/<id>/assets/<sha256>.<png|jpg|webp>
 *
 * Five boundaries this module exists to hold.
 *
 * 1. **The bytes decide what the file is.** The declared `Content-Type` is a
 *    claim by the caller and is never trusted. `readImageHeader` — the one
 *    header reader in this codebase, from `shared/theme-pack/package.ts` — says
 *    what the bytes are and how large the picture really is. A 20000×20000
 *    plate cannot arrive by claiming to be 1×1, because nothing here reads the
 *    claim.
 *
 * 2. **Nothing is decoded and nothing is rendered here.** There is no image
 *    library in this product and this module does not add one: `package.json`
 *    carries no decoder, and `sharp` and every other native dependency are out
 *    by direction. So a handful of header bytes are parsed and the original is
 *    stored exactly as it arrived. **Derivatives — thumbnails, re-encodes,
 *    downscales, colour conversion — are deferred**, and nothing in the app
 *    pretends otherwise: the browser scales the original for display.
 *
 * 3. **SVG is refused by name.** It is a document, not a picture: it carries
 *    scripts, external references and its own stylesheet. A theme is data, so
 *    the answer is a sentence rather than a sanitiser, and it is given whether
 *    the file arrives as `image/svg+xml` or wearing `image/png` on the outside.
 *
 * 4. **The original is immutable.** A name that is the hash of the content can
 *    only ever hold that content. A second import of the same picture returns
 *    the record it already has and writes nothing, so no rename ever races a
 *    reader (a real hazard on Windows) and no asset can change under a pack
 *    that already references it.
 *
 * 5. **Scope is the boundary.** Every path is built through the theme service's
 *    own scoped directory, so one account's pictures are not another's — a read
 *    from a different workspace or person simply does not find the file.
 *
 * Nothing here calls a provider, starts an agent, or reaches the network.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  readImageHeader,
  sha256Hex,
  type ImageHeader,
} from '../shared/theme-pack/package.js';
import {
  THEME_PACK_LIMITS,
  type AssetMimeType,
  type AssetRecord,
  type ThemePackLimits,
  type ThemePackV1,
} from '../shared/theme-pack/types.js';
import { ApiError } from './paths.js';
import { durableWrite } from './store.js';
import type { ThemeService } from './themes.js';

/** The file extension each accepted type is stored under. One per type. */
export const ASSET_EXTENSIONS: Readonly<Record<AssetMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The name an asset can have on disk and in a URL: a SHA-256, lower-case hex. */
export const ASSET_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The body types the upload route accepts. The bytes are checked regardless. */
export const ASSET_UPLOAD_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

/** What one stored picture is, as the pack's `assets` map spells it. */
export interface StoredAsset {
  hash: string;
  record: AssetRecord;
}

const refuse = (status: number, message: string, code: string) =>
  new ApiError(status, message, { code });

/**
 * Does this look like an SVG or another XML document?
 *
 * Read from the front of the file rather than from the header the request
 * declared, so an SVG posted as `image/png` gets the same clear sentence. A
 * leading byte-order mark, whitespace, an XML declaration or a comment may all
 * come before the root element, so a window is scanned rather than a prefix
 * matched.
 */
function looksLikeXml(bytes: Uint8Array): boolean {
  // A UTF-8 byte-order mark is the three bytes EF BB BF. Read one byte to one
  // character, as this must be, they arrive as three separate characters and
  // never as U+FEFF, so the mark is dropped as bytes before anything is read.
  const from = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const window = bytes.subarray(from, from + 256);
  let text = '';
  for (const byte of window) text += String.fromCharCode(byte);
  let head = text.toLowerCase().trimStart();
  // Any number of comments may stand before the declaration or the root
  // element. Each whole one is stepped over; a comment still open at the end of
  // the window is already enough to know this is not a picture.
  while (head.startsWith('<!--')) {
    const closed = head.indexOf('-->');
    if (closed < 0) return true;
    head = head.slice(closed + 3).trimStart();
  }
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg');
}

/**
 * What these bytes are, or the refusal to say in plain words.
 *
 * Exported because both halves of the seam ask the same question: the upload
 * route about bytes arriving, and the stored-asset check about bytes on disk.
 */
export function inspectAssetBytes(
  bytes: Uint8Array,
  limits: ThemePackLimits = THEME_PACK_LIMITS,
): { ok: true; header: ImageHeader } | { ok: false; message: string; code: string } {
  if (bytes.length === 0)
    return { ok: false, message: 'That file is empty.', code: 'asset_empty' };
  if (looksLikeXml(bytes))
    return {
      ok: false,
      message:
        'SVG is not accepted in this release. Save the picture as a PNG, JPEG or WebP and import that.',
      code: 'asset_svg_refused',
    };
  const header = readImageHeader(bytes);
  if (!header)
    return {
      ok: false,
      message: 'That file is not a PNG, JPEG or WebP picture this app can read.',
      code: 'asset_unreadable',
    };
  if (header.width < 1 || header.height < 1)
    return {
      ok: false,
      message: 'That picture says it has no width or no height.',
      code: 'asset_no_size',
    };
  if (header.width * header.height > limits.assetPixels)
    return {
      ok: false,
      message: `That picture is ${header.width}×${header.height} pixels, over the ${Math.round(
        limits.assetPixels / (1024 * 1024),
      )} megapixel limit. Make it smaller and import it again.`,
      code: 'asset_too_many_pixels',
    };
  if (bytes.length > limits.assetBytes)
    return {
      ok: false,
      message: `That picture is ${bytes.length} bytes, over the ${limits.assetBytes} byte limit.`,
      code: 'asset_too_large',
    };
  return { ok: true, header };
}

const recordOf = (header: ImageHeader, bytes: Uint8Array): AssetRecord => ({
  mime: header.mime,
  bytes: bytes.length,
  width: header.width,
  height: header.height,
});

/** The three names one hash could be stored under. */
const candidates = (dir: string, hash: string): string[] =>
  Object.values(ASSET_EXTENSIONS).map((extension) => path.join(dir, `${hash}.${extension}`));

async function readStored(dir: string, hash: string): Promise<Uint8Array | null> {
  for (const target of candidates(dir, hash)) {
    try {
      return new Uint8Array(await fs.readFile(target));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Every problem with the pictures a pack declares, in plain words.
 *
 * Called on an explicit save, not on an autosave: a pack that names an asset
 * this account does not hold would validate, activate and then render nothing
 * at all, and the first person to find out would be looking at the app wearing
 * a theme with a hole in it. A draft is allowed to be half-finished; a saved
 * revision is not.
 *
 * The bytes are re-hashed rather than trusted, so a file edited on disk after
 * it was imported is caught here and not painted.
 */
export async function verifyStoredAssets(assetsDir: string, pack: ThemePackV1): Promise<string[]> {
  const problems: string[] = [];
  for (const [hash, record] of Object.entries(pack.assets)) {
    if (!ASSET_HASH_PATTERN.test(hash)) {
      problems.push(`asset ${hash} is not named by a SHA-256`);
      continue;
    }
    const bytes = await readStored(assetsDir, hash);
    if (!bytes) {
      problems.push(`the picture ${hash.slice(0, 12)}… is not stored here. Import it again.`);
      continue;
    }
    if (sha256Hex(bytes) !== hash) {
      problems.push(
        `the stored bytes for ${hash.slice(0, 12)}… no longer hash to their name. The file has changed on disk.`,
      );
      continue;
    }
    const header = readImageHeader(bytes);
    if (!header) {
      problems.push(`the stored picture ${hash.slice(0, 12)}… cannot be read as an image.`);
      continue;
    }
    if (
      header.mime !== record.mime ||
      header.width !== record.width ||
      header.height !== record.height ||
      bytes.length !== record.bytes
    )
      problems.push(
        `the theme describes ${hash.slice(0, 12)}… as ${record.width}×${record.height} ${record.mime}, and the stored bytes are ${header.width}×${header.height} ${header.mime}.`,
      );
  }
  return problems;
}

/**
 * Importing and serving the pictures of one account's themes.
 *
 * The scoped directory comes from the theme service, which owns the derivation
 * (workspace or person → hashed folder). There is no second answer here to
 * "whose theme is this".
 */
export class ThemeAssetService {
  constructor(private readonly themes: ThemeService) {}

  /**
   * Store an imported picture, or return the one already held.
   *
   * Everything is checked before a byte is written. The write is a temp file,
   * an fsync and a rename through the store's own `durableWrite`; a hash that
   * is already on disk is left exactly as it is, because a name that is the
   * content cannot hold anything else.
   */
  async store(id: string, bytes: Uint8Array): Promise<StoredAsset> {
    const checked = inspectAssetBytes(bytes);
    if (!checked.ok) throw refuse(400, checked.message, checked.code);
    const dir = this.themes.assetsDir(id);
    const hash = sha256Hex(bytes);
    const target = path.join(dir, `${hash}.${ASSET_EXTENSIONS[checked.header.mime]}`);
    const record = recordOf(checked.header, bytes);
    try {
      await fs.access(target);
      return { hash, record };
    } catch {
      // Not held yet. A theme that has only ever been autosaved has no folder,
      // so the folder is made here rather than assumed.
    }
    await fs.mkdir(dir, { recursive: true });
    await durableWrite(target, bytes);
    return { hash, record };
  }

  /**
   * The bytes of one stored picture, checked against their own name.
   *
   * A file edited on disk since it was imported is refused rather than served:
   * the hash is the only thing that says these bytes are that asset, and a
   * renderer asking for one picture must not be handed another.
   */
  async read(id: string, hash: string): Promise<{ bytes: Uint8Array; mime: AssetMimeType }> {
    if (!ASSET_HASH_PATTERN.test(hash))
      throw refuse(400, 'That is not the name of a stored picture.', 'invalid_asset_hash');
    const dir = this.themes.assetsDir(id);
    const bytes = await readStored(dir, hash);
    if (!bytes) throw refuse(404, 'That picture is not stored here.', 'asset_not_found');
    if (sha256Hex(bytes) !== hash)
      throw refuse(
        409,
        'That picture’s stored bytes no longer match its name. It has changed on disk and will not be served.',
        'asset_hash_mismatch',
      );
    const header = readImageHeader(bytes);
    if (!header)
      throw refuse(
        409,
        'That picture’s stored bytes cannot be read as an image.',
        'asset_unreadable',
      );
    return { bytes, mime: header.mime };
  }

  /** Every hash this theme holds bytes for. Used by the export path. */
  async list(id: string): Promise<string[]> {
    const dir = this.themes.assetsDir(id);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const extensions = new Set(Object.values(ASSET_EXTENSIONS));
    const found: string[] = [];
    for (const name of entries) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const hash = name.slice(0, dot);
      if (ASSET_HASH_PATTERN.test(hash) && extensions.has(name.slice(dot + 1))) found.push(hash);
    }
    return found.sort();
  }
}
