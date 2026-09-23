/**
 * A Claude Code conversation across an update that changed its instructions (owner decisions of
 * 2026-09-23). A native session resumes only under its instruction digest, and the host adds
 * the read-scope note to the session's system prompt at every start, so the recorded text alone
 * is the whole start text only on a turn with no read scope. Such a lineage continues byte for
 * byte; one that a read scope now covers retires, with a note, before anything is sent.
 *
 * The real app over HTTP with the native transport faked below the driver, as in
 * interaction-seam.test.ts. Its checkpoints carry no read-scope digest, which is exactly what a
 * v0.1.7 session saved. `close()` then `open()` is the update's restart.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { EngineService, TESTED_VERSIONS } from '../server/engines/service';
import type { PersistentTextAdapter, TextRequest } from '../server/engines/contract';
import type { ClaudeSessionCheckpoint } from '../server/engines/claude-session';
import { EngineError } from '../server/engines/process';
import { routeContractFor } from '../server/harness/route-contract';
import { hash, type Store } from '../server/store';
import type { MessageResult } from '../server/interaction-service';
import { instructionsFor } from '../server/interaction-turn';
import { MODES } from '../server/modes';
import type { Conversation, ConversationLineage, Project, Turn } from '../shared/types';
import fixture from './fixtures/instruction-texts.json';

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
const model = 'claude-fixture';
const accountRoute = 'claude-code:claude.ai';
const text = (build: string, mode: string) =>
  (fixture.texts as { build: string; mode: string; text: string }[]).find(
    (row) => row.build === build && row.mode === mode,
  )!.text;
const shipped = { ask: MODES.ask.instructions, auto: MODES.auto.instructions };

let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server | undefined;
let service: EngineService;
let base: string;
let project: Project;
let thread: Conversation;
/** The instructions each native process was opened with, in order. */
let opened: { instructions: string; resumed: boolean }[];
let dispatches: TextRequest[];

async function request(route: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(route, method, body);
  const reply = await response.text();
  expect(response.ok, `${route}: ${response.status} ${reply}`).toBe(true);
  return JSON.parse(reply) as T;
}
async function open() {
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
}
async function close() {
  if (!server) return;
  await app.locals.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
}
async function update() {
  await close();
  await open();
}
const store = () => app.locals.store as Store;
const current = () => store().state(project.id).conversations.find((item) => item.id === thread.id)!;
const lineages = (): ConversationLineage[] => current().lineages ?? [];
const notes = (): Turn[] => current().turns.filter((turn) => turn.role === 'diomedes');
const message = (commandId: string, words: string, mode: 'ask' | 'auto') => ({
  commandId,
  text: words,
  mode,
  sources: [],
  consent: true,
});
const send = (commandId: string, words: string, mode: 'ask' | 'auto') =>
  api<MessageResult>(`/projects/${project.id}/threads/${thread.id}/messages`, 'POST', message(commandId, words, mode));

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-lineage-claude-'));
  opened = [];
  dispatches = [];
  const adapter: PersistentTextAdapter<ClaudeSessionCheckpoint> = {
    id: 'claude-code',
    contract: routeContractFor('claude-code'),
    sessionContract: routeContractFor('claude-code-session'),
    inspect: async () => ({
      authentication: 'signed-in',
      accountRoute,
      detail: 'Fixture only',
      models: [{ slug: model, name: model, description: '', efforts: [], defaultEffort: null }],
    }),
    generate: async () => {
      throw new Error('Conversation requests must use the native transport');
    },
    openSession: async (input, options) => {
      opened.push({ instructions: input.instructions, resumed: Boolean(options.restore) });
      // A restored session keeps the checkpoint it was saved with, as the real transport does.
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
      if (checkpoint.instructionDigest !== hash(input.instructions))
        throw new EngineError('SESSION_MISMATCH', 'The native session account, project, model, version or instructions changed.');
      const signal = new AbortController().signal;
      return {
        get checkpoint() {
          return structuredClone(checkpoint);
        },
        get nativeSession() {
          return checkpoint.nativeSessionId
            ? { providerId: 'claude-code', lineageId: checkpoint.lineageId, opaqueRef: checkpoint.nativeSessionId }
            : null;
        },
        turn: async (turn) => {
          checkpoint = {
            ...checkpoint,
            state: 'busy',
            requests: [...checkpoint.requests, { id: turn.requestId, digest: hash(turn.prompt)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          dispatches.push(turn);
          const said = turn.prompt.split('\n\n[[diomedes')[0];
          // What the stream observer does to a file tool the turn may not use: the turn ends.
          if (said.startsWith('REFUSE')) {
            checkpoint = { ...checkpoint, state: 'uncertain' };
            await options.onCheckpoint(checkpoint, signal);
            throw new EngineError(
              'POLICY_MISMATCH',
              'Claude Code called Read, but this turn reads only the documents chosen for it; the read-only request was stopped.',
              true,
            );
          }
          const answer = `answer:${said}`;
          checkpoint = {
            ...checkpoint,
            state: 'idle',
            reportedModel: model,
            results: [...checkpoint.results, { id: turn.requestId, digest: hash(answer)! }],
          };
          await options.onCheckpoint(checkpoint, signal);
          return {
            text: answer,
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
  service = new EngineService(path.join(root, 'engines'), {
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
  await open();
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model });
  project = await api<Project>('/projects', 'POST', { name: 'Linen service' });
  await api(`/projects/${project.id}/cloud-sharing`, 'PUT', {
    expectedVersion: 0,
    routes: ['claude-code'],
    documents: [],
    shareConversationHistory: true,
    shareReviewPackets: false,
  });
  thread = await api<Conversation>(`/projects/${project.id}/threads`, 'POST', {});
  const state = store().state(project.id);
  state.conversations.find((item) => item.id === thread.id)!.engine = 'claude-code';
  state.project.ai = { engine: 'sample', model: null };
  await store().persist(state);
});
afterEach(async () => {
  MODES.ask.instructions = shipped.ask;
  MODES.auto.instructions = shipped.auto;
  await close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('an open Claude Code conversation after an update that changed its instructions', () => {
  test('on a turn with no read scope it continues, and the resumed session is opened with its recorded text byte for byte', async () => {
    const recorded = instructionsFor('auto', MODES.auto.instructions);
    const first = await send('m-first', 'Good morning', 'auto');
    expect(opened).toEqual([{ instructions: recorded, resumed: false }]);
    // A later build changes the Automatic text.
    MODES.auto.instructions = `${shipped.auto} Keep every answer short.`;
    await update();

    const second = await send('m-second', 'What is on today?', 'auto');
    expect(second.answerText).toBe('answer:What is on today?');
    expect(second.runId).toBe(first.runId);
    expect(lineages()).toEqual([expect.objectContaining({ mode: 'auto', generation: 1, runId: first.runId })]);
    expect(lineages()[0].retired).toBeUndefined();
    expect(opened).toEqual([
      { instructions: recorded, resumed: false },
      { instructions: recorded, resumed: true },
    ]);
    expect(dispatches.at(-1)!.instructions).toBe(recorded);
    expect(notes()).toEqual([]);
  });

  test('a v0.1.7 Ask lineage, which a read scope now covers, retires before anything is sent, with one note, and answers on a fresh session', async () => {
    const v017 = text('v0.1.7', 'ask');
    MODES.ask.instructions = v017;
    const first = await send('m-first', 'Where is the linen order?', 'ask');
    MODES.ask.instructions = shipped.ask;
    await update();

    const second = await send('m-second', 'And the invoice?', 'ask');
    expect(second.answerText).toBe('answer:And the invoice?');
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, runId: first.runId, retired: 'scope-change' }),
      expect.objectContaining({ generation: 2, runId: second.runId }),
    ]);
    // The old session was never resumed: the new generation opened a fresh one under today's text.
    expect(opened).toEqual([
      { instructions: v017, resumed: false },
      { instructions: shipped.ask, resumed: false },
    ]);
    expect(dispatches.map((turn) => turn.instructions)).toEqual([v017, shipped.ask]);
    expect(notes().map((note) => note.text)).toEqual([
      "Nectovia started this conversation fresh because its instructions changed. Your earlier messages are still here, but it won't remember them.",
    ]);
  });

  test('a refused turn ends that message; the next is answered on a new generation, with one note', async () => {
    const first = await send('m-first', 'Good morning', 'auto');
    const refused = await request(
      `/projects/${project.id}/threads/${thread.id}/messages`,
      'POST',
      message('m-refused', 'REFUSE read the payroll file', 'auto'),
    );
    expect(refused.ok).toBe(false);
    expect(notes()).toEqual([]);

    // Not wedged: the thread answers the next message. The refused turn left its run uncertain,
    // so that lineage cannot resume, and its context does not carry over. The note says so.
    const next = await send('m-next', 'Good afternoon', 'auto');
    expect(next.answerText).toBe('answer:Good afternoon');
    expect(lineages()).toEqual([
      expect.objectContaining({ generation: 1, runId: first.runId, retired: 'terminated' }),
      expect.objectContaining({ generation: 2, runId: next.runId }),
    ]);
    expect(notes().map((note) => note.text)).toEqual([
      "Nectovia started this conversation fresh because the earlier conversation stopped and could not be picked up again. Your earlier messages are still here, but it won't remember them.",
    ]);
  });
});
