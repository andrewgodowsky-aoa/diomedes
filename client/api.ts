import type {
  FollowUpCommand,
  QueueFollowUpRequest,
  StopReceipt,
} from '../shared/work-control';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(message);
  }
}
import type { DocumentContent, DocumentInfo, Settings } from '../shared/types';
import type { EngineConnection } from '../shared/engines';

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
const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const followUp = (projectId: string, followUpId: string) =>
  `${base(projectId)}/follow-ups/${encodeURIComponent(followUpId)}`;

/**
 * The five work-control routes. A follow-up carries its own `commandId`, minted
 * the way a Work start's is, so a double click or a lost response names the
 * same command rather than queueing a second one.
 */
export const queueFollowUp = (projectId: string, request: QueueFollowUpRequest) =>
  api<{ followUp: FollowUpCommand }>(`${base(projectId)}/follow-ups`, 'POST', request).then(
    (result) => result.followUp,
  );
export const editFollowUp = (
  projectId: string,
  followUpId: string,
  patch: { text?: string; waitsFor?: FollowUpCommand['waitsFor'] },
) =>
  api<{ followUp: FollowUpCommand }>(followUp(projectId, followUpId), 'PUT', patch).then(
    (result) => result.followUp,
  );
export const removeFollowUp = (projectId: string, followUpId: string) =>
  api<{ followUp: FollowUpCommand }>(followUp(projectId, followUpId), 'DELETE').then(
    (result) => result.followUp,
  );
export const reorderFollowUps = (
  projectId: string,
  request: { taskId: string; order: string[] },
) =>
  api<{ followUps: FollowUpCommand[] }>(
    `${base(projectId)}/follow-ups/reorder`,
    'POST',
    request,
  ).then((result) => result.followUps);
export const stopWork = (
  projectId: string,
  request: { scope: StopReceipt['scope']; taskId: string; sessionId?: string | null },
) => api<StopReceipt>(`${base(projectId)}/stop`, 'POST', request);

/**
 * The engine connections AI setup reads (`GET /ai/status`): installation,
 * compatibility, sign-in and the model list the engine itself reported during
 * its last check. Answered from memory, so it starts no process and sends
 * nothing to a provider. The thread picker reads it so a signed-in account
 * offers the same models on the thread that Settings > Engines just listed.
 */
export const engineConnections = (signal?: AbortSignal): Promise<EngineConnection[]> =>
  api<{ connections: EngineConnection[] }>('/ai/status', 'GET', undefined, signal).then(
    (result) => result.connections,
  );

/**
 * Settings writes, guarded by the store's own content hash.
 *
 * Two AI-setup controls write settings by different routes — the On switch and
 * "Use as default" — and a whole-object PUT built from a screen's snapshot
 * silently discards whatever landed after that snapshot was taken. The server
 * sends the hash of what it stored as an ETag; a write echoes it back in
 * If-Match and is refused with 409 when the stored settings have moved. The
 * refusal carries the saved settings, so the caller re-applies its one change
 * to the current truth rather than to a stale copy, and the screen shows what
 * was saved rather than what it hoped for.
 */
export class SettingsConflict extends Error {
  constructor(
    readonly settings: Settings,
    readonly etag: string,
  ) {
    super('Settings changed while this screen was saving. The saved settings were reloaded.');
  }
}

/** The last hash the server reported. Empty until settings have been read once. */
let settingsTag = '';

/** For tests and for a fresh mount: forget the tag so the next write is unguarded. */
export function forgetSettingsTag(): void {
  settingsTag = '';
}

function failure(payload: Record<string, unknown>, status: number): ApiError {
  const nested = payload.error as { message?: string } | string | undefined;
  return new ApiError(
    (typeof nested === 'object' ? nested?.message : undefined) ??
      (typeof payload.message === 'string' ? payload.message : undefined) ??
      (typeof nested === 'string' ? nested : 'The request could not be completed.'),
    status,
    payload,
  );
}

async function settingsRequest(
  method: 'GET' | 'PUT',
  guard: boolean,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Settings> {
  const response = await fetch('/api/settings', {
    method,
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Diomedes-Client': '1',
      ...(guard && settingsTag ? { 'If-Match': settingsTag } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  const tag = response.headers.get('ETag');
  if (response.status === 409 && payload && payload.settings) {
    settingsTag = typeof payload.etag === 'string' ? payload.etag : '';
    throw new SettingsConflict(payload.settings as Settings, settingsTag);
  }
  if (!response.ok) throw failure(payload, response.status);
  if (tag) settingsTag = tag;
  return payload as unknown as Settings;
}

export const readSettings = (signal?: AbortSignal): Promise<Settings> =>
  settingsRequest('GET', false, undefined, signal);

/** Write settings against the hash last read. Throws `SettingsConflict` on 409. */
export const writeSettings = (value: unknown, signal?: AbortSignal): Promise<Settings> =>
  settingsRequest('PUT', true, value, signal);

/**
 * A write that owns exactly one field and names only that field — the open
 * project list, the last page, the interface scale. It carries no expected hash
 * because it makes no claim about the rest of settings, and it records the hash
 * the server reports so the next guarded write is measured against the truth
 * rather than against something this client has already moved past.
 */
export const patchSettings = (value: unknown, signal?: AbortSignal): Promise<Settings> =>
  settingsRequest('PUT', false, value, signal);

/**
 * The engine On switch. The read-modify-write happens on the server under the
 * store lock, beside the one "Use as default" already used, so the two cannot
 * lose each other's write however fast they are pressed.
 */
export async function setEngineEnabled(
  engine: string,
  on: boolean,
  signal?: AbortSignal,
): Promise<Settings> {
  const response = await fetch('/api/ai/enabled', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: JSON.stringify({ engine, on }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw failure(payload, response.status);
  const tag = response.headers.get('ETag');
  if (tag) settingsTag = tag;
  return payload as unknown as Settings;
}

/** "Use as default": the server validates the model and writes under the same lock. */
export async function selectEngineModel(
  engine: string,
  model: string,
  signal?: AbortSignal,
): Promise<Settings> {
  const response = await fetch('/api/ai/select', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' },
    body: JSON.stringify({ engine, model }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw failure(payload, response.status);
  const tag = response.headers.get('ETag');
  if (tag) settingsTag = tag;
  return payload as unknown as Settings;
}
