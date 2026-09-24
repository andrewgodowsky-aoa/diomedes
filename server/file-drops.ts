/**
 * Drop and paste into Files, and the byte-level reads that let Files preview a
 * picture, describe a PDF or workbook, and open an older version by identity.
 *
 * Authority is unchanged from Import files (`server/file-imports.ts`):
 *
 * - Every write is one `Store.writeRecorded` batch, under the store lock the
 *   route helper takes, attributed to the person, into `Imports/`, never over
 *   an existing file (`expected: null`). A taken name gets the next free
 *   `name (2).ext` and the answer says so.
 * - Every read goes through `projectFile` (server/paths.ts, decision 11), and
 *   an older version is served only when History recorded exactly that
 *   `{ path, sha }` pair, from the content-addressed object store that
 *   recorded it. Nothing here widens what an engine may read: no route, Grant
 *   or pack changes, and no file is attached to anything by being dropped.
 * - The bytes decide what a file is (`shared/file-drops.ts`). Only PNG, JPEG,
 *   GIF and WebP are ever served as bytes, with their own type, `nosniff`, and
 *   a sandbox policy; SVG is drawing text that passed svg-check, shown in the
 *   existing sandboxed drawing frame. PDFs and workbooks are described, not
 *   rendered: this build has no safe in-app viewer for either.
 */
import fs from 'node:fs/promises';
import {
  BINARY_KINDS,
  BINARY_MIME,
  DROP_MAX_FILES,
  DROP_MAX_PIXELS,
  DROP_MAX_TOTAL_BYTES,
  IMAGE_KINDS,
  dropName,
  dropProblem,
  gifSize,
  pdfFacts,
  plainText,
  sniffBytes,
  uniqueImportPath,
  type SniffedKind,
} from '../shared/file-drops.js';
import { identityOf, isSha256, type FileIdentity } from '../shared/file-identity.js';
import { svgProblem } from '../shared/svg-check.js';
import { readImageHeader } from '../shared/theme-pack/package.js';
import { ApiError, absent, projectFile, relativeName } from './paths.js';
import { bytesHash, type Store, type WriteInput } from './store.js';

export interface DroppedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * One drop's files from its request: the names and sizes in the `files` query
 * value (JSON), the bytes concatenated in the body in that order. A raw body
 * keeps a picture's bytes exact and out of the JSON parser's limit.
 */
export function droppedFiles(meta: unknown, body: unknown): DroppedFile[] {
  let list: unknown;
  try {
    list = typeof meta === 'string' ? JSON.parse(meta) : null;
  } catch {
    list = null;
  }
  if (!Array.isArray(list) || !list.length || list.length > DROP_MAX_FILES)
    throw new ApiError(400, `Drop between one and ${DROP_MAX_FILES} files at once.`);
  if (!Buffer.isBuffer(body)) throw new ApiError(400, 'The dropped files did not arrive.');
  const files: DroppedFile[] = [];
  let at = 0;
  for (const item of list as unknown[]) {
    const record = item as { name?: unknown; bytes?: unknown };
    if (
      !record ||
      typeof record.name !== 'string' ||
      typeof record.bytes !== 'number' ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0
    )
      throw new ApiError(400, 'The dropped files did not arrive.');
    const bytes = body.subarray(at, at + record.bytes);
    if (bytes.length !== record.bytes) throw new ApiError(400, 'The dropped files did not arrive whole.');
    at += record.bytes;
    files.push({ name: record.name, bytes });
  }
  if (at !== body.length) throw new ApiError(400, 'The dropped files did not arrive whole.');
  return files;
}

/** Width and height for a picture kind, or null when its header cannot be read. */
export function pictureSize(kind: SniffedKind, bytes: Uint8Array) {
  if (kind === 'gif') return gifSize(bytes);
  const header = readImageHeader(bytes);
  return header ? { width: header.width, height: header.height } : null;
}

/** The refusal for one accepted-by-name file, including what only the bytes can say. */
function checkDropped(name: string, bytes: Uint8Array): { kind: SniffedKind; text: string | null } {
  const problem = dropProblem(name, bytes);
  if (problem) throw new ApiError(415, problem);
  const kind = sniffBytes(bytes)!;
  if (IMAGE_KINDS.includes(kind)) {
    const size = pictureSize(kind, bytes);
    if (!size || size.width < 1 || size.height < 1)
      throw new ApiError(415, `${name} does not say how large it is. Files did not add it.`);
    if (size.width * size.height > DROP_MAX_PIXELS)
      throw new ApiError(
        413,
        `${name} is ${size.width}×${size.height} pixels, over the ${DROP_MAX_PIXELS / (1024 * 1024)} megapixel limit.`,
      );
    return { kind, text: null };
  }
  if (kind === 'pdf' || kind === 'xlsx') return { kind, text: null };
  const text = plainText(bytes)!;
  if (kind === 'svg') {
    const svg = svgProblem(text);
    if (svg) throw new ApiError(415, `${name} did not pass the drawing check: ${svg}`);
  }
  return { kind, text };
}

async function taken(store: Store, projectId: string, path: string): Promise<boolean> {
  const { absolute } = await projectFile(store.state(projectId).project.folder, path);
  try {
    await fs.lstat(absolute);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}

export interface DropResult {
  entryId: string;
  versionId: string;
  files: { name: string; path: string; sha: string; kind: SniffedKind; renamed: boolean }[];
}

/**
 * Adds dropped or pasted files to `Imports/` as one History entry. Runs under
 * the store lock the route helper takes; nothing here takes it.
 */
export async function dropFiles(
  store: Store,
  projectId: string,
  files: readonly DroppedFile[],
  how: 'drop' | 'paste',
): Promise<DropResult> {
  store.state(projectId);
  if (!files.length || files.length > DROP_MAX_FILES)
    throw new ApiError(400, `Drop between one and ${DROP_MAX_FILES} files at once.`);
  if (files.reduce((sum, file) => sum + file.bytes.length, 0) > DROP_MAX_TOTAL_BYTES)
    throw new ApiError(413, `Drop no more than ${DROP_MAX_TOTAL_BYTES / (1024 * 1024)} MB at once.`);
  const chosen = new Set<string>();
  const planned: (DropResult['files'][number] & { input: WriteInput })[] = [];
  for (const file of files) {
    const name = dropName(file.name);
    if (!name) throw new ApiError(400, 'A dropped file has no name Files can use.');
    relativeName(`Imports/${name}`);
    const { kind, text } = checkDropped(name, file.bytes);
    let path = uniqueImportPath(name, chosen);
    // Probe upward past names that exist on disk, not only in this batch.
    while (await taken(store, projectId, path)) {
      chosen.add(path);
      path = uniqueImportPath(name, chosen);
    }
    chosen.add(path);
    planned.push({
      name,
      path,
      kind,
      sha: bytesHash(file.bytes)!,
      renamed: path !== `Imports/${name}`,
      input:
        text === null
          ? { path, text: null, bytes: file.bytes, expected: null }
          : { path, text, expected: null },
    });
  }
  const count = `${planned.length} ${planned.length === 1 ? 'file' : 'files'}`;
  const entry = await store.writeRecorded(
    projectId,
    planned.map((item) => item.input),
    {
      actor: 'you',
      merge: false,
      sentence:
        how === 'paste' ? `You pasted ${count} into Files.` : `You dropped ${count} into Files.`,
      label: how === 'paste' ? 'Pasted into Files' : 'Dropped into Files',
    },
  );
  return {
    entryId: entry.id,
    versionId: entry.versionId,
    files: planned.map(({ input: _input, ...file }) => file),
  };
}

/**
 * The bytes of `path` as it is now, or of the version `sha` names when History
 * recorded that pair. A refusal says which of the two is missing.
 */
async function versionBytes(
  store: Store,
  projectId: string,
  input: unknown,
  sha: unknown,
): Promise<{ path: string; bytes: Buffer; sha: string; current: boolean }> {
  if (typeof input !== 'string' || input.length > 1000)
    throw new ApiError(400, 'Choose a file inside this project.');
  const path = relativeName(input);
  if (sha !== undefined && !isSha256(sha))
    throw new ApiError(400, 'This file reference is not a recorded version.');
  const now = await store.currentBytes(projectId, path);
  const nowSha = now === null ? null : bytesHash(now);
  if (sha === undefined || sha === nowSha) {
    if (now === null || nowSha === null) throw new ApiError(404, 'This file no longer exists.');
    return { path, bytes: now, sha: nowSha, current: true };
  }
  const recorded = store
    .state(projectId)
    .history.some((entry) =>
      entry.files.some(
        (file) => file.path === path && file.recorded && (file.after === sha || file.before === sha),
      ),
    );
  if (!recorded)
    throw new ApiError(404, 'History has no record of this version of the file, so it cannot be shown.');
  try {
    const bytes = (await store.objectBytes(projectId, sha))!;
    return { path, bytes, sha, current: false };
  } catch (error) {
    if (absent(error))
      throw new ApiError(404, 'This version is no longer available. History records it, but its contents were not kept.');
    throw error;
  }
}

export interface DocumentFacts {
  identity: FileIdentity;
  current: boolean;
  bytes: number;
  kind: SniffedKind | null;
  picture?: { width: number; height: number; previewable: boolean };
  pdf?: { version: string | null; encrypted: boolean };
}

/** What a file or recorded version is, from its bytes, without rendering it. */
export async function documentFacts(
  store: Store,
  projectId: string,
  input: unknown,
  sha?: unknown,
): Promise<DocumentFacts> {
  const found = await versionBytes(store, projectId, input, sha);
  const kind = sniffBytes(found.bytes);
  const facts: DocumentFacts = {
    identity: identityOf(store.state(projectId).history, found.path, found.sha),
    current: found.current,
    bytes: found.bytes.length,
    kind,
  };
  if (kind && IMAGE_KINDS.includes(kind)) {
    const size = pictureSize(kind, found.bytes);
    facts.picture = {
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      previewable: !!size && size.width * size.height <= DROP_MAX_PIXELS,
    };
  }
  if (kind === 'pdf') facts.pdf = pdfFacts(found.bytes);
  return facts;
}

/**
 * A picture's bytes for an `<img>`: served only when the bytes are a PNG, JPEG,
 * GIF or WebP small enough to decode, whatever the file is named.
 */
export async function pictureBytes(store: Store, projectId: string, input: unknown, sha?: unknown) {
  const found = await versionBytes(store, projectId, input, sha);
  const kind = sniffBytes(found.bytes);
  if (!kind || !IMAGE_KINDS.includes(kind))
    throw new ApiError(415, 'Files shows only PNG, JPEG, GIF and WebP pictures this way.');
  const size = pictureSize(kind, found.bytes);
  if (!size || size.width * size.height > DROP_MAX_PIXELS)
    throw new ApiError(413, 'This picture is too large for Files to show.');
  return { ...found, mime: BINARY_MIME[kind]! };
}

/**
 * A recorded text version by identity: the text History kept for `{ path, sha }`,
 * or the current text when those bytes are still the file. A binary version
 * says so rather than decoding bytes as text.
 */
export async function documentVersion(store: Store, projectId: string, input: unknown, sha: unknown) {
  if (!isSha256(sha)) throw new ApiError(400, 'This file reference is not a recorded version.');
  const found = await versionBytes(store, projectId, input, sha);
  const kind = sniffBytes(found.bytes);
  const binary = kind !== null && BINARY_KINDS.includes(kind);
  return {
    identity: identityOf(store.state(projectId).history, found.path, found.sha),
    current: found.current,
    kind,
    text: binary ? null : plainText(found.bytes),
  };
}
