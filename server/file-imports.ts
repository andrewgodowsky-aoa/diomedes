import fs from 'node:fs/promises';
import path from 'node:path';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_FILES,
  IMPORT_MAX_TOTAL_BYTES,
  importableName,
  type FileReference,
  type ImportCandidate,
  type ImportListing,
} from '../shared/file-imports.js';
import { ApiError, absent, safeAbsolute, relativeName, readTextOrNull } from './paths.js';
import { hash, type Store } from './store.js';

export function fileReferences(value: unknown): FileReference[] {
  if (!Array.isArray(value) || !value.length || value.length > IMPORT_MAX_FILES)
    throw new ApiError(400, 'Choose between one and eight export files.');
  const references = value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !('path' in item) ||
      !('sha' in item) ||
      typeof item.path !== 'string' ||
      item.path.length > 1000 ||
      typeof item.sha !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha)
    )
      throw new ApiError(400, 'Choose each file again to confirm its current version.');
    return { path: item.path, sha: item.sha };
  });
  if (
    new Set(references.map((ref) => ref.path.replaceAll('\\', '/').toLowerCase())).size !==
    references.length
  )
    throw new ApiError(400, 'Choose each file only once.');
  return references;
}

export function checkExport(name: string, text: string) {
  if (!importableName(name))
    throw new ApiError(
      415,
      'Choose a UTF-8 TXT, Markdown, CSV, TSV or JSON export. Images, PDFs and other binary files are not supported here.',
    );
  // The extension is only an initial filter. Refuse binary/control data even
  // when an executable or archive has been renamed to a text extension.
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
    /^(MZ|\x7fELF|PK\x03\x04|%PDF-)/.test(text)
  )
    throw new ApiError(415, 'This export contains binary data, not supported UTF-8 text.');
  if (Buffer.byteLength(text) > IMPORT_MAX_BYTES)
    throw new ApiError(413, 'Each export must be no larger than 1 MB.');
}

/** The full local path reaches the existing trust funnel before any file read. */
async function readExport(input: unknown) {
  if (
    typeof input !== 'string' ||
    input.length > 1000 ||
    !path.isAbsolute(input) ||
    input.includes('\0')
  )
    throw new ApiError(400, 'Choose an export using its full local path.');
  const absolute = await safeAbsolute(input);
  const name = relativeName(path.basename(absolute));
  if (!importableName(name)) checkExport(name, '');
  const stat = await fs.lstat(absolute).catch((error: unknown) => {
    if (absent(error)) throw new ApiError(409, 'This export disappeared. Choose it again.');
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ApiError(403, 'Choose a regular export file.');
  if (stat.size > IMPORT_MAX_BYTES)
    throw new ApiError(413, 'Each export must be no larger than 1 MB.');
  const text = await readTextOrNull(absolute);
  if (text === null) throw new ApiError(409, 'This export disappeared. Choose it again.');
  await safeAbsolute(absolute);
  checkExport(name, text);
  return { path: absolute, name, bytes: Buffer.byteLength(text), sha: hash(text)!, text };
}

export async function inspectImport(input: unknown): Promise<ImportCandidate> {
  const { text: _text, ...candidate } = await readExport(input);
  return candidate;
}

export async function browseImports(input: string): Promise<ImportListing> {
  const folder = await safeAbsolute(input);
  const result: ImportListing = {
    path: folder,
    parent: path.dirname(folder) === folder ? null : path.dirname(folder),
    folders: [],
    files: [],
  };
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
    if (!item.isDirectory() && (!item.isFile() || !importableName(item.name))) continue;
    try {
      const absolute = await safeAbsolute(path.join(folder, item.name));
      if (item.isDirectory()) result.folders.push({ name: item.name, path: absolute });
      else
        result.files.push({
          name: item.name,
          path: absolute,
          bytes: (await fs.lstat(absolute)).size,
        });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 403)) throw error;
    }
  }
  result.folders.sort((a, b) => a.name.localeCompare(b.name));
  result.files.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Called under Store.locked by the route. No source is modified or registered as a grant. */
export async function importExports(store: Store, projectId: string, value: unknown) {
  store.state(projectId);
  const references = fileReferences(value);
  const files = [];
  for (const reference of references) {
    const file = await readExport(reference.path);
    if (file.sha !== reference.sha)
      throw new ApiError(
        409,
        `${file.name} changed after selection. Remove it and choose it again.`,
      );
    files.push(file);
  }
  if (files.reduce((sum, file) => sum + file.bytes, 0) > IMPORT_MAX_TOTAL_BYTES)
    throw new ApiError(413, 'Choose no more than 4 MB of exports at once.');
  const destinations = files.map((file) => `Imports/${file.name}`);
  if (new Set(destinations.map((name) => name.toLowerCase())).size !== files.length)
    throw new ApiError(409, 'These exports have the same name. Rename one before importing.');
  for (const destination of destinations)
    if ((await store.current(projectId, destination)) !== null)
      throw new ApiError(
        409,
        `${destination} already exists. Rename the source to import another copy.`,
      );
  const entry = await store.writeRecorded(
    projectId,
    files.map((file, index) => ({
      path: destinations[index]!,
      text: file.text,
      expected: null,
    })),
    {
      actor: 'you',
      merge: false,
      sentence: `You imported ${files.length} export ${files.length === 1 ? 'file' : 'files'}.`,
      label: 'Imported exports',
    },
  );
  return {
    entryId: entry.id,
    files: files.map((file, index) => ({ path: destinations[index]!, sha: file.sha })),
  };
}
