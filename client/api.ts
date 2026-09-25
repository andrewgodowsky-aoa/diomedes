import type {
  ControlReceipt,
  ControlRequest,
  FollowUpCommand,
  QueueFollowUpRequest,
  RouteControlProfile,
  StopReceipt,
} from '../shared/work-control';
/** A control as the client sends it; the server fills the queue's optional defaults. */
export type ControlRequestBody =
  | Exclude<ControlRequest, { control: 'queue' | 'stop' }>
  | (Omit<Extract<ControlRequest, { control: 'queue' }>, 'model' | 'agentId' | 'sources'> &
      Partial<Pick<Extract<ControlRequest, { control: 'queue' }>, 'model' | 'agentId' | 'sources'>>)
  | (Omit<Extract<ControlRequest, { control: 'stop' }>, 'sessionId'> & { sessionId?: string | null });

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
import type {
  ConversationUpdate,
  ConversationUpdatePreview,
  ConversationUpdateRequest,
} from '../shared/conversation';
import type { EngineConnection } from '../shared/engines';
import type { ReadinessProjection } from '../shared/readiness';

import type {
  CreateProspectDiscoveryInput,
  DiscoveryStage,
  FactProvenance,
  HypothesisOutcome,
  PersonalizationLevel,
  ProspectDiscoveryRecord,
  StaleObservedEvidence,
} from '../shared/discovery';

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

type DiscoveryResponse = {
  record: ProspectDiscoveryRecord | null;
  /** Observed facts whose approved file has changed since (DIO-84). */
  staleEvidence?: readonly StaleObservedEvidence[];
};
const discoveryPath = (prospectId: string) => `/discovery/${encodeURIComponent(prospectId)}`;

export const discoveryApi = {
  active: (signal?: AbortSignal) => api<DiscoveryResponse>('/discovery', 'GET', undefined, signal),
  create: (input: CreateProspectDiscoveryInput) =>
    api<DiscoveryResponse>('/discovery', 'POST', input),
  select: (prospectId: string) =>
    api<DiscoveryResponse>(`${discoveryPath(prospectId)}/select`, 'POST', {}),
  correct: (
    prospectId: string,
    input: { factId: string; value: string | null; provenance: FactProvenance },
  ) => api<DiscoveryResponse>(`${discoveryPath(prospectId)}/facts/correct`, 'POST', input),
  outcome: (prospectId: string, outcome: HypothesisOutcome) =>
    api<DiscoveryResponse>(`${discoveryPath(prospectId)}/hypothesis/outcome`, 'POST', {
      outcome,
      checkedAt: new Date().toISOString(),
    }),
  classify: (
    prospectId: string,
    stage: DiscoveryStage,
    personalizationLevel: PersonalizationLevel,
  ) =>
    api<DiscoveryResponse>(`${discoveryPath(prospectId)}/classification`, 'POST', {
      stage,
      personalizationLevel,
    }),
  importBrief: (prospectId: string, input: { projectId: string; path: string; sha: string }) =>
    api<DiscoveryResponse>(`${discoveryPath(prospectId)}/import`, 'POST', input),
  exportRecord: (prospectId: string, projectId: string) =>
    api<DiscoveryResponse>(`${discoveryPath(prospectId)}/export`, 'POST', { projectId }),
};

export const readinessApi = {
  read: (projectId?: string, signal?: AbortSignal) =>
    api<{ readiness: ReadinessProjection }>(
      `/readiness${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      'GET',
      undefined,
      signal,
    ),
};

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

/** One document's text, through the guarded document read. */
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
 * H08: one route for Steer, Queue, Stop, Resume, Retry and Fork. The caller mints
 * the `commandId` once per press, so a lost response or a second click names the
 * same command and reads back the same receipt.
 */
export const performControl = (projectId: string, request: ControlRequestBody) =>
  api<{ receipt: ControlReceipt }>(`${base(projectId)}/controls`, 'POST', request).then(
    (result) => result.receipt,
  );
/** Each of a task's runs with the controls its route offers, as the server enforces them. */
export const controlProfiles = (projectId: string, taskId: string, signal?: AbortSignal) =>
  api<{ profiles: Record<string, RouteControlProfile> }>(
    `${base(projectId)}/controls?taskId=${encodeURIComponent(taskId)}`,
    'GET',
    undefined,
    signal,
  ).then((result) => result.profiles);

/**
 * "Update this conversation": moves one thread onto the current instructions and answer format,
 * with one note in the thread saying what it carried. The caller keeps one `commandId` per thread
 * until the server answers it (conversation-update.ts), so a second click or a lost response names
 * the same command, and a retry reads back what the first did. `updated: false` means the thread
 * was already current and nothing changed. While a message is being answered, or an Automatic
 * proposal waits for the person's choice, it is refused with a 409 whose message is the reason, in
 * the server's own words.
 */
export const updateConversation = (projectId: string, threadId: string, commandId: string) =>
  api<ConversationUpdate>(
    `${base(projectId)}/threads/${encodeURIComponent(threadId)}/answer-format`,
    'POST',
    { commandId } satisfies ConversationUpdateRequest,
  );

/**
 * What "Update this conversation" would do now, as the server decides it: how many conversations
 * it would start fresh, the route the next message takes (a tier's included) and whether their
 * recent messages would come along. A read; the confirmation words itself from it.
 */
export const conversationUpdatePreview = (projectId: string, threadId: string, signal?: AbortSignal) =>
  api<ConversationUpdatePreview>(
    `${base(projectId)}/threads/${encodeURIComponent(threadId)}/answer-format`,
    'GET',
    undefined,
    signal,
  );

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

// Automations (Milestone A). Organization-scoped, like the workspace routes.
const automationsPath = (organizationId: string) =>
  `/workspace/organizations/${encodeURIComponent(organizationId)}/automations`;

export const listAutomations = (organizationId: string, signal?: AbortSignal) =>
  api<import('../shared/automations').AutomationList>(
    automationsPath(organizationId),
    'GET',
    undefined,
    signal,
  );

export const automationDetail = (
  organizationId: string,
  automationId: string,
  page = 1,
  signal?: AbortSignal,
) =>
  api<import('../shared/automations').AutomationDetail>(
    `${automationsPath(organizationId)}/${encodeURIComponent(automationId)}?page=${page}`,
    'GET',
    undefined,
    signal,
  );

/**
 * One press of Run once. The command id is made here, once per press, and a
 * retry after a lost connection or a server fault sends the same id, so the
 * host answers it with the occurrence it already admitted instead of a second
 * run. A refusal the host recorded comes back as an ordinary result.
 */
export async function runAutomation(organizationId: string, automationId: string) {
  const commandId = `run-${crypto.randomUUID()}`;
  for (let attempt = 1; ; attempt++) {
    try {
      return await api<import('../shared/automations').RunOnceResult>(
        `${automationsPath(organizationId)}/${encodeURIComponent(automationId)}/run`,
        'POST',
        { commandId },
      );
    } catch (error) {
      const retryable = !(error instanceof ApiError) || error.status >= 500;
      if (!retryable || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

/* P07: the Software Engineering pack's repository slice. Every route refuses where the pack is off. */
const softwarePath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/software`;
export const softwarePackApi = {
  view: (projectId: string, signal?: AbortSignal) =>
    api<import('../shared/software-pack').SoftwarePackView>(softwarePath(projectId), 'GET', undefined, signal),
  file: (projectId: string, path: string) =>
    api<{ path: string; before: string | null; after: string | null; binary: boolean; tooLarge: boolean }>(
      `${softwarePath(projectId)}/file?path=${encodeURIComponent(path)}`,
    ),
  diff: (projectId: string, paths: readonly string[]) =>
    api<{ text: string; tooLarge: boolean }>(`${softwarePath(projectId)}/diff`, 'POST', { paths }),
  declare: (projectId: string, commands: readonly { command: string; label?: string; kind?: string; cwd?: string; timeoutMs?: number }[]) =>
    api<{ commands: import('../shared/software-pack').DeclaredCommand[] }>(`${softwarePath(projectId)}/commands`, 'PUT', { commands }),
  run: (projectId: string, commandId: string) =>
    api<import('../shared/software-pack').CommandRunRecord>(
      `${softwarePath(projectId)}/commands/${encodeURIComponent(commandId)}/run`,
      'POST',
    ),
  answerRun: (projectId: string, runId: string, decision: 'go-ahead' | 'declined', intentHash: string) =>
    api<import('../shared/software-pack').CommandRunRecord>(
      `${softwarePath(projectId)}/runs/${encodeURIComponent(runId)}/decision`,
      'POST',
      { decision, intentHash },
    ),
  worktree: (projectId: string, body: { operation: 'add' | 'remove'; name: string; branch?: string; taskId?: string }) =>
    api<import('../shared/software-pack').WorktreeRequest>(`${softwarePath(projectId)}/worktrees`, 'POST', body),
  answerWorktree: (projectId: string, requestId: string, decision: 'go-ahead' | 'declined', intentHash: string) =>
    api<import('../shared/software-pack').WorktreeRequest>(
      `${softwarePath(projectId)}/worktrees/${encodeURIComponent(requestId)}/decision`,
      'POST',
      { decision, intentHash },
    ),
};
