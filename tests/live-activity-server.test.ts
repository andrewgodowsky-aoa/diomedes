/**
 * Live tool activity reaches the events stream on both conversation surfaces.
 *
 * Real `createApp`, real `EngineService` admission, real harness RunService and real Store
 * events — the same boundary the SSE route forwards verbatim. Only the provider transport is
 * scripted, and it reports tool calls through the adapter-facing `onToolActivity` sink that
 * EngineService alone hands it.
 */
import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service.js';
import type {
  PersistentTextAdapter,
  TextEngineAdapter,
  TextRequest,
} from '../server/engines/contract.js';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session.js';
import { routeContractFor } from '../server/harness/route-contract.js';
import { hash, type Store } from '../server/store.js';
import { toolActivitySchema } from '../shared/adapter-contract.js';
import type { IntegrationStatus } from '../shared/types.js';

const ENGINE = 'claude-code' as const;
const VERSION = TESTED_VERSIONS[ENGINE];
const ACCOUNT = 'claude-code:claude.ai';
const MODEL = 'sonnet';
const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };

type Frame = Record<string, unknown> & { channel: 'text' | 'activity' };

let root: string;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: Server | undefined;
let base = '';
let frames: Frame[];
let seen: TextRequest[];

const store = (): Store => app!.locals.store;

const installed: IntegrationStatus = {
  id: ENGINE,
  name: 'Claude Code',
  kind: 'online',
  found: true,
  available: false,
  enabled: false,
  status: 'Installed',
  detail: 'Found',
  capabilities: [],
  signIn: 'unknown',
  adapter: 'planned',
  installedVersion: VERSION,
  location: process.execPath,
  disclosure: [],
};
const inspect = async () => ({
  authentication: 'signed-in' as const,
  accountRoute: ACCOUNT,
  detail: 'Fixture only',
  models: [{ slug: MODEL, name: MODEL, description: '', efforts: [], defaultEffort: null }],
});

/** The provider's scripted work: a tool call, some text, the tool finishing, more text. */
function narrate(input: TextRequest) {
  input.onToolActivity?.({
    callId: 'c1',
    phase: 'started',
    tool: 'read_file',
    summary: 'Reading menu.md',
    detail: '{"path":"menu.md"}',
  });
  input.onDelta?.('Looking. ');
  input.onToolActivity?.({
    callId: 'c1',
    phase: 'finished',
    tool: 'read_file',
    summary: 'Read menu.md',
    detail: '42 lines',
  });
  input.onDelta?.('Done.');
}

async function open(adapter: TextEngineAdapter) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-activity-'));
  frames = [];
  seen = [];
  const engines = new EngineService(path.join(root, 'data', 'engines'), {
    discover: async () => [installed],
    version: async () => VERSION,
    adapter: () => adapter,
  });
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: engines,
    reviewerAdapter: null,
    nativeGenerator: async () => {
      throw new Error('No native work runs in this fixture');
    },
  } as Parameters<typeof createApp>[0]);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store().on('engine-text', (frame: Record<string, unknown>) =>
    frames.push({ ...structuredClone(frame), channel: 'text' }),
  );
  store().on('engine-activity', (frame: Record<string, unknown>) =>
    frames.push({ ...structuredClone(frame), channel: 'activity' }),
  );
}

afterEach(async () => {
  if (!server) return;
  const closingApp = app!, closingServer = server, closingRoot = root;
  server = undefined;
  try {
    await closingApp.locals.close();
  } finally {
    closingServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      closingServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await fs.rm(closingRoot, { recursive: true, force: true });
});

async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

/** The order a presenter receives: text and tool lines interleaved as the provider wrote them. */
const sequence = () =>
  frames.map((f) =>
    f.channel === 'text' ? `text:${String(f.kind)}` : `tool:${String(f.phase)}:${String(f.callId)}`,
  );

describe('thread Ask on an external engine', () => {
  const adapter: TextEngineAdapter = {
    id: ENGINE,
    contract: routeContractFor(ENGINE),
    inspect,
    generate: async (input) => {
      seen.push(input);
      narrate(input);
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        requestId: input.requestId,
        model: input.model,
        version: VERSION,
        text: 'Looking. Done.',
      };
    },
  };

  test('emits engine-activity frames stamped with the same run as the streamed text', async () => {
    await open(adapter);
    const project = await store().locked(() => store().createProject('Live activity'));
    store().settings.services = {
      'claude-code': true,
      'claude-codeModel': MODEL,
      'claude-codeAccountRoute': ACCOUNT,
    };
    await store().saveSettings(store().settings);
    // Cloud sharing is default-deny: this synthetic project shares its typed messages with
    // Claude Code and no document, which is all this Ask sends.
    await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
      expectedVersion: 0, routes: ['claude-code'], documents: [],
      shareConversationHistory: false, shareReviewPackets: false,
    });
    await api(`/projects/${project.id}/ask`, 'POST', {
      text: 'What is on the menu?',
      route: ENGINE,
      mode: 'ask',
      consent: true,
    });
    expect(sequence()).toEqual([
      'text:started',
      'tool:started:c1',
      'text:delta',
      'tool:finished:c1',
      'text:delta',
      'text:ended',
    ]);
    const started = frames.find((f) => f.channel === 'text' && f.kind === 'started')!;
    const delta = frames.find((f) => f.channel === 'text' && f.kind === 'delta')!;
    const activity = frames.filter((f) => f.channel === 'activity');
    for (const frame of activity) {
      const { channel: _channel, ...wire } = frame;
      expect(toolActivitySchema.safeParse(wire).success).toBe(true);
      expect(frame).toMatchObject({
        kind: 'tool-activity',
        projectId: project.id,
        threadId: started.threadId,
        requestId: started.requestId,
        runId: started.runId,
        stepId: delta.stepId,
        attempt: delta.attempt,
        fence: delta.fence,
      });
    }
    expect(activity.map((f) => [f.seq, f.summary, f.detail])).toEqual([
      [1, 'Reading menu.md', '{"path":"menu.md"}'],
      [2, 'Read menu.md', '42 lines'],
    ]);
    // The adapter got the raw sink and never the caller's frame channel.
    expect(typeof seen[0].onToolActivity).toBe('function');
    expect(seen[0].onActivity).toBeUndefined();
  });

  test('a caller cannot hand the adapter-facing activity sink in directly', async () => {
    await open(adapter);
    const service = new EngineService(path.join(root, 'data', 'engines-direct'), {
      discover: async () => [installed],
      version: async () => VERSION,
      adapter: () => adapter,
    });
    service.dispatch = async () => {
      throw new Error('never dispatched');
    };
    await expect(
      service.generate(ENGINE, {
        projectId: 'P1',
        threadId: 'T1',
        requestId: 'R1',
        prompt: 'x',
        documents: [],
        instructions: '',
        model: MODEL,
        accountRoute: ACCOUNT,
        onToolActivity: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_CONTRACT' });
    expect(seen).toHaveLength(0);
  });
});

describe('the Diomedes conversation driver', () => {
  const sessionAdapter = (): PersistentTextAdapter<ClaudeSessionCheckpoint> => ({
    id: ENGINE,
    contract: routeContractFor(ENGINE),
    sessionContract: routeContractFor('claude-code-session'),
    inspect,
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: async (input, options) => {
      let checkpoint: ClaudeSessionCheckpoint = {
        version: 1,
        nativeSessionId: randomUUID(),
        lineageId: randomUUID(),
        parentSessionId: null,
        projectId: input.projectId,
        threadId: input.threadId,
        cwd: root,
        cliVersion: VERSION,
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
          return {
            providerId: 'claude-code' as const,
            lineageId: checkpoint.lineageId,
            opaqueRef: checkpoint.nativeSessionId!,
          };
        },
        turn: async (turn) => {
          seen.push(turn);
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          narrate(turn);
          const text = 'Looking. Done.';
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: MODEL,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(text)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text,
            model: MODEL,
            version: VERSION,
            projectId: turn.projectId,
            threadId: turn.threadId,
            requestId: turn.requestId,
          };
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      };
    },
  });

  test('a home message streams text and tool lines bound to its lineage run and command', async () => {
    await open(sessionAdapter());
    await api('/ai/discover', 'POST', { consent: true });
    await api('/ai/check/claude-code', 'POST', {});
    await api('/ai/select', 'POST', { engine: ENGINE, model: MODEL });
    const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST');
    await api(`/projects/${home.projectId}/threads/${home.threadId}`, 'PUT', { engine: ENGINE });
    await api(`/projects/${home.projectId}/threads/${home.threadId}/messages`, 'POST', {
      commandId: 'm-live',
      text: 'What is on the menu?',
      mode: 'ask',
      sources: [],
      consent: true,
    });
    expect(sequence()).toEqual([
      'text:started',
      'tool:started:c1',
      'text:delta',
      'tool:finished:c1',
      'text:delta',
      'text:ended',
    ]);
    const started = frames.find((f) => f.channel === 'text' && f.kind === 'started')!;
    const delta = frames.find((f) => f.channel === 'text' && f.kind === 'delta')!;
    expect(started).toMatchObject({
      projectId: home.projectId,
      threadId: home.threadId,
      requestId: 'm-live',
    });
    expect(String(started.runId)).toMatch(/^claude-/);
    for (const frame of frames.filter((f) => f.channel === 'activity'))
      expect(frame).toMatchObject({
        kind: 'tool-activity',
        projectId: home.projectId,
        threadId: home.threadId,
        requestId: 'm-live',
        runId: started.runId,
        stepId: delta.stepId,
        attempt: delta.attempt,
        fence: delta.fence,
      });
    // The session turn received the fenced raw sink and no caller-facing channel.
    expect(typeof seen[0].onToolActivity).toBe('function');
    expect(seen[0].onActivity).toBeUndefined();
    expect(seen[0].onPreview).toBeUndefined();
  });
});
