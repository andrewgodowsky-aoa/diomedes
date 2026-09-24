import { api, ApiError } from '../api';
import type { SniffedKind } from '../../shared/file-drops';
import type { FileIdentity } from '../../shared/file-identity';

/**
 * Typed callers for the Files drop, preview and version routes
 * (server/file-drops.ts). Kept beside the pane that uses them rather than in
 * the shared client module, so the pane's routes read in one place.
 */
const documents = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/documents`;
const query = (path: string, sha?: string | null) =>
  `path=${encodeURIComponent(path)}${sha ? `&sha=${encodeURIComponent(sha)}` : ''}`;

export interface DropResult {
  entryId: string;
  versionId: string;
  files: { name: string; path: string; sha: string; kind: SniffedKind; renamed: boolean }[];
}

/** One drop or paste: the names and sizes in the query, the bytes in one raw body. */
export async function dropIntoFiles(
  projectId: string,
  files: readonly { name: string; bytes: Uint8Array }[],
  how: 'drop' | 'paste',
): Promise<DropResult> {
  const meta = JSON.stringify(files.map((file) => ({ name: file.name, bytes: file.bytes.length })));
  const body = new Uint8Array(files.reduce((sum, file) => sum + file.bytes.length, 0));
  let at = 0;
  for (const file of files) {
    body.set(file.bytes, at);
    at += file.bytes.length;
  }
  const response = await fetch(
    `/api${documents(projectId)}/drop?how=${how}&files=${encodeURIComponent(meta)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Diomedes-Client': '1' },
      body,
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new ApiError(
      typeof payload.error === 'string' ? payload.error : 'Files could not add these files.',
      response.status,
      payload,
    );
  return payload as unknown as DropResult;
}

export interface DocumentFacts {
  identity: FileIdentity;
  current: boolean;
  bytes: number;
  kind: SniffedKind | null;
  picture?: { width: number; height: number; previewable: boolean };
  pdf?: { version: string | null; encrypted: boolean };
}

export const documentFacts = (projectId: string, path: string, sha?: string | null, signal?: AbortSignal) =>
  api<DocumentFacts>(`${documents(projectId)}/facts?${query(path, sha)}`, 'GET', undefined, signal);

export interface DocumentVersion {
  identity: FileIdentity;
  current: boolean;
  kind: SniffedKind | null;
  text: string | null;
}

export const documentVersion = (projectId: string, path: string, sha: string, signal?: AbortSignal) =>
  api<DocumentVersion>(`${documents(projectId)}/version?${query(path, sha)}`, 'GET', undefined, signal);

/** Same-origin, so the app's `img-src 'self'` admits it; the route serves pictures only. */
export const pictureUrl = (projectId: string, path: string, sha?: string | null) =>
  `/api${documents(projectId)}/picture?${query(path, sha)}`;

export interface WorkbookPage {
  identity: FileIdentity;
  current: boolean;
  sheets: string[];
  sheet: string;
  rows: string[][];
  total: number;
  columns: number;
  clipped: boolean;
}

export const workbookSheet = (
  projectId: string,
  path: string,
  sha: string | null | undefined,
  offset: number,
  signal?: AbortSignal,
) =>
  api<WorkbookPage>(`${documents(projectId)}/sheet?${query(path, sha)}&offset=${offset}`, 'GET', undefined, signal);
