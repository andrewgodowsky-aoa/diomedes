import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { answerTurnId } from '../client/conversation-turn';
import { projectedTurnIds, turnIdentityText } from '../shared/conversation-turn-id';
import type { MessageResult } from '../shared/conversation';
import type { ProjectState } from '../shared/types';
import { SCRIPTED_MODEL, scriptedEngineService } from './fixtures/scripted-conversation';

// The page finds a command's answer in the transcript by the name the server gave its turn
// (CD05-R-08). This holds the page's derivation to the real projection: the real app, Store and
// session driver, with only the provider scripted.

const headers = { 'Content-Type': 'application/json', 'X-Diomedes-Client': '1' };
let root: string;
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let base: string;

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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'diomedes-turn-id-'));
  app = await createApp({
    dataDir: path.join(root, 'data'),
    projectRoot: path.join(root, 'projects'),
    engineService: scriptedEngineService(path.join(root, 'engines'), root),
    reviewerAdapter: null,
  });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api('/ai/discover', 'POST', { consent: true });
  await api('/ai/check/claude-code', 'POST', {});
  await api('/ai/select', 'POST', { engine: 'claude-code', model: SCRIPTED_MODEL });
});

afterEach(async () => {
  // Captured before the first await: a hook that outlives its timeout must not act on the next
  // test's server.
  const closing = server;
  const application = app;
  try {
    await application.locals.close();
  } finally {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('the page names a command\'s answer exactly as the server projected it', async () => {
  const home = await api<{ projectId: string; threadId: string }>('/home/conversation', 'POST', {});
  const messages = `/projects/${home.projectId}/threads/${home.threadId}/messages`;
  const say = (commandId: string, text: string) =>
    api<MessageResult>(messages, 'POST', { commandId, text, mode: 'auto', sources: [], consent: true });

  const first = await say('turn-id-1', 'Same words');
  const second = await say('turn-id-2', 'Same words');
  // Two commands answered in the same words: prose cannot tell them apart.
  expect(first.answerText).toBe(second.answerText);

  const state = await api<ProjectState>(`/projects/${home.projectId}/state`);
  const turns = state.conversations.find((item) => item.id === home.threadId)!.turns;
  expect(turns.map((turn) => turn.role)).toEqual(['you', 'assistant', 'you', 'assistant']);

  for (const [index, result] of [first, second].entries()) {
    const hex = createHash('sha256')
      .update(turnIdentityText(result.runId, result.commandId))
      .digest('hex');
    expect(turns[index * 2].id).toBe(projectedTurnIds(hex).user);
    expect(turns[index * 2 + 1].id).toBe(projectedTurnIds(hex).assistant);
    // What the browser computes, through Web Crypto rather than node's hash.
    expect(await answerTurnId(result.runId, result.commandId)).toBe(turns[index * 2 + 1].id);
  }
  expect(turns[1].id).not.toBe(turns[3].id);

  // The outcome read names the same run and command, and carries no words to match on.
  const read = await api<MessageResult>(`${messages}/turn-id-2`);
  expect(read.answerText).toBeNull();
  expect(await answerTurnId(read.runId, read.commandId)).toBe(turns[3].id);
});

test('a browser that cannot hash finds no answer, so it shows no outcome', async () => {
  vi.stubGlobal('crypto', {});
  try {
    expect(await answerTurnId('run', 'command')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
