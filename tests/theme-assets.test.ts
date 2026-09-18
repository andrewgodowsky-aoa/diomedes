/**
 * The pictures a theme carries: what gets in, what gets served, and what does
 * not.
 *
 * The claims under test:
 *
 * - **The bytes decide.** A truncated PNG, a JPEG whose magic is wrong, an SVG
 *   (however it is labelled), a file over the byte cap and a header claiming
 *   more than sixteen megapixels are each refused with a sentence, not a stack
 *   trace. A file that is genuinely a PNG is accepted whatever it claims to be.
 * - **The name is the content.** The stored file is `<sha256>.<ext>`; importing
 *   the same picture twice writes nothing new; a file edited on disk after it
 *   was imported is refused rather than served, and a theme that names it can
 *   no longer be saved.
 * - **Scope is the boundary.** A picture imported in one workspace is not
 *   readable from another, and does not appear in its folder at all.
 *
 * Nothing here calls a provider or reaches the network beyond its own loopback
 * server.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { themeScopeKey } from '../server/themes.js';
import { sha256Hex } from '../shared/theme-pack/package.js';
import { THEME_PACK_LIMITS, type ThemePackV1 } from '../shared/theme-pack/types.js';
import type { Person, WorkspaceRef } from '../shared/workspaces.js';

let server: Server | undefined;
let root = '';
let url = '';
const HEADERS = { 'X-Diomedes-Client': '1' };
const PERSONAL: WorkspaceRef = { kind: 'personal' };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-theme-assets-'));
  const app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

/** Import bytes as a picture, with whatever the caller wants to claim they are. */
async function upload(id: string, bytes: Uint8Array, contentType = 'image/png') {
  const response = await fetch(`${url}/api/themes/${id}/assets`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': contentType },
    body: bytes as unknown as BodyInit,
  });
  return {
    status: response.status,
    data: (await response.json().catch(() => null)) as any,
  };
}

async function json<T = any>(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${url}/api${route}`, {
    method,
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json().catch(() => null)) as T };
}

const errorCode = (data: unknown): string | undefined =>
  (data as { code?: string } | null)?.code;

const errorText = (data: unknown): string =>
  String((data as { error?: string } | null)?.error ?? '');

async function themeDir(id: string, workspace: WorkspaceRef = PERSONAL): Promise<string> {
  const person = JSON.parse(
    await fs.readFile(path.join(root, 'data', 'workspaces', 'identity.json'), 'utf8'),
  ) as Person;
  return path.join(root, 'data', 'themes', themeScopeKey(workspace, person.id), id);
}

// ---------------------------------------------------------------------------
// Fixtures built here, so what makes each one invalid is written down
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A real, minimal PNG: signature, an IHDR with the given size, and its CRC. */
function png(width = 4, height = 4, payload = 64): Uint8Array {
  const bytes = new Uint8Array(8 + 25 + payload);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // colour type: RGBA
  // The remainder is filler. Nothing in this product decodes a PNG, so the
  // pixel data is never read; the header is the whole contract.
  for (let at = 33; at < bytes.length; at += 1) bytes[at] = at & 0xff;
  return bytes;
}

/** The real fixture the Playwright run uses, so both halves test one file. */
const fixturePng = async (): Promise<Uint8Array> =>
  new Uint8Array(
    await fs.readFile(
      path.join(import.meta.dirname, '..', 'shared', 'theme-pack', 'fixtures', 'bust-plate.png'),
    ),
  );

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function pack(id: string, overrides: Partial<ThemePackV1> = {}): ThemePackV1 {
  const color = (value: string) => ({ $type: 'color' as const, $value: value });
  return {
    schemaVersion: 1,
    id,
    name: `Theme ${id}`,
    revision: 1,
    baseTheme: 'graphite',
    surfaces: ['app-console'],
    provenance: { author: 'A4 test', createdAt: '2026-09-17T00:00:00.000Z', tool: 'vitest' },
    tokens: {
      color: {
        chrome: color('#101014'),
        surface: color('#15151a'),
        raised: color('#1b1b22'),
        hair: color('#ffffff12'),
        hair2: color('#ffffff1f'),
        t1: color('#f2f2f5'),
        t2: color('#b6b6c0'),
        t3: color('#8b8b96'),
        light: color('#7cf7ff'),
        attn: color('#ffce6a'),
        fail: color('#ff8080'),
      },
      lightScheme: { $type: 'boolean', $value: false },
    },
    typography: {
      interfaceScale: 1,
      readingScale: 1,
      codeScale: 1,
      lineHeight: 1.55,
      interfaceFont: 'schibsted-grotesk',
      readingFont: 'schibsted-grotesk',
      codeFont: 'ibm-plex-mono',
    },
    geometry: { controlRadius: 6, separatorStrength: 1, density: 'standard' },
    artwork: {},
    motion: { presetId: 'settle', duration: 160, intensity: 0.5, reducedMotionBehaviour: 'static' },
    assets: {},
    ...overrides,
  };
}

/** A pack that places one imported picture in the bust slot. */
const packWithBust = (id: string, hash: string, record: unknown): ThemePackV1 =>
  pack(id, {
    artwork: {
      bust: {
        assetHash: hash,
        focal: { x: 0.5, y: 0.5 },
        crop: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 0.8,
        blend: 'normal',
        mask: 'none',
      },
    },
    assets: { [hash]: record } as ThemePackV1['assets'],
  });

// ---------------------------------------------------------------------------
// What gets in
// ---------------------------------------------------------------------------

test('a real PNG is stored under the hash of its own bytes, once', async () => {
  const bytes = await fixturePng();
  const hash = sha256Hex(bytes);

  const first = await upload('picture-theme', bytes);
  expect(first.status).toBe(200);
  expect(first.data.hash).toBe(hash);
  // The record is read from the bytes, never from anything the caller said.
  expect(first.data.record).toEqual({
    mime: 'image/png',
    bytes: bytes.length,
    width: 16,
    height: 16,
  });

  const dir = path.join(await themeDir('picture-theme'), 'assets');
  expect(await fs.readdir(dir)).toEqual([`${hash}.png`]);
  const stored = new Uint8Array(await fs.readFile(path.join(dir, `${hash}.png`)));
  // Stored exactly as it arrived: the original is immutable and untouched.
  expect(sha256Hex(stored)).toBe(hash);
  expect(stored.length).toBe(bytes.length);

  // The same picture again is the same record and no second file.
  const again = await upload('picture-theme', bytes);
  expect(again.status).toBe(200);
  expect(again.data.hash).toBe(hash);
  expect(await fs.readdir(dir)).toEqual([`${hash}.png`]);
});

test('the declared type is never believed: a PNG posted as JPEG is still a PNG', async () => {
  const bytes = await fixturePng();
  const uploaded = await upload('mislabelled', bytes, 'image/jpeg');
  expect(uploaded.status).toBe(200);
  expect(uploaded.data.record.mime).toBe('image/png');
  const dir = path.join(await themeDir('mislabelled'), 'assets');
  expect(await fs.readdir(dir)).toEqual([`${sha256Hex(bytes)}.png`]);
});

test('a stored picture is served back with the type its own bytes declare', async () => {
  const bytes = await fixturePng();
  const hash = sha256Hex(bytes);
  await upload('served', bytes);

  // No client header: this is what an <img> can send, and an <img> is the
  // whole reason this route is a GET.
  const response = await fetch(`${url}/api/themes/served/assets/${hash}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  const served = new Uint8Array(await response.arrayBuffer());
  expect(sha256Hex(served)).toBe(hash);
});

// ---------------------------------------------------------------------------
// What does not
// ---------------------------------------------------------------------------

test('a truncated PNG is refused: the header is not all there', async () => {
  const short = png().subarray(0, 20);
  const refused = await upload('truncated', short);
  expect(refused.status).toBe(400);
  expect(errorCode(refused.data)).toBe('asset_unreadable');
  expect(errorText(refused.data)).toContain('PNG, JPEG or WebP');
});

test('a file with the wrong magic bytes is refused whatever it claims to be', async () => {
  // The JPEG start-of-image is FF D8. This says FF D9 and is nothing.
  const fake = new Uint8Array([0xff, 0xd9, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0, 0, 0]);
  const asJpeg = await upload('wrong-magic', fake, 'image/jpeg');
  expect(asJpeg.status).toBe(400);
  expect(errorCode(asJpeg.data)).toBe('asset_unreadable');

  // A PNG signature with an IHDR that is not there is equally not a picture.
  const halfPng = new Uint8Array([...PNG_SIGNATURE, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const partial = await upload('wrong-magic', halfPng);
  expect(partial.status).toBe(400);
  expect(errorCode(partial.data)).toBe('asset_unreadable');
});

test('SVG is refused by name, however it is labelled', async () => {
  const svg = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  // Declared honestly: the parser never accepts the type, so the route says so.
  const honest = await upload('no-svg', svg, 'image/svg+xml');
  expect(honest.status).toBe(415);
  expect(errorText(honest.data)).toContain('SVG is not accepted in this release');

  // Declared as a PNG: the bytes are read, and the answer is the same sentence
  // rather than a generic refusal that leaves someone guessing.
  const disguised = await upload('no-svg', svg, 'image/png');
  expect(disguised.status).toBe(400);
  expect(errorCode(disguised.data)).toBe('asset_svg_refused');
  expect(errorText(disguised.data)).toContain('SVG is not accepted in this release');

  // With an XML declaration in front of the root element.
  const declared = bytesOf('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
  const withProlog = await upload('no-svg', declared, 'image/png');
  expect(withProlog.status).toBe(400);
  expect(errorCode(withProlog.data)).toBe('asset_svg_refused');

  // With a UTF-8 byte-order mark, which plenty of editors on Windows write
  // without being asked. Its three bytes are not the character U+FEFF once each
  // byte is read as a character, so they have to be dropped as bytes or the
  // root element is never reached and the file gets the wrong sentence.
  const mark = [0xef, 0xbb, 0xbf];
  const marked = new Uint8Array([...mark, ...declared]);
  const withMark = await upload('no-svg', marked, 'image/png');
  expect(withMark.status).toBe(400);
  expect(errorCode(withMark.data)).toBe('asset_svg_refused');
  expect(errorText(withMark.data)).toContain('SVG is not accepted in this release');

  // With the generator comments a drawing program writes above the root, and a
  // mark as well: whole comments are stepped over rather than read as content.
  const commented = new Uint8Array([
    ...mark,
    ...bytesOf('<!-- Generator: an editor -->'),
    ...bytesOf('<!-- and a second note -->'),
    ...bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ]);
  const withComments = await upload('no-svg', commented, 'image/png');
  expect(withComments.status).toBe(400);
  expect(errorCode(withComments.data)).toBe('asset_svg_refused');
  expect(errorText(withComments.data)).toContain('SVG is not accepted in this release');
});

test('an empty body is refused', async () => {
  const empty = await upload('nothing', new Uint8Array(0));
  expect(empty.status).toBe(400);
  expect(errorCode(empty.data)).toBe('asset_empty');
});

test('a picture over the byte cap is refused with a sentence about its size', async () => {
  const huge = png(4, 4, THEME_PACK_LIMITS.assetBytes + 4096);
  expect(huge.length).toBeGreaterThan(THEME_PACK_LIMITS.assetBytes);
  const refused = await upload('too-big', huge);
  expect(refused.status).toBe(400);
  expect(errorCode(refused.data)).toBe('asset_too_large');
  // Not the body parser's sentence about JSON, which would be a lie here.
  expect(errorText(refused.data)).not.toContain('JSON');
  expect(errorText(refused.data)).toContain('picture');
});

test('a small file claiming enormous pixel dimensions is refused', async () => {
  // 20000 × 20000 is 400 megapixels in 100 bytes. Only the header says so, and
  // only the header is read — which is exactly why the cap is measured here.
  const lying = png(20000, 20000, 32);
  expect(lying.length).toBeLessThan(200);
  const refused = await upload('pixel-bomb', lying);
  expect(refused.status).toBe(400);
  expect(errorCode(refused.data)).toBe('asset_too_many_pixels');
  expect(errorText(refused.data)).toContain('20000×20000');
  const dir = path.join(await themeDir('pixel-bomb'), 'assets');
  await expect(fs.readdir(dir)).rejects.toThrow();
});

test('a picture exactly at the pixel cap is accepted', async () => {
  // 4096 × 4096 is 16 megapixels: the cap, not over it.
  const edge = png(4096, 4096, 32);
  const accepted = await upload('at-the-cap', edge);
  expect(accepted.status).toBe(200);
  expect(accepted.data.record).toMatchObject({ width: 4096, height: 4096 });
});

// ---------------------------------------------------------------------------
// The name is the content
// ---------------------------------------------------------------------------

test('a stored picture edited on disk is refused rather than served', async () => {
  const bytes = await fixturePng();
  const hash = sha256Hex(bytes);
  await upload('tampered', bytes);
  const file = path.join(await themeDir('tampered'), 'assets', `${hash}.png`);

  // Someone replaces the file with a different, perfectly valid picture. The
  // name still says it is the first one. It is not.
  await fs.writeFile(file, Buffer.from(png(8, 8)));

  const response = await fetch(`${url}/api/themes/tampered/assets/${hash}`);
  expect(response.status).toBe(409);
  expect(errorCode(await response.json())).toBe('asset_hash_mismatch');
});

test('a hash that is not a SHA-256, and one nothing is stored under, are told apart', async () => {
  const nonsense = await fetch(`${url}/api/themes/absent/assets/not-a-hash`);
  expect(nonsense.status).toBe(400);
  expect(errorCode(await nonsense.json())).toBe('invalid_asset_hash');

  const missing = await fetch(`${url}/api/themes/absent/assets/${'a'.repeat(64)}`);
  expect(missing.status).toBe(404);
  expect(errorCode(await missing.json())).toBe('asset_not_found');
});

test('a saved revision may not name a picture this account does not hold', async () => {
  const bytes = await fixturePng();
  const hash = sha256Hex(bytes);
  const record = { mime: 'image/png', bytes: bytes.length, width: 16, height: 16 };

  // Nothing imported: the pack is valid by the contract and still refused,
  // because a theme that names a picture nobody holds paints a hole.
  const phantom = await json('/themes/phantom', 'PUT', packWithBust('phantom', hash, record));
  expect(phantom.status).toBe(400);
  expect(errorCode(phantom.data)).toBe('theme_assets_missing');

  // A draft is allowed to be half-finished: the same pack autosaves.
  const drafted = await json('/themes/phantom', 'PUT', {
    ...packWithBust('phantom', hash, record),
    draft: true,
  });
  expect(drafted.status).toBe(200);

  // Import the picture and the same save is accepted.
  await upload('phantom', bytes);
  const saved = await json('/themes/phantom', 'PUT', packWithBust('phantom', hash, record));
  expect(saved.status).toBe(200);
  expect(saved.data.revision).toBe(1);
});

test('a saved revision may not describe a picture as something it is not', async () => {
  const bytes = await fixturePng();
  const hash = sha256Hex(bytes);
  await upload('mis-described', bytes);
  const lying = { mime: 'image/png', bytes: bytes.length, width: 2048, height: 2048 };
  const refused = await json('/themes/mis-described', 'PUT', packWithBust('mis-described', hash, lying));
  expect(refused.status).toBe(400);
  expect(errorCode(refused.data)).toBe('theme_assets_missing');
  expect(errorText(refused.data)).toContain('2048×2048');
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('a picture imported in one workspace is not readable from another', async () => {
  const bytes = await fixturePng();
  const hash = sha256Hex(bytes);

  // Account A: personal.
  expect((await upload('shared-name', bytes)).status).toBe(200);
  expect((await fetch(`${url}/api/themes/shared-name/assets/${hash}`)).status).toBe(200);

  // Account B: a business workspace, same computer, same theme name.
  const made = await json('/workspace/organizations', 'POST', { name: 'Another Account' });
  expect(made.status).toBe(200);

  const fromB = await fetch(`${url}/api/themes/shared-name/assets/${hash}`);
  expect(fromB.status).toBe(404);
  expect(errorCode(await fromB.json())).toBe('asset_not_found');

  // Not merely unreadable: it is not in B's folder at all.
  const settings = await json<{ activeWorkspace: WorkspaceRef }>('/settings');
  const dirB = path.join(await themeDir('shared-name', settings.data.activeWorkspace), 'assets');
  await expect(fs.readdir(dirB)).rejects.toThrow();

  // And A still has it after the switch back.
  expect((await json('/workspace/switch', 'POST', { kind: 'personal' })).status).toBe(200);
  expect((await fetch(`${url}/api/themes/shared-name/assets/${hash}`)).status).toBe(200);
});

test('an upload refuses a theme name this service will not store', async () => {
  const bytes = await fixturePng();
  const bad = await upload('NO', bytes);
  expect(bad.status).toBe(400);
  expect(errorCode(bad.data)).toBe('invalid_theme_id');
});
