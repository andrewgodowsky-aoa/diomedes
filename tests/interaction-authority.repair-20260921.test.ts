import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { PersistentTextAdapter } from '../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import type { ClaudeSessionRuns } from '../server/harness/claude-session-run';
import { routeContractFor } from '../server/harness/route-contract';
import { hash, type Store } from '../server/store';
import { conversationCommandIds } from '../server/interaction-admission';
import type { MessageResult } from '../server/interaction-service';
import type { Conversation, Project, Session, Task } from '../shared/types';

// Two boundaries the bounded review's matrix does not reach, through the same seam and the
// same fake provider: a Work command another request already bound to different work, and
// an identical selection with nothing committed under it on a conversation that moved on.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'claude-fixture';
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let base: string;
let project: Project;
let thread: Conversation;

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}
const store = () => app.locals.store as Store;
const driver = () => app.locals.harness.claudeSessions as ClaudeSessionRuns;

/** The same scripted model the review uses: ACT proposes work, anything else answers. */
function scripted(prompt: string) {
  const issued = /\[\[diomedes source_message_id=(sm\.[0-9a-f]{32})\]\]$/.exec(prompt)?.[1];
  const text = prompt.split('\n\n[[diomedes')[0];
  if (!text.startsWith('ACT') || !issued) return `answer:${text}`;
  return (
    'I can start that.\n\n```diomedes-decision\n' +
    JSON.stringify({
      source_message_id: issued,
      disposition: 'act',
      requested_project_id: null,
      operation_class: 'write_internal',
      source_refs: [],
      target_run_id: null,
      question: null,
      public_summary: `Do this: ${text}`,
    }) +
    '\n```'
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-interaction-repair-'));
  const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute: 'claude-code:claude.ai',
      detail: 'Fixture only',
      models: [{ slug: model, name: model, description: '', efforts: [], defaultEffort: null }],
    }),
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: async (input, options) => {
      let checkpoint: ClaudeSessionCheckpoint = options.restore
        ? structuredClone(options.restore)
        : {
            version: 1,
            nativeSessionId: randomUUID(),
            lineageId: randomUUID(),
            parentSessionId: null,
            projectId: input.projectId,
            threadId: input.threadId,
            cwd: root,
            cliVersion: TESTED_VERSIONS['claude-code'],
            accountDigest: hash('fixture-account')!,
            requestedModel: input.model,
            reportedModel: null,
            instructionDigest: hash(input.instructions)!,
            state: 'idle',
            requests: [],
            results: [],
          };
      const signal = new AbortController().signal;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return checkpoint.nativeSessionId
            ? {
                providerId: 'claude-code',
                lineageId: checkpoint.lineageId,
                opaqueRef: checkpoint.nativeSessionId,
              }
            : null;
        },
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          const text = scripted(turn.prompt);
          turn.onDelta?.(text);
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: model,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text,
            model,
            version: TESTED_VERSIONS['claude-code'],
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
          };
        },
        interrupt: async () => {
          throw new Error('No held turn in this fixture');
        },
        close: async () => undefined,
      };
    },
  };
  const service = new EngineService(path.join(root, 'engines'), {
    discover: async () => [
      {
        id: 'claude-code',
        name: 'Fixture',
        kind: 'online',
        found: true,
        available: false,
        enabled: false,
        status: 'Installed',
        detail: 'Fixture',
        capabilities: [],
        signIn: 'unknown',
        adapter: 'planned',
        installedVersion: TESTED_VERSIONS['claude-code'],
        location: process.execPath,
        disclosure: [],
      },
    ],
    version: async () => TESTED_VERSIONS['claude-code'],
    adapter: () => adapter,
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: service,
    reviewerAdapter: null,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0, routes: ['claude-code'], documents: [],
    shareConversationHistory: true, shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const state = store().state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
});
afterEach(async () => {
  if (server) {
    await app.locals.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await fs.rm(root, { recursive: true, force: true });
});

const messages = () => `/projects/${project.id}/threads/${thread.id}/messages`;
const send = (commandId: string, text: string) =>
  api<MessageResult>(messages(), 'POST', {
    commandId,
    text,
    mode: 'auto',
    sources: [],
    consent: true,
  });
const select = (commandId: string, proposalDigest: string) =>
  request(`${messages()}/${commandId}/select`, 'POST', {
    proposalDigest,
    projectId: project.id,
    consent: true,
  });
const workFor = (sourceMessageId: string) => {
  const ids = conversationCommandIds(sourceMessageId);
  const state = store().state(project.id);
  return {
    tasks: state.tasks.filter((task) => task.creationReceipt?.commandId === ids.taskCommandId),
    sessions: state.sessions.filter((session) => session.receipt?.commandId === ids.workCommandId),
  };
};

test('a Work command already bound to different work is never this message’s start', async () => {
  const proposed = await send('repair-work-intent', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  const ids = conversationCommandIds(proposed.sourceMessageId);
  // Another request binds the derived Work command to work of its own first.
  const other = await api<Task>(`/projects/${project.id}/tasks`, 'POST', {
    name: 'Another job',
    description: 'Unrelated previously bound intent',
  });
  const bound = await api<Session>(`/projects/${project.id}/work/start`, 'POST', {
    protocolVersion: 1,
    commandId: ids.workCommandId,
    taskId: other.id,
    route: 'sample',
    instruction: 'Unrelated previously bound work',
    sources: [],
    consent: true,
  });
  const response = await select('repair-work-intent', proposed.outcome.proposalDigest);
  const started = (await response.json()) as MessageResult;
  expect(started.outcome).toMatchObject({ status: 'not-started', reason: 'refused' });
  // The read says the same. A session belonging to other work is never reported as this
  // message's own, with or without the phase that would have linked one.
  const read = await api<MessageResult>(`${messages()}/repair-work-intent`);
  expect(read.outcome).toMatchObject({ status: 'not-started', reason: 'refused' });
  const sessions = store()
    .state(project.id)
    .sessions.filter((session) => session.receipt?.commandId === ids.workCommandId);
  // The one session under that command id is still the other request's, on the other task.
  expect(sessions.map((session) => [session.id, session.taskId])).toEqual([[bound.id, other.id]]);
});

test('an identical selection with nothing committed is refused once the conversation moved on', async () => {
  const proposed = await send('repair-no-child', 'ACT create an owned draft');
  if (proposed.outcome.status !== 'proposed') throw new Error('expected a proposal');
  // The choice was saved and nothing was admitted under it before the conversation moved on.
  await driver().record(project.id, proposed.runId, [
    {
      phase: 'action-selected',
      sourceMessageId: proposed.sourceMessageId,
      body: {
        sourceMessageId: proposed.sourceMessageId,
        proposalDigest: proposed.outcome.proposalDigest,
        projectId: project.id,
      },
    },
  ]);
  await api(`/projects/${project.id}/harness/runs/${proposed.runId}/cancel`, 'POST', {
    reason: 'The conversation moved on',
  });
  const before = await driver().get(project.id, proposed.runId);
  const retry = await select('repair-no-child', proposed.outcome.proposalDigest);
  // There is no receipt to return, so this is a new effect and the settled run refuses it.
  expect(retry.status).toBe(409);
  expect(workFor(proposed.sourceMessageId)).toEqual({ tasks: [], sessions: [] });
  expect(await driver().get(project.id, proposed.runId)).toEqual(before);
});
