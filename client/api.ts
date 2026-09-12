export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(message);
  }
}
import type { DocumentContent, DocumentInfo } from '../shared/types';

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new ApiError(
      payload.error?.message ??
        payload.message ??
        (typeof payload.error === 'string' ? payload.error : 'The request could not be completed.'),
      response.status,
      payload,
    );
  return payload as T;
}

/**
 * The project's document listing. The SSE `state` fan-out strips `documents`
 * (server/app.ts `statePayload`), so a surface that needs the listing asks for
 * it here rather than reading `state.documents`.
 */
export function listDocuments(projectId: string, signal?: AbortSignal): Promise<{ documents: DocumentInfo[] }> {
  return api<{ documents: DocumentInfo[] }>(
    `/projects/${encodeURIComponent(projectId)}/documents`,
    'GET',
    undefined,
    signal,
  );
}

/** One document's text, through the same guarded read the Workbook uses. */
export function readDocument(
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<DocumentContent> {
  return api<DocumentContent>(
    `/projects/${encodeURIComponent(projectId)}/documents/read?path=${encodeURIComponent(path)}`,
    'GET',
    undefined,
    signal,
  );
}
